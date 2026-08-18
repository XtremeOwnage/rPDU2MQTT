namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Whether the broker connection is up, and where it points.
///
/// <para>
/// The MQTT integration needs to answer "are we connected?" for its health card, and was reaching straight
/// for the HiveMQ client to do it — a concrete third-party client sitting in an integration, which is
/// exactly the coupling these contracts exist to prevent. An integration should not be able to tell which
/// MQTT library this build uses, any more than it can tell how the host coordinates ownership.
/// </para>
/// </summary>
public interface IBrokerConnection
{
    /// <summary>Is the client currently connected?</summary>
    bool Connected { get; }

    /// <summary>Where it points, for the card's detail line — "broker.local:1883".</summary>
    string Endpoint { get; }
}
