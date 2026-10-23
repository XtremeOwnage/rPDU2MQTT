using System.Globalization;
using System.Text.Json;

namespace rPDU2MQTT.Plugin.IotaWatt;

/// <summary>An input or output as <c>/query?show=series</c> lists it.</summary>
public sealed record IotaWattSeries(string Name, string Unit)
{
    public bool IsVoltage => string.Equals(Unit, "Volts", StringComparison.OrdinalIgnoreCase);
    public bool IsPower => string.Equals(Unit, "Watts", StringComparison.OrdinalIgnoreCase);
}

/// <summary>One column of a select: a series and the unit modifier asked of it (blank for the series' own unit).</summary>
public sealed record IotaWattColumn(string Series, string Modifier)
{
    public string Text => Modifier.Length == 0 ? Series : $"{Series}.{Modifier}";
}

/// <summary>A column's newest non-null value and the start of the group it came from.</summary>
public readonly record struct IotaWattValue(double Value, DateTime? AtUtc);

/// <summary>Request URLs and response parsing for IoTaWatt's query API.</summary>
public static class IotaWattWire
{
    /// <summary>
    /// The modifier that reads <paramref name="metric"/> from <paramref name="series"/>, with the unit it
    /// answers in; null with a reason when the series cannot supply it.
    /// </summary>
    public static (string? Modifier, string Unit, string? Why) ModifierFor(IotaWattSeries series, string metric)
    {
        var m = (metric ?? "").ToLowerInvariant();
        if (series.IsVoltage)
            return m switch
            {
                "voltage" => ("volts", "V", null),
                "frequency" => ("hz", "Hz", null),
                _ => (null, "", $"'{series.Name}' is a voltage input; it can supply voltage or frequency, not {metric}."),
            };
        if (series.IsPower)
            return m switch
            {
                "realpower" => ("watts", "W", null),
                "apparentpower" => ("va", "VA", null),
                "current" => ("amps", "A", null),
                "powerfactor" => ("pf", "", null),
                "energy" => ("wh", "Wh", null),
                _ => (null, "", $"'{series.Name}' is a power series; it can supply realpower, apparentpower, current, powerfactor or energy, not {metric}."),
            };
        // An output in some other unit answers only in that unit.
        return ("", UnitOf(series.Unit), null);
    }

    private static string UnitOf(string unit) => unit.ToLowerInvariant() switch
    {
        "amps" => "A",
        "va" => "VA",
        "hz" => "Hz",
        "pf" => "",
        "wh" => "Wh",
        "kwh" => "kWh",
        _ => unit,
    };

    public static string SeriesUrl(string baseUrl) => $"{baseUrl}/query?show=series";

    /// <summary>The last 30 seconds in 5-second groups; the newest group may not be logged yet.</summary>
    public static string LiveUrl(string baseUrl, IEnumerable<IotaWattColumn> columns)
        => $"{baseUrl}/query?select=[time.utc.unix,{string.Join(",", columns.Select(c => c.Text))}]"
         + "&begin=s-30s&end=s&group=5s&format=json&header=yes&missing=null&limit=20";

    /// <summary>Watt-hours from <paramref name="begin"/> until now, one row.</summary>
    public static string EnergyUrl(string baseUrl, IEnumerable<IotaWattColumn> columns, string begin)
        => $"{baseUrl}/query?select=[{string.Join(",", columns.Select(c => c.Text))}]"
         + $"&begin={Uri.EscapeDataString(begin)}&end=s&group=all&format=json&header=yes&missing=null";

    public static IReadOnlyList<IotaWattSeries> Series(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("series", out var list) || list.ValueKind != JsonValueKind.Array) return [];
        return list.EnumerateArray()
            .Where(s => s.ValueKind == JsonValueKind.Object && s.TryGetProperty("name", out _))
            .Select(s => new IotaWattSeries(
                s.GetProperty("name").GetString() ?? "",
                s.TryGetProperty("unit", out var u) ? u.GetString() ?? "" : ""))
            .Where(s => s.Name.Length > 0)
            .ToList();
    }

    /// <summary>
    /// Each column's newest non-null value. <paramref name="timed"/>: the first column is
    /// <c>time.utc.unix</c> and the rest line up with <paramref name="columns"/> after it.
    /// </summary>
    public static Dictionary<IotaWattColumn, IotaWattValue> Values(string json, IReadOnlyList<IotaWattColumn> columns, bool timed)
    {
        var found = new Dictionary<IotaWattColumn, IotaWattValue>();
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object
            || !doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Array)
            return found;

        var offset = timed ? 1 : 0;
        foreach (var row in data.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Array) continue;
            var cells = row.EnumerateArray().ToArray();
            DateTime? at = timed && cells.Length > 0 && Number(cells[0]) is { } t
                ? DateTime.UnixEpoch.AddSeconds(t) : null;
            for (var i = 0; i < columns.Count && i + offset < cells.Length; i++)
                if (Number(cells[i + offset]) is { } v)
                    found[columns[i]] = new(v, at);   // rows are oldest first, so the last one wins
        }
        return found;
    }

    /// <summary>The <c>error</c> IoTaWatt puts in a 400's body, or the body itself.</summary>
    public static string Error(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("error", out var e))
                return e.ToString();
        }
        catch (JsonException) { }
        return body.Length > 200 ? body[..200] : body;
    }

    private static double? Number(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Number => e.GetDouble(),
        JsonValueKind.String when double.TryParse(e.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => d,
        _ => null,
    };
}
