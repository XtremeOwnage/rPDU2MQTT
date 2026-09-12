using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.Config;
using System.Globalization;

namespace rPDU2MQTT.Helpers;

/// <summary>A single numeric measurement, flattened for export to Prometheus / EmonCMS / etc.</summary>
/// <param name="SourceName">The source's formatted display name (vs <paramref name="Source"/>'s object-id form).</param>
/// <param name="Number">The 1-based outlet number, or null for non-outlet entities (circuits/phase/total).</param>
/// <param name="DeviceName">The device's display name (vs <paramref name="Device"/>'s object-id form) (#206).</param>
/// <param name="NodeId">
/// Which flow node this reading belongs to (<c>pdu:rack_1</c>, <c>outlet:rack_1:3</c>). Stamped where the
/// device and outlet key are both in hand, so nothing downstream has to rebuild it from Device + Number and
/// remember which of the two is 0-based.
/// </param>
/// <param name="InstanceId">
/// Which configured PDU instance this was read from. Carried on the reading itself so a flattened list is
/// still complete: an export that merges every instance's snapshot would otherwise lose the one thing the
/// Prometheus <c>instance</c> label is built from.
/// </param>
public readonly record struct MeasurementReading(string Device, string Source, string Type, double Value, string Units, string Identifier, string Topic, string SourceName, int? Number, string DeviceName = "", string InstanceId = "", string NodeId = "");

public static class MetricsHelper
{
    /// <summary>
    /// Flatten all numeric outlet and entity measurements from a poll into export-friendly readings.
    /// Non-numeric values are skipped.
    /// </summary>
    public static IEnumerable<MeasurementReading> EnumerateReadings(PduData data) => EnumerateReadings(data, "");

    /// <summary>As above, stamping each reading with the instance it was polled from.</summary>
    public static IEnumerable<MeasurementReading> EnumerateReadings(PduData data, string instanceId)
    {
        foreach (var device in data.Devices)
        {
            foreach (var outlet in device.Outlets)
                foreach (var reading in ToReadings(device.Entity_Name, device.Entity_DisplayName, outlet.Entity_Name, outlet.Entity_DisplayName, outlet.Key + 1, outlet.Measurements, instanceId,
                                                   Core.Flow.FlowNodeId.ForOutlet(device.Entity_Name, outlet.Key)))
                    yield return reading;

            // A device-level entity (phase, circuit, the unit total) belongs to the PDU tier itself.
            foreach (var entity in device.Entity)
                foreach (var reading in ToReadings(device.Entity_Name, device.Entity_DisplayName, entity.Entity_Name, entity.Entity_DisplayName, null, entity.Measurements, instanceId,
                                                   Core.Flow.FlowNodeId.ForPdu(device.Entity_Name)))
                    yield return reading;
        }
    }

