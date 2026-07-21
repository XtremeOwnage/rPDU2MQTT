using System.Text.Json;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core;

/// <summary>
/// Puts the time a measurement was read onto the message that carries it (#205) — as a user property, or in
/// the payload. Broker-free so the shapes are testable on their own; the publishing services just apply it.
/// </summary>
public static class MessageTimestamps
{
    /// <summary>The MQTT v5 user-property name, and the JSON field name in <see cref="MessageTimestampMode.Payload"/>.</summary>
    public const string PropertyName = "timestamp";

    /// <summary>
    /// ISO-8601, UTC, milliseconds. Sortable, unambiguous, and what every consumer's date parser expects —
    /// including Home Assistant's <c>as_datetime</c>.
    /// </summary>
    public static string Format(DateTime timestampUtc)
        => timestampUtc.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>
    /// The payload for one measurement: the bare value as always, or a small JSON object carrying the value
    /// and when it was read.
    /// </summary>
    public static string Payload(string value, DateTime? timestampUtc, MessageTimestampMode mode)
    {
        if (mode != MessageTimestampMode.Payload) return value;

        // The value stays a string: these come off the PDU as text, and re-typing them here would turn
        // "0.00" into 0 and lose the device's own precision.
        return JsonSerializer.Serialize(new Dictionary<string, string?>
        {
            ["value"] = value,
            [PropertyName] = Format(timestampUtc ?? DateTime.UtcNow),
        });
    }

    /// <summary>
    /// The Home Assistant value template for a measurement sensor, so discovery keeps matching the payload
    /// shape this mode publishes.
    /// </summary>
    public static string ValueTemplate(MessageTimestampMode mode)
        => mode == MessageTimestampMode.Payload ? "{{ value_json.value }}" : "{{ value }}";
}
