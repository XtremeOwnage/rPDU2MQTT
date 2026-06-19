using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.PDU;
using System.Globalization;

namespace rPDU2MQTT.Helpers;

/// <summary>A single numeric measurement, flattened for export to Prometheus / EmonCMS / etc.</summary>
public readonly record struct MeasurementReading(string Device, string Source, string Type, double Value, string Units, string Identifier, string Topic);

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
                foreach (var reading in ToReadings(device.Entity_Name, outlet.Entity_Name, outlet.Measurements))
                    yield return reading;

            foreach (var entity in device.Entity)
                foreach (var reading in ToReadings(device.Entity_Name, entity.Entity_Name, entity.Measurements))
                    yield return reading;
        }
    }

    private static IEnumerable<MeasurementReading> ToReadings(string device, string source, IEnumerable<Measurement> measurements)
    {
        foreach (var m in measurements)
            if (double.TryParse(m.Value, NumberStyles.Any, CultureInfo.InvariantCulture, out var value))
                yield return new MeasurementReading(device, source, m.Type, value, m.Units, m.Entity_Identifier, m.GetTopicPath());
    }

    /// <summary>
    /// The Prometheus gauge name for a measurement type, applying the configured name template and
    /// any per-type ID override (e.g. realPower -> rpdu2mqtt_realpower, or rpdu2mqtt_power if
    /// Overrides.Measurements.realPower.ID = "power").
    /// </summary>
    public static string PrometheusMetricName(string type, Config config)
    {
        var effectiveType = config.Overrides.Measurements.TryGetValue(type, out var ov) && !string.IsNullOrWhiteSpace(ov?.ID)
            ? ov!.ID!
            : type;

        var template = string.IsNullOrWhiteSpace(config.Prometheus.MetricNameTemplate)
            ? "rpdu2mqtt_{type}"
            : config.Prometheus.MetricNameTemplate;

        return Sanitize(template.Replace("{type}", effectiveType));
    }

    private static string Sanitize(string value)
        => new(value.Select(c => char.IsLetterOrDigit(c) ? char.ToLowerInvariant(c) : '_').ToArray());
}
