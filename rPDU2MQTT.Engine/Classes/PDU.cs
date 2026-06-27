using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using rPDU2MQTT.Models.PDU.OneView;
using System.Diagnostics.CodeAnalysis;

namespace rPDU2MQTT.Classes;

public partial class PDU
{
    private readonly Config config;
    private readonly Models.Config.PduConfig instanceConfig;
    private readonly PduApiHandler api;

    /// <summary>
    /// A flag which determines if we should leverage the ONEView API, instead of the direct API.
    /// </summary>
    /// <remarks>
    /// Detection of ONEView is performed on the first polling interval.
    /// </remarks>
    private bool? useOneView { get; set; } = null;

    public PDU(Models.Config.PduConfig instanceConfig, Config config, PduApiHandler api)
    {
        this.instanceConfig = instanceConfig;
        this.config = config;
        this.api = api;
    }

    // After a control command the PDU can sit in a "pending" state for up to ~a minute while it
    // applies the change, during which it still reports the OLD state. Latch the commanded state
    // so polling doesn't flap Home Assistant back until the PDU actually catches up (or we time out).
    private readonly Dictionary<string, (string expected, DateTime expiresUtc)> pendingOutletStates = new();
    // Same latch idea for writable config fields (outlet delays/power-on, device & circuit labels),
    // keyed by a resource-qualified path (see LatchPending / ResolvePending).
    private readonly Dictionary<string, (string expected, DateTime expiresUtc)> pendingConfig = new();
    private readonly object pendingLock = new();
    private static readonly TimeSpan PendingStateTimeout = TimeSpan.FromSeconds(120);

    /// <summary>
    /// Turn an outlet on or off (only used when PDU.ActionsEnabled is true).
    /// </summary>
    public async Task SetOutletStateAsync(string deviceId, int outletIndex, bool on, CancellationToken cancellationToken)
    {
        await api.SetOutletStateAsync(deviceId, outletIndex, on, cancellationToken);

        lock (pendingLock)
            pendingOutletStates[$"{deviceId}/{outletIndex}"] = (on ? "on" : "off", DateTime.UtcNow.Add(PendingStateTimeout));
    }

    /// <summary>
    /// Issue a control action ("on", "off", "reboot") against an outlet (PDU.ActionsEnabled only).
    /// on/off latch the expected state; reboot is left to the next poll to report.
    /// </summary>
    public async Task ControlOutletAsync(string deviceId, int outletIndex, string action, CancellationToken cancellationToken)
    {
        await api.ControlOutletAsync(deviceId, outletIndex, action, cancellationToken);

        if (action is "on" or "off")
            lock (pendingLock)
                pendingOutletStates[$"{deviceId}/{outletIndex}"] = (action, DateTime.UtcNow.Add(PendingStateTimeout));
    }

    /// <summary>
    /// Apply a control action ("on"/"off"/"reboot") to every outlet in a OneView group. OneView has
    /// no group control endpoint, so members are resolved from the host→group mapping and the existing
    /// per-outlet control is fanned out. Aborts if no members resolve (so a bad mapping can't hit the
    /// wrong outlets). Returns the number of outlets actioned. PDU.ActionsEnabled only.
    /// </summary>
    public async Task<int> ControlGroupAsync(string groupKey, string action, CancellationToken cancellationToken)
    {
        var oneview = await api.GetAsync<OneViewRootData>("/oneview", cancellationToken);
        var members = ResolveGroupMembers(oneview, groupKey);

        if (members.Count == 0)
            throw new Exception($"No member outlets resolved for group '{groupKey}' from the OneView host→group mapping. Group control aborted.");

        Log.Information($"Group '{groupKey}' {action}: applying to {members.Count} outlet(s).");
        foreach (var (deviceId, index) in members)
            await ControlOutletAsync(deviceId, index, action, cancellationToken);

        return members.Count;
    }

    /// <summary>
    /// Resolve a group's member outlets (deviceSerial + index) from the OneView per-outlet group
    /// mapping (host.groupMap.dev.&lt;serial&gt;.outlet.&lt;index&gt;.group == groupKey).
    /// </summary>
    internal static List<(string DeviceId, int Index)> ResolveGroupMembers(OneViewRootData oneview, string groupKey)
    {
        var members = new List<(string, int)>();
        foreach (var host in oneview.Hosts)
            foreach (var (deviceId, dev) in host.GroupMap?.Dev ?? new())
                foreach (var (indexStr, outlet) in dev.Outlet ?? new())
                    if (string.Equals(outlet.Group, groupKey, StringComparison.OrdinalIgnoreCase) && int.TryParse(indexStr, out var index))
                        members.Add((deviceId, index));
        return members;
    }

