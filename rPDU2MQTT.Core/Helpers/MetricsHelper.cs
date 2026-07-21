using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.PDU;
using System.Globalization;

namespace rPDU2MQTT.Helpers;

/// <summary>A single numeric measurement, flattened for export to Prometheus / EmonCMS / etc.</summary>
/// <param name="SourceName">The source's formatted display name (vs <paramref name="Source"/>'s object-id form).</param>
/// <param name="Number">The 1-based outlet number, or null for non-outlet entities (circuits/phase/total).</param>
/// <param name="DeviceName">The device's display name (vs <paramref name="Device"/>'s object-id form) (#206).</param>
public readonly record struct MeasurementReading(string Device, string Source, string Type, double Value, string Units, string Identifier, string Topic, string SourceName, int? Number, string DeviceName = "");

public static class MetricsHelper
{
    /// <summary>
    /// Flatten all numeric outlet and entity measurements from a poll into export-friendly readings.
    /// Non-numeric values are skipped.
    /// </summary>
    public static IEnumerable<MeasurementReading> EnumerateReadings(PduData data)
    {
        foreach (var device in data.Devices)
        {
            foreach (var outlet in device.Outlets)
                foreach (var reading in ToReadings(device.Entity_Name, device.Entity_DisplayName, outlet.Entity_Name, outlet.Entity_DisplayName, outlet.Key + 1, outlet.Measurements))
                    yield return reading;

            foreach (var entity in device.Entity)
                foreach (var reading in ToReadings(device.Entity_Name, device.Entity_DisplayName, entity.Entity_Name, entity.Entity_DisplayName, null, entity.Measurements))
                    yield return reading;
        }
    }

    private static IEnumerable<MeasurementReading> ToReadings(string device, string deviceName, string source, string sourceName, int? number, IEnumerable<Measurement> measurements)
    {
        foreach (var m in measurements)
            if (double.TryParse(m.Value, NumberStyles.Any, CultureInfo.InvariantCulture, out var value))
                yield return new MeasurementReading(device, source, m.Type, value, m.Units, m.Entity_Identifier, m.GetTopicPath(), sourceName, number, deviceName);
    }

    /// <summary>
    /// A measurement type as a human would say it — "Real Power" for <c>realpower</c> (#206). Used for the
    /// Prometheus gauge's HELP text and the optional <c>type_name</c> label, so a series is readable without
    /// knowing this project's vocabulary. Unknown types are title-cased rather than dropped.
    /// </summary>
    public static string FriendlyTypeName(string? type)
    {
        var t = (type ?? "").Trim();
        if (t.Length == 0) return "";

        return t.ToLowerInvariant() switch
        {
            "realpower" => "Real Power",
            "apparentpower" => "Apparent Power",
            "powerfactor" => "Power Factor",
            "energy" => "Energy",
            "current" => "Current",
            "voltage" => "Voltage",
            "frequency" => "Frequency",
            "temperature" => "Temperature",
            "humidity" => "Humidity",
            "accumulatedco2" => "Accumulated CO2",
            "instantaneousco2" => "Instantaneous CO2",
            "currentcrestfactor" => "Current Crest Factor",
            "balance" => "Balance",
            _ => char.ToUpperInvariant(t[0]) + t[1..],
        };
    }

    /// <summary>
    /// The Prometheus gauge name for a reading, applying the configured name template. Supported
    /// placeholders: <c>{type}</c> (measurement type, honoring its Overrides.Measurements ID),
    /// <c>{device}</c>, <c>{source}</c> / <c>{outlet}</c>, and <c>{units}</c>. The result is
    /// lower-cased with non-alphanumeric characters replaced by underscores.
    /// </summary>
    public static string PrometheusMetricName(string type, string device, string source, string units, Config config)
    {
        var effectiveType = config.Overrides.Measurements.TryGetValue(type, out var ov) && !string.IsNullOrWhiteSpace(ov?.ID)
            ? ov!.ID!
            : type;

        var template = string.IsNullOrWhiteSpace(config.Prometheus.MetricNameTemplate)
            ? "rpdu2mqtt_{type}"
            : config.Prometheus.MetricNameTemplate;

        var name = template
            .Replace("{type}", effectiveType)
            .Replace("{device}", device)
            .Replace("{source}", source)
            .Replace("{outlet}", source)
            .Replace("{units}", units);

        return Sanitize(name);
    }