    private static IEnumerable<MeasurementReading> ToReadings(string device, string deviceName, string source, string sourceName, int? number, IEnumerable<Measurement> measurements, string instanceId = "", string nodeId = "")
    {
        foreach (var m in measurements)
            if (double.TryParse(m.Value, NumberStyles.Any, CultureInfo.InvariantCulture, out var value))
                yield return new MeasurementReading(device, source, m.Type, value, m.Units, m.Entity_Identifier, m.GetTopicPath(), sourceName, number, deviceName, instanceId, nodeId);
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
            "energy_d" => "Energy Daily",
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
    /// The Prometheus metric name an energy-flow tier's series lives under. The exporter writes it and the
    /// history reads it back, so both must call this rather than each filling the template themselves —
    /// they had drifted on the {units} placeholder, which made every history lookup miss.
    /// </summary>
    public static string PrometheusFlowMetricName(string metric, Config config)
        => PrometheusMetricName($"flow_{metric}", "", "", "", config);

    /// <summary>
    /// The EmonCMS input key (and idempotent storage-feed name) for an energy-flow tier. Same rule as
    /// above: the export writes it and <c>EmonCmsFlowHistory</c> looks the feed up by it.
    /// </summary>
    public static string EmonCmsFlowInputName(string nodeId, string label, string kind, string metric, Config config)
    {
        var template = config.EmonCMS.FlowInputNameTemplate;
        if (string.IsNullOrWhiteSpace(template)) template = "{node}_{metric}";

        var effectiveMetric = config.Overrides.Measurements.TryGetValue(metric, out var ov) && !string.IsNullOrWhiteSpace(ov?.ID)
            ? ov!.ID!
            : metric;

        var t = EmonCmsTypeConfig(metric, config);
        string Expand(string? s) => (s ?? string.Empty)
            .Replace("{node}", nodeId)
            .Replace("{label}", label)
            .Replace("{kind}", kind)
            .Replace("{metric}", effectiveMetric)
            .Replace("{type}", effectiveMetric)
            .Replace("{units}", t.Units);

        // The type carries its own suffix, so a template still naming the metric would say it twice.
        var body = Expand(WithoutTypePlaceholder(WithoutTypePlaceholder(template, "{metric}"), "{type}"));
        return Sanitize(Expand(t.Prefix) + body + Expand(t.Suffix));
    }

    /// <summary>The friendly (display-name) EmonCMS feed name for a flow tier's virtual feed.</summary>
    public static string EmonCmsFlowFeedName(string label, string metric, Config config)
        => $"{label} {FriendlyTypeName(metric)}".Trim();

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
    public static string EmonCmsFeedName(MeasurementReading r, string template, Config config, bool trim = true)
    {
        var effectiveType = config.Overrides.Measurements.TryGetValue(r.Type, out var ov) && !string.IsNullOrWhiteSpace(ov?.ID)
            ? ov!.ID!
            : r.Type;

        var built = (string.IsNullOrWhiteSpace(template) ? "{name} {type}" : template)
            .Replace("{type}", effectiveType)
            .Replace("{device}", r.Device)
            .Replace("{source}", r.Source)
            .Replace("{outlet}", r.Source)
            .Replace("{name}", r.SourceName ?? r.Source)
            .Replace("{number}", r.Number?.ToString() ?? string.Empty)
            .Replace("{units}", r.Units);
        return trim ? built.Trim() : built;
    }

    /// <summary>The settings for a measurement type, or that type's shipped defaults when it is not listed.</summary>
    public static EmonCmsFeedTypeConfig EmonCmsTypeConfig(string type, Config config)
        => config.EmonCMS.Feeds.Types.FirstOrDefault(t => string.Equals(t.Type, type, StringComparison.OrdinalIgnoreCase))
           ?? EmonCmsFeedTypeConfig.For(type);

    /// <summary>Drop a placeholder the type's suffix now carries, with whatever separator sat in front of it.</summary>
    internal static string WithoutTypePlaceholder(string? template, string placeholder)
        => System.Text.RegularExpressions.Regex.Replace(template ?? string.Empty,
            @"[_\-\s.]*" + System.Text.RegularExpressions.Regex.Escape(placeholder), string.Empty);

    /// <summary>The storage-feed name: the type's prefix, the stable template, then the type's suffix.</summary>
    public static string EmonCmsStorageFeedName(MeasurementReading r, Config config)
    {
        var t = EmonCmsTypeConfig(r.Type, config);
        var body = EmonCmsFeedName(r, WithoutTypePlaceholder(config.EmonCMS.Feeds.StorageNameTemplate, "{type}"), config);
        // Not trimmed individually: a suffix of " {type}" means the space, and the whole name is trimmed below.
        var prefix = string.IsNullOrEmpty(t.Prefix) ? string.Empty : EmonCmsFeedName(r, t.Prefix, config, trim: false);
        var suffix = string.IsNullOrEmpty(t.Suffix) ? string.Empty : EmonCmsFeedName(r, t.Suffix, config, trim: false);
        return (prefix + body + suffix).Trim();
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
