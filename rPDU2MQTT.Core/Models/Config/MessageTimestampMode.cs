namespace rPDU2MQTT.Models.Config;

/// <summary>
/// How a published measurement carries the moment it was read (#205).
/// <para>
/// The timestamp is the <b>PDU's poll time</b>, not the moment we happened to publish — that's the number
/// worth having, because it's what tells a consumer whether a reading is current or a republished stale one.
/// </para>
/// </summary>
public enum MessageTimestampMode
{
    /// <summary>Don't carry one. Exactly what this project did before #205.</summary>
    None,

    /// <summary>
    /// An MQTT v5 <c>timestamp</c> user property on every published message. The payload is untouched, so
    /// every existing consumer — Home Assistant included — keeps working unchanged, and anything that cares
    /// can read the property. This is the default.
    /// </summary>
    UserProperty,

    /// <summary>
    /// The measurement payload becomes <c>{"value": …, "timestamp": …}</c>. Visible to any consumer, at the
    /// cost of no longer being a bare number: Home Assistant discovery is adjusted to match automatically,
    /// but anything reading these topics by hand needs updating, which is why it isn't the default.
    /// </summary>
    Payload,
}
