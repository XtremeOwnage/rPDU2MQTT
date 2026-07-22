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
    /// <summary>
    /// Don't carry one — exactly what this project did before #205, and the default.
    /// <para>
    /// It defaults here because the other two modes change what goes on the wire, and that can't be
    /// verified except against your own broker: <see cref="UserProperty"/> shipped as the default once and
    /// broke publishing outright on a real deployment. Turn one on deliberately, and watch the first poll.
    /// </para>
    /// </summary>
    None,

    /// <summary>
    /// An MQTT v5 <c>timestamp</c> user property on every published message. The payload is untouched, so
    /// consumers that don't look for it read exactly what they read before.
    /// <para>
    /// <b>Verify this against your broker before relying on it.</b> The payload being unchanged does not
    /// mean the packet is: a broker or client that mishandles user properties on PUBLISH can drop the
    /// connection, which looks like everything stopping at once. Known to break at least one setup.
    /// </para>
    /// </summary>
    UserProperty,

    /// <summary>
    /// The measurement payload becomes <c>{"value": …, "timestamp": …}</c>. Visible to any consumer, at the
    /// cost of no longer being a bare number: Home Assistant discovery is adjusted to match automatically,
    /// but anything reading these topics by hand needs updating, which is why it isn't the default.
    /// </summary>
    Payload,
}
