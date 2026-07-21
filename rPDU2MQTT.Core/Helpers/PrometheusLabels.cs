using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Helpers;

/// <summary>
/// Resolves the configurable Prometheus label set (#188). Prometheus requires a consistent label set per
/// metric, so the names come from <c>Prometheus.Labels</c> and every reading supplies a value for each
/// (empty when it doesn't apply, e.g. an outlet number on a device-level entity).
/// </summary>
public static class PrometheusLabels
{
    /// <summary>Label names supported by <c>Prometheus.Labels</c>.</summary>
    public static readonly string[] Supported = ["device", "device_name", "source", "name", "number", "type", "type_name", "units", "instance", "hierarchy"];

    /// <summary>The configured label names, filtered to the supported set (falls back to the defaults).</summary>
    public static string[] Names(Config config)
    {
        var names = (config.Prometheus.Labels ?? new())
            .Where(n => !string.IsNullOrWhiteSpace(n))
            .Select(n => n.Trim().ToLowerInvariant())
            .Where(n => Supported.Contains(n))
            .Distinct()
            .ToArray();
        return names.Length > 0 ? names : ["device", "source", "units"];
    }

    /// <summary>
    /// The label values for a reading, in the same order as <see cref="Names"/>.
    /// <paramref name="instance"/> is the PDU instance key; <paramref name="hierarchy"/> the energy-flow
    /// tier feeding this reading (both may be empty when unknown/not configured).
    /// </summary>
    public static string[] Values(string[] names, MeasurementReading r, Config config, string instance, string hierarchy)
    {
        var effectiveType = config.Overrides.Measurements.TryGetValue(r.Type, out var ov) && !string.IsNullOrWhiteSpace(ov?.ID)
            ? ov!.ID!
            : r.Type;

        var values = new string[names.Length];
        for (var i = 0; i < names.Length; i++)
            values[i] = names[i] switch
            {
                "device" => r.Device,
                // The friendly forms (#206): what the PDU/outlet is *called*, so a dashboard doesn't have to
                // decode object-ids. Falls back to the id form when a device has no display name.
                "device_name" => string.IsNullOrWhiteSpace(r.DeviceName) ? r.Device : r.DeviceName,
                "source" => r.Source,
                "name" => r.SourceName ?? r.Source,
                "number" => r.Number?.ToString() ?? string.Empty,
                "type" => effectiveType,
                "type_name" => MetricsHelper.FriendlyTypeName(effectiveType),
                "units" => r.Units,
                "instance" => instance,
                "hierarchy" => hierarchy,
                _ => string.Empty,
            };
        return values;
    }
}