    /// <summary>Overload for a flattened reading.</summary>
    public static string PrometheusMetricName(MeasurementReading r, Config config)
        => PrometheusMetricName(r.Type, r.Device, r.Source, r.Units, config);

    /// <summary>
    /// The EmonCMS input key for a reading, applying <c>EmonCMS.InputNameTemplate</c>. Placeholders:
    /// <c>{type}</c> (honoring its Overrides.Measurements ID), <c>{device}</c>, <c>{source}</c> /
    /// <c>{outlet}</c>, <c>{units}</c>. A blank template falls back to the full raw identifier.
    /// </summary>
    public static string EmonCmsInputName(MeasurementReading r, Config config)
    {
        var template = config.EmonCMS.InputNameTemplate;
        if (string.IsNullOrWhiteSpace(template))
            return r.Identifier;

        var effectiveType = config.Overrides.Measurements.TryGetValue(r.Type, out var ov) && !string.IsNullOrWhiteSpace(ov?.ID)
            ? ov!.ID!
            : r.Type;

        var name = template
            .Replace("{type}", effectiveType)
            .Replace("{device}", r.Device)
            .Replace("{source}", r.Source)
            .Replace("{outlet}", r.Source)
            .Replace("{name}", r.SourceName ?? r.Source)
            .Replace("{number}", r.Number?.ToString() ?? string.Empty)
            .Replace("{units}", r.Units);

        return Sanitize(name);
    }

    /// <summary>
    /// Fill an EmonCMS feed-name template for a reading (#163). Keeps a human-friendly form (spaces allowed);
    /// <c>{type}</c> honours the measurement's Overrides.Measurements ID.
    /// </summary>
    public static string EmonCmsFeedName(MeasurementReading r, string template, Config config)
    {
        var effectiveType = config.Overrides.Measurements.TryGetValue(r.Type, out var ov) && !string.IsNullOrWhiteSpace(ov?.ID)
            ? ov!.ID!
            : r.Type;

        return (string.IsNullOrWhiteSpace(template) ? "{name} {type}" : template)
            .Replace("{type}", effectiveType)
            .Replace("{device}", r.Device)
            .Replace("{source}", r.Source)
            .Replace("{outlet}", r.Source)
            .Replace("{name}", r.SourceName ?? r.Source)
            .Replace("{number}", r.Number?.ToString() ?? string.Empty)
            .Replace("{units}", r.Units)
            .Trim();
    }

    /// <summary>The idempotent storage-feed name (from a stable id template — no display name), or the friendly
    /// name when idempotent naming is off.</summary>
    public static string EmonCmsStorageFeedName(MeasurementReading r, Config config)
    {
        var f = config.EmonCMS.Feeds;
        return f.IdempotentNames
            ? EmonCmsFeedName(r, f.StorageNameTemplate, config)
            : EmonCmsFeedName(r, f.Virtual.NameTemplate, config);
    }

    /// <summary>The friendly (display-name based) feed name used for virtual feeds.</summary>
    public static string EmonCmsVirtualFeedName(MeasurementReading r, Config config)
        => EmonCmsFeedName(r, config.EmonCMS.Feeds.Virtual.NameTemplate, config);

    /// <summary>True when the EmonCMS MQTT topic template splits the export per PDU (it contains {device}).</summary>
    public static bool EmonCmsSplitsByDevice(Config config)
        => (config.EmonCMS.MqttTopicTemplate ?? string.Empty).Contains("{device}", StringComparison.OrdinalIgnoreCase);

    /// <summary>The EmonCMS MQTT topic a payload is published to, with {base}/{node}/{device} filled in.</summary>
    public static string EmonCmsMqttTopic(string device, Config config)
    {
        var c = config.EmonCMS;
        var template = string.IsNullOrWhiteSpace(c.MqttTopicTemplate) ? "{base}/{node}" : c.MqttTopicTemplate;
        var topic = template
            .Replace("{base}", (c.MqttBaseTopic ?? "emon").Trim('/'))
            .Replace("{node}", c.Node)
            .Replace("{device}", device);
        // Collapse any empty/duplicate slashes (e.g. a {device} that resolved to empty).
        return string.Join('/', topic.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    }

    private static string Sanitize(string value)
        => new(value.Select(c => char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : '_').ToArray());
}
