using System.Globalization;
using System.Text.Json;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// What a topic's last payload tells us about the binding it could feed: which metric it looks like, the unit
/// it's published in, the number itself, and — for a JSON payload — the fields you could bind to.
/// </summary>
/// <param name="Metric">Best guess at the metric (canonical name), or null when nothing suggests one.</param>
/// <param name="Unit">The unit the payload is expressed in, when it says (e.g. "kW" from "3.4 kW").</param>
/// <param name="Value">The number, when the payload is a bare reading.</param>
/// <param name="IsJson">The payload is a JSON object — <paramref name="Fields"/> lists what's bindable.</param>
/// <param name="Fields">Dotted paths to the numeric fields inside a JSON payload.</param>
public sealed record TopicHint(
    string? Metric,
    string? Unit,
    double? Value,
    bool IsJson,
    IReadOnlyList<string> Fields);

/// <summary>
/// Reads a sampled MQTT payload and suggests how to bind it (#autocomplete). Pure and broker-free: the topic
/// index supplies the samples, this decides what they mean, so the guessing is testable on its own and the
/// editor doesn't have to re-implement it in the browser.
/// </summary>
public static class TopicSampleAnalyzer
{
    private const int MaxJsonFields = 60;

    /// <summary>Unit → metric. A unit is the strongest signal there is: "kWh" can only be energy.</summary>
    private static readonly (string Unit, string Metric)[] UnitMetrics =
    {
        ("kwh", "energy"), ("mwh", "energy"), ("wh", "energy"),
        ("kva", "apparentpower"), ("va", "apparentpower"),
        ("kw", "realpower"), ("mw", "realpower"), ("w", "realpower"),
        ("ma", "current"), ("a", "current"),
        ("mv", "voltage"), ("kv", "voltage"), ("v", "voltage"),
        ("hz", "frequency"),
    };

    /// <summary>Topic keyword → metric, checked in order so "apparent power" beats "power".</summary>
    private static readonly (string Word, string Metric)[] TopicMetrics =
    {
        ("apparent", "apparentpower"), ("va", "apparentpower"),
        ("powerfactor", "powerfactor"), ("power_factor", "powerfactor"), ("pf", "powerfactor"),
        ("energy", "energy"), ("kwh", "energy"), ("consumption", "energy"), ("total", "energy"),
        ("frequency", "frequency"), ("freq", "frequency"), ("hz", "frequency"),
        ("voltage", "voltage"), ("volt", "voltage"),
        ("current", "current"), ("amp", "current"),
        ("power", "realpower"), ("watt", "realpower"), ("load", "realpower"),
    };

    public static TopicHint Analyze(string topic, string? payload)
    {
        var text = (payload ?? "").Trim();

        if (text.StartsWith('{'))
        {
            var fields = JsonFields(text);
            // A JSON payload's field names carry the meaning far better than the topic does, but we can't
            // know which field the user wants — so suggest a metric only from the topic here.
            return new TopicHint(MetricFromTopic(topic), null, null, true, fields);
        }

        var (value, unit) = SplitValueAndUnit(text);
        var metric = MetricFromUnit(unit) ?? MetricFromTopic(topic);

        // Only report a unit the flow can actually convert for that metric; a stray suffix is noise.
        var known = metric is not null && unit is not null
            && FlowUnits.UnitsFor(metric).Any(u => string.Equals(u, unit, StringComparison.OrdinalIgnoreCase));

        return new TopicHint(metric, known ? Canonicalize(metric!, unit!) : null, value, false, Array.Empty<string>());
    }

    /// <summary>
    /// Suggest the metric for one field of a JSON payload. The leaf name decides first — in
    /// <c>ENERGY.Voltage</c> the field is a voltage, and only the container it sits in says "energy" — then
    /// the rest of the path, then the topic.
    /// </summary>
    public static string? MetricForField(string topic, string field)
    {
        var path = field ?? "";
        var leaf = path.Split('.').LastOrDefault() ?? "";
        return MetricFromTopic(leaf) ?? MetricFromTopic(path) ?? MetricFromTopic(topic);
    }

    /// <summary>Split "3.4 kW" / "3.4kW" / "3.4" into its number and unit.</summary>
    private static (double? Value, string? Unit) SplitValueAndUnit(string text)
    {
        if (text.Length == 0) return (null, null);

        var end = 0;
        while (end < text.Length && (char.IsDigit(text[end]) || text[end] is '-' or '+' or '.' or ',')) end++;
        if (end == 0) return (null, null);

        var number = text[..end].Replace(",", "");
        if (!double.TryParse(number, NumberStyles.Any, CultureInfo.InvariantCulture, out var value)) return (null, null);

        var unit = text[end..].Trim();
        return (value, unit.Length is > 0 and <= 4 ? unit : null);
    }

    private static string? MetricFromUnit(string? unit)
    {
        if (string.IsNullOrWhiteSpace(unit)) return null;
        var u = unit.Trim().ToLowerInvariant();
        foreach (var (candidate, metric) in UnitMetrics)
            if (u == candidate) return metric;
        return null;
    }

    private static string? MetricFromTopic(string topic)
    {
        var t = (topic ?? "").ToLowerInvariant();
        foreach (var (word, metric) in TopicMetrics)
            if (t.Contains(word, StringComparison.Ordinal)) return metric;
        return null;
    }

    /// <summary>Return the unit spelled the way the metric's vocabulary spells it ("kwh" → "kWh").</summary>
    private static string Canonicalize(string metric, string unit)
        => FlowUnits.UnitsFor(metric).FirstOrDefault(u => string.Equals(u, unit, StringComparison.OrdinalIgnoreCase)) ?? unit;

    /// <summary>Every numeric leaf in a JSON object, as a dotted path — the bindable fields.</summary>
    private static IReadOnlyList<string> JsonFields(string json)
    {
        var fields = new List<string>();
        try
        {
            using var doc = JsonDocument.Parse(json);
            Walk(doc.RootElement, "", fields);
        }
        catch (JsonException) { /* not valid JSON after all — no fields to offer */ }
        return fields;
    }

    private static void Walk(JsonElement element, string prefix, List<string> fields)
    {
        if (fields.Count >= MaxJsonFields || element.ValueKind != JsonValueKind.Object) return;

        foreach (var property in element.EnumerateObject())
        {
            if (fields.Count >= MaxJsonFields) return;
            var path = prefix.Length == 0 ? property.Name : $"{prefix}.{property.Name}";
            switch (property.Value.ValueKind)
            {
                case JsonValueKind.Object:
                    Walk(property.Value, path, fields);
                    break;
                case JsonValueKind.Number:
                    fields.Add(path);
                    break;
                case JsonValueKind.String:
                    // "1234" and "3.4 kW" are numbers as far as the ingest is concerned.
                    if (SplitValueAndUnit(property.Value.GetString() ?? "").Value is not null) fields.Add(path);
                    break;
            }
        }
    }
}