    /// <summary>Write outlet configuration fields (delays, power-on action, label) — PDU.ActionsEnabled only.</summary>
    public async Task SetOutletConfigAsync(string deviceId, int outletIndex, IReadOnlyDictionary<string, object> fields, CancellationToken cancellationToken)
    {
        await api.SetOutletConfigAsync(deviceId, outletIndex, fields, cancellationToken);
        LatchPending($"o/{deviceId}/{outletIndex}", fields);
    }

    /// <summary>Report the latched value for a writable outlet config field until the PDU catches up (or we time out).</summary>
    public string ResolveOutletConfig(string deviceId, int outletIndex, string field, string actual)
        => ResolvePending($"o/{deviceId}/{outletIndex}/{field}", actual);

    /// <summary>Write device (PDU) configuration fields (e.g. <c>label</c>) — PDU.ActionsEnabled only.</summary>
    public async Task SetDeviceConfigAsync(string deviceId, IReadOnlyDictionary<string, object> fields, CancellationToken cancellationToken)
    {
        await api.SetDeviceConfigAsync(deviceId, fields, cancellationToken);
        LatchPending($"d/{deviceId}", fields);
    }

    /// <summary>Report the latched value for a writable device config field until the PDU catches up.</summary>
    public string ResolveDeviceConfig(string deviceId, string field, string actual)
        => ResolvePending($"d/{deviceId}/{field}", actual);

    /// <summary>Write entity (circuit/phase/total) configuration fields (e.g. <c>label</c>) — PDU.ActionsEnabled only.</summary>
    public async Task SetEntityConfigAsync(string deviceId, string entityKey, IReadOnlyDictionary<string, object> fields, CancellationToken cancellationToken)
    {
        await api.SetEntityConfigAsync(deviceId, entityKey, fields, cancellationToken);
        LatchPending($"e/{deviceId}/{entityKey}", fields);
    }

    /// <summary>Report the latched value for a writable entity config field until the PDU catches up.</summary>
    public string ResolveEntityConfig(string deviceId, string entityKey, string field, string actual)
        => ResolvePending($"e/{deviceId}/{entityKey}/{field}", actual);

    /// <summary>Write OneView group configuration fields (e.g. <c>label</c>) — PDU.ActionsEnabled only.</summary>
    public async Task SetGroupConfigAsync(string groupKey, IReadOnlyDictionary<string, object> fields, CancellationToken cancellationToken)
    {
        await api.SetGroupConfigAsync(groupKey, fields, cancellationToken);
        LatchPending($"g/{groupKey}", fields);
    }

    /// <summary>Report the latched value for a writable group config field until the PDU catches up.</summary>
    public string ResolveGroupConfig(string groupKey, string field, string actual)
        => ResolvePending($"g/{groupKey}/{field}", actual);

    /// <summary>Latch written config values (keyed <c>{prefix}/{field}</c>) so polling doesn't flap back to stale data.</summary>
    private void LatchPending(string prefix, IReadOnlyDictionary<string, object> fields)
    {
        lock (pendingLock)
            foreach (var (field, value) in fields)
                pendingConfig[$"{prefix}/{field}"] = (value?.ToString() ?? string.Empty, DateTime.UtcNow.Add(PendingStateTimeout));
    }

    /// <summary>Report the latched value for a config field until the PDU catches up (or we time out).</summary>
    private string ResolvePending(string key, string actual)
    {
        lock (pendingLock)
        {
            if (!pendingConfig.TryGetValue(key, out var pending))
                return actual;

            if (string.Equals(actual, pending.expected, StringComparison.OrdinalIgnoreCase) || DateTime.UtcNow >= pending.expiresUtc)
            {
                pendingConfig.Remove(key);
                return actual;
            }

            return pending.expected;
        }
    }

    /// <summary>Reset an outlet's accumulated statistics — PDU.ActionsEnabled only.</summary>
    public Task ResetOutletStatsAsync(string deviceId, int outletIndex, CancellationToken cancellationToken)
        => api.ResetOutletStatsAsync(deviceId, outletIndex, cancellationToken);

    /// <summary>
    /// Resolve the state to report for an outlet: while a recent command is still pending (the PDU
    /// hasn't applied it yet) report the commanded state instead of the stale polled one.
    /// </summary>
    public string ResolveOutletState(string deviceId, int outletIndex, string actualState)
    {
        lock (pendingLock)
        {
            var key = $"{deviceId}/{outletIndex}";
            if (!pendingOutletStates.TryGetValue(key, out var pending))
                return actualState;

            // Applied, or timed out -> stop latching and report reality.
            if (string.Equals(actualState, pending.expected, StringComparison.OrdinalIgnoreCase) || DateTime.UtcNow >= pending.expiresUtc)
            {
                pendingOutletStates.Remove(key);
                return actualState;
            }

            return pending.expected;
        }
    }

