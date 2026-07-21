namespace rPDU2MQTT.Grains.Abstractions.Status;

/// <summary>
/// One hop on the Status board as an actor (key = component id). A process that can see the component pushes
/// raw facts via <see cref="Report"/>; the grain owns the <i>rule</i> — what those facts mean, how they read,
/// and when silence becomes a problem — and publishes the resulting card to the <see cref="IStatusBoardGrain"/>.
/// <para>
/// The point is one verdict per component, cluster-wide. The board used to be assembled per request from
/// whichever process happened to serve the HTTP call, so with more than one replica you saw that replica's
/// private view. A component now has exactly one grain, so it has exactly one status.
/// </para>
/// </summary>
public interface IComponentStatusGrain : IGrainWithStringKey
{
    /// <summary>Report what this process can see of the component. Cheap, idempotent, called on a timer.</summary>
    Task Report(ComponentReport report);

    /// <summary>This component's status right now (evaluated at call time, so ages are never stale).</summary>
    Task<ComponentStatus> Current();
}

/// <summary>The MQTT broker connection (key <c>mqtt</c>).</summary>
public interface IMqttStatusGrain : IComponentStatusGrain { }

/// <summary>One PDU instance's polling health (key <c>pdu:{instance}</c>).</summary>
public interface IPduStatusGrain : IComponentStatusGrain { }

/// <summary>The EmonCMS export (key <c>emoncms</c>).</summary>
public interface IEmonCmsStatusGrain : IComponentStatusGrain { }

/// <summary>Home Assistant MQTT discovery (key <c>homeassistant</c>).</summary>
public interface IHomeAssistantStatusGrain : IComponentStatusGrain { }

/// <summary>The Prometheus exporter (key <c>prometheus</c>).</summary>
public interface IPrometheusStatusGrain : IComponentStatusGrain { }

/// <summary>One process in the fleet (key <c>node:{processId}</c>) — its roles, version and uptime.</summary>
public interface INodeStatusGrain : IComponentStatusGrain { }
