using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>One live PDU instance: reads, writes, and pending-write overlays.</summary>
public interface IPduInstance
{
    Task<PduData> ReadAsync(CancellationToken ct);
    void InvalidateCache();

    Task SetOutletStateAsync(string deviceId, int outletIndex, bool on, CancellationToken ct);
    Task ControlOutletAsync(string deviceId, int outletIndex, string action, CancellationToken ct);
    Task ResetOutletStatsAsync(string deviceId, int outletIndex, CancellationToken ct);
    Task<int> ControlGroupAsync(string groupKey, string action, CancellationToken ct);

    Task SetOutletConfigAsync(string deviceId, int outletIndex, IReadOnlyDictionary<string, object> fields, CancellationToken ct);
    Task SetDeviceConfigAsync(string deviceId, IReadOnlyDictionary<string, object> fields, CancellationToken ct);
    Task SetEntityConfigAsync(string deviceId, string entityKey, IReadOnlyDictionary<string, object> fields, CancellationToken ct);
    Task SetGroupConfigAsync(string groupKey, IReadOnlyDictionary<string, object> fields, CancellationToken ct);

    string ResolveOutletState(string deviceId, int outletIndex, string actualState);
    string ResolveOutletConfig(string deviceId, int outletIndex, string field, string actual);
    string ResolveDeviceConfig(string deviceId, string field, string actual);
    string ResolveEntityConfig(string deviceId, string entityKey, string field, string actual);
    string ResolveGroupConfig(string groupKey, string field, string actual);
}

/// <summary>The configured PDU instances.</summary>
public interface IPduInstances
{
    string? PrimaryId { get; }
    IPduInstance? Primary { get; }
    IReadOnlyDictionary<string, IPduInstance> All { get; }

    /// <summary>The instance, else the primary, else null.</summary>
    IPduInstance? Get(string instanceId);

    /// <summary>Apply changes to <see cref="Config.Pdus"/> without a restart.</summary>
    Task ReconcileAsync();

    /// <summary>A detached instance for <paramref name="cfg"/>'s primary PDU, or null when it has no host.</summary>
    IPduInstance? Preview(Config cfg);
}

/// <summary>An integration that supplies PDU instances. The host attaches it once at startup.</summary>
public interface IPduInstanceProvider
{
    PduAttachment Attach(Config cfg, ISnapshotCache snapshots);
}

/// <summary>The instances, and the reader that polls them.</summary>
public sealed record PduAttachment(IPduInstances Instances, IDeviceReader? Reader);

/// <summary>Used when no PDU plugin is loaded.</summary>
public sealed class NoPduInstances : IPduInstances
{
    public string? PrimaryId => null;
    public IPduInstance? Primary => null;
    public IReadOnlyDictionary<string, IPduInstance> All { get; } = new Dictionary<string, IPduInstance>();
    public IPduInstance? Get(string instanceId) => null;
    public Task ReconcileAsync() => Task.CompletedTask;
    public IPduInstance? Preview(Config cfg) => null;
}