    /// <summary>
    /// Pull all public data.
    /// </summary>
    /// <remarks>
    /// Results are cached briefly so that multiple consumers (MQTT publisher, discovery, and the
    /// optional Prometheus/EmonCMS exporters) polling on the same interval share a single PDU fetch
    /// instead of each hitting the PDU API. Consumers must treat the result as read-only.
    /// </remarks>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    public async Task<PduData> GetRootData_Public(CancellationToken cancellationToken)
    {
        var ttl = TimeSpan.FromSeconds(Math.Max(1, instanceConfig.PollInterval / 2.0));

        // Always under the lock: cache hits are cheap, and concurrent callers coalesce onto a
        // single in-flight fetch instead of each hitting the PDU API.
        await dataFetchLock.WaitAsync(cancellationToken);
        try
        {
            if (cachedData is not null && DateTime.UtcNow - cachedDataAtUtc < ttl)
                return cachedData;

            cachedData = await FetchRootData(cancellationToken);
            cachedDataAtUtc = DateTime.UtcNow;
            return cachedData;
        }
        finally
        {
            dataFetchLock.Release();
        }
    }

    private readonly SemaphoreSlim dataFetchLock = new(1, 1);
    private PduData? cachedData;
    private DateTime cachedDataAtUtc;

    /// <summary>Expire the cached poll so the next fetch re-reads + re-processes (e.g. after a config reload).</summary>
    public void InvalidateCache() => cachedDataAtUtc = DateTime.MinValue;

    private async Task<PduData> FetchRootData(CancellationToken cancellationToken)
    {
        if (useOneView is null)
        {
            this.useOneView = await api.GetAsync<bool>("/api/conf/oneview/enabled", cancellationToken);
            if (useOneView == true)
                Log.Debug("Detected OneView. Will use /oneview for collecting data.");
            else
                Log.Debug("OneView is not enabled. Using /api.");
        }

        if (useOneView is null)
            throw new Exception("Failed to determine if Device Aggregation is enabled.");

        if (useOneView == true)
        {
            // View ONE-View API
            var data = await api.GetAsync<OneViewRootData>("/oneview", cancellationToken);

            // Process data.
            await processOneViewData(data, cancellationToken);

            // Return the single model.
            return new PduData
            {
                PDUs = data.Hosts.Select(o => o.Cache).ToArray(),
                Devices = data.Hosts.SelectMany(o => o.Cache.Devices).ToList(),
                Groups = data.Groups
            };
        }
        else
        {
            var model = await api.GetAsync<rPDU>("/api", cancellationToken);

            // Process single-device data.
            await processData(model, cancellationToken);

            // Return the single model.
            return new PduData
            {
                PDUs = [model],
                Devices = model.Devices
            };
        }
    }

    private async Task processOneViewData(OneViewRootData data, CancellationToken cancellationToken)
    {
        //Set basic details.
        data.Record_Parent = null;
        data.Record_Key = config.MQTT.ParentTopic;
        //data.URL = api.BaseAddress;

        data.Entity_Identifier = Coalesce(config.Overrides?.rPDU2MQTT?.ID, "rPDU2MQTT")!;
        data.Entity_Name = data.Entity_DisplayName = "OneView"; // Coalesce(config.Overrides?.rPDU2MQTT?.Name, "rPDU2MQTT")!;

        // Process groups.
        await processOneViewGroups(data, data.Groups, cancellationToken);

        // Resolve each group's member outlets from the per-outlet groupMap (for actions + member switches).
        foreach (var group in data.Groups)
        {
            group.MemberOutlets.Clear();
            group.MemberOutlets.AddRange(ResolveGroupMembers(data, group.Key));
        }


        //Process individual hosts, as if they were stand-alone hosts.
        foreach (var host in data.Hosts)
            await processData(host.Cache, cancellationToken);

    }

    private async Task processOneViewGroups(OneViewRootData Parent, List<OneViewGroup> Groups, CancellationToken cancellationToken)
    {
        // Create a child-object named "Groups"
        var Entity_Groups = BaseEntity.FromDevice(Parent, MqttPath.Groups);

        // Propagate down the parent, and identifier.
        Groups.SetParentAndIdentifier(Entity_Groups, o => o.Key);

        // Populate Name, DisplayName, and Enabled for devices.
        Groups.SetEntityNameAndEnabled(config.Overrides!, o => o.Name, o => o.Label);

        // Remove disabled items.
        Groups.PruneDisabled();

        // Process Groups.
        await processListRecursive(Groups, Parent, cancellationToken);
    }



