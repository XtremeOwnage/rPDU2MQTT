namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Publishing a message to the broker, for the integrations that need one.
///
/// <para>
/// Several destinations speak MQTT without <i>being</i> the MQTT integration: EmonCMS has an MQTT transport
/// as an alternative to its HTTP API, and Home Assistant discovery is published entirely as retained broker
/// messages. Before this, that capability came from inheriting <c>baseMQTTService</c>, which also brought
/// the poll timer, the leader gate and the snapshot cache — so "I need to publish a message" meant adopting
/// a whole hosting model, and the hosting model is exactly what the plugin contracts took over.
/// </para>
/// <para>
/// Deliberately not the broker client itself. An integration should not be choosing QoS, handling reconnects
/// or deciding what a publish timeout means; the implementation owns all of that, along with the
/// message-timestamp property and the global "actually publish" debug switch.
/// </para>
/// </summary>
public interface IMessagePublisher
{
    /// <summary>
    /// Publish <paramref name="payload"/> to <paramref name="topic"/>.
    /// </summary>
    /// <param name="retain">
    /// Whether the broker should keep this as the topic's last known value. True for anything describing
    /// what exists (discovery documents, availability); false for a reading, which is only true when sent.
    /// </param>
    /// <param name="timestampUtc">
    /// When the data was read, as opposed to when it is being published — carried as a user property so a
    /// stale republish is distinguishable from a fresh reading. Null means "no better answer than now".
    /// </param>
    Task PublishAsync(string topic, string payload, bool retain, CancellationToken ct, DateTime? timestampUtc = null);
}
