namespace rPDU2MQTT.Plugin.Locations;

/// <summary>Temperature and humidity per place.</summary>
public static class LocationClimate
{
    public const string TemperatureMetric = "temperature";
    public const string HumidityMetric = "percent";

    public static readonly TierSensor[] Sensors =
    [
        new("temperature", "Temperature", "temperature", "°C"),
        new("humidity", "Humidity", "humidity", "%"),
    ];

    /// <summary>Known readings only; null when none.</summary>
    public static double? Combine(IEnumerable<double?> values, string? how)
    {
        var known = values.Where(v => v is not null).Select(v => v!.Value).ToList();
        if (known.Count == 0) return null;
        return (how ?? "").ToLowerInvariant() switch
        {
            ClimateCombine.First => known[0],
            ClimateCombine.Min => known.Min(),
            ClimateCombine.Max => known.Max(),
            _ => Math.Round(known.Average(), 2),
        };
    }

    public static ClimateConfig? Of(LocationEntry e) => e.Room?.Climate ?? e.Area?.Climate;

    /// <summary>The sensor ids a place reads: its own, or for an area with none, its rooms'.</summary>
    public static IReadOnlyList<string> SensorIds(LocationIndex index, LocationEntry e, Func<ClimateConfig, List<string>> pick)
    {
        if (Of(e) is not { } own) return [];
        var ids = pick(own) ?? new();
        if (ids.Count > 0 || e.Kind != LocationKind.Area) return ids;
        return [.. index.RoomsIn(e.Id).SelectMany(r => Of(r) is { } c ? pick(c) ?? new() : new()).Distinct(StringComparer.OrdinalIgnoreCase)];
    }

    public static bool Configured(LocationIndex index, LocationEntry e) =>
        SensorIds(index, e, c => c.Temperature).Count > 0 || SensorIds(index, e, c => c.Humidity).Count > 0;

    public static (double? Temperature, double? Humidity) Read(LocationIndex index, LocationEntry e, Func<string, double?> temperature, Func<string, double?> humidity)
    {
        var how = Of(e)?.Combine;
        return (Combine(SensorIds(index, e, c => c.Temperature).Select(temperature), how),
                Combine(SensorIds(index, e, c => c.Humidity).Select(humidity), how));
    }
}