    private async Task processData(rPDU data, CancellationToken cancellationToken)
    {
        //Set basic details.
        data.Record_Parent = null;
        data.Record_Key = config.MQTT.ParentTopic;
        data.URL = api.BaseAddress;

        data.Entity_Identifier = Coalesce(config.Overrides?.rPDU2MQTT?.ID, "rPDU2MQTT")!;
        data.Entity_Name = data.Entity_DisplayName = Coalesce(config.Overrides?.rPDU2MQTT?.Name, data.Sys.Label, data.Sys.Name, "rPDU2MQTT")!;

        // Propagate down the parent, and identifier.
        data.Devices.SetParentAndIdentifier(data, o => o.Key);

        // Populate Name, DisplayName, and Enabled for devices.
        data.Devices.SetEntityNameAndEnabled(config.Overrides!, o => o.Name, o => o.Label);

        //Process devices
        await processListRecursive(data.Devices, data, cancellationToken);
    }

    private async Task processRecursive<TEntity, TParent>([AllowNull] TEntity entity, TParent? parent, CancellationToken cancellationToken)
        where TEntity : BaseEntity
        where TParent : NamedEntity
    {
        if (entity is null)
            return;
        else if (entity is Device device)
        {
            // Propagate down the parent, and identifier.
            device.Entity.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Entity), o => o.Key);
            device.Outlets.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Outlets), o => o.Key.ToString());

            // Set Overrides
            device.Outlets.SetEntityNameAndEnabled(config.Overrides, DefaultNames.UseEntityName, DefaultNames.UseEntityLabel);
            device.Entity.SetEntityNameAndEnabled(config.Overrides, DefaultNames.UseEntityName, DefaultNames.UseEntityLabel);

            // Prune disabled items.
            device.Outlets.PruneDisabled();
            device.Entity.PruneDisabled();

            // Recurse to the next tier.
            await processListRecursive(device.Outlets, device, cancellationToken);
            await processListRecursive(device.Entity, device, cancellationToken);
        }
        else if (entity is NamedEntityWithMeasurements nem)
        {
            ArgumentNullException.ThrowIfNull(parent);

            // All measurements will be stored into a sub-key.
            nem.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(entity, MqttPath.Measurements), IdentifierFunc: o => o.Type);

            // Set Overrides
            Func<Measurement, string> MeasurementNamingFunc = o => o.Type;

            nem.Measurements.SetEntityNameAndEnabled(config.Overrides, MeasurementNamingFunc, DefaultNames.UseMeasurementType);
            nem.Measurements.PruneDisabled();

            if (entity is Entity)
                // For entities- these belong directly to a "Device"
                // We want to set the prefix to the parent device's name.
                nem.Measurements.SetEntityNamePrefix(parent.Entity_Name);
            else
                // We want to prefix the measurements, with the outlet name.
                // ie, mydevice_power
                nem.Measurements.SetEntityNamePrefix(string.Join('_', parent.Entity_Name, nem.Entity_Name).FormatName());
        }
        else if (entity is OneViewGroup grp)
        {
            ArgumentNullException.ThrowIfNull(parent);

            if (grp.Entity is null)
                return;

            // A group exposes its rollup either as per-group aggregate "outlets" or, for the
            // cluster-wide "Total" group, as pduTotal. Both are grouped measurements under the group.
            foreach (var rollup in grp.Entity.Outlets.Concat(grp.Entity.PduTotal))
            {
                // All measurements will be stored into a sub-key.
                rollup.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(entity, MqttPath.Measurements), IdentifierFunc: o => o.Type);
                rollup.Measurements.SetEntityNameAndEnabled(config.Overrides, o => o.Type, DefaultNames.UseMeasurementType);
                rollup.Measurements.PruneDisabled();

                rollup.Measurements.SetEntityNamePrefix(parent.Entity_Name);
            }
        }
        else
        {
            Log.Warning($"Unhandled entity type in processRecursive: {entity.GetType().Name}");
        }
    }

    private async Task processListRecursive<TEntity, TParent>(List<TEntity> entities, TParent parent, CancellationToken cancellationToken)
        where TEntity : notnull, BaseEntity
        where TParent : NamedEntity
    {
        foreach (var entity in entities)
            await processRecursive(entity, parent, cancellationToken);
    }
}
