using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>Host services a plugin may use. Only <see cref="Config"/> is available before the host starts.</summary>
public interface IPluginHost
{
    /// <summary>The live configuration.</summary>
    Config Config { get; }

    ISnapshotCache Snapshots { get; }

    /// <summary>Every flow value source combined, or null when there is none.</summary>
    IFlowValueSource? LiveValues { get; }

    IMessagePublisher? Publisher { get; }

    /// <summary>Per-integration export outcomes, keyed by integration id.</summary>
    IntegrationStatus Status { get; }

    IPeriodAuditor? Auditor { get; }

    /// <summary>Stored history, or null when history is off.</summary>
    IMeasurementHistory? History => null;
}

/// <summary>An integration the host hands its services to before first use.</summary>
public interface IPluginHostUser
{
    void UseHost(IPluginHost host);
}
