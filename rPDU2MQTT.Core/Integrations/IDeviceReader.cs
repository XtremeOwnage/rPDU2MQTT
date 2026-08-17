using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Transport;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// Reads one device instance, whatever kind of device it is.
///
/// <para>
/// This is the inversion that makes a second make of hardware genuinely equal to the first. The supervising
/// The poller asks whoever handles the instance, so everything valuable it does — being the single
/// cluster-wide activation for a device, and supervising the device/outlet/group children that outlet
/// writes are routed through — was available to Vertiv and to nothing else. A plugin had to reimplement all
/// of it or go without.
/// </para>
/// <para>
/// Vertiv is one implementation; a plugin device is
/// another; both inherit the activation and the supervision.
/// </para>
/// </summary>
public interface IDeviceReader
{
    /// <summary>Does this reader own <paramref name="instanceId"/>?</summary>
    bool Handles(string instanceId, Config cfg);

    /// <summary>
    /// Read it now, or null when there is nothing to report. Null must not be treated as "everything went
    /// to zero" — the previous snapshot is left to go stale instead, which is what marks it unavailable.
    /// </summary>
    Task<PduData?> ReadAsync(string instanceId, Config cfg, CancellationToken ct);

    /// <summary>How often this instance wants polling.</summary>
    TimeSpan Interval(string instanceId, Config cfg) => TimeSpan.FromSeconds(Math.Max(1, cfg.Primary.PollInterval));
}

/// <summary>
/// Adapts an <see cref="IDeviceSourcePlugin"/> to the reader the poller asks. A plugin declares
/// only how to read its hardware; everything about being polled once cluster-wide, supervising children and
/// reporting failure is the host's, exactly as it is for the built-in poller.
/// </summary>
public sealed class PluginDeviceReader : IDeviceReader
{
    private readonly IReadOnlyList<IDeviceSourcePlugin> plugins;

    public PluginDeviceReader(IEnumerable<IDeviceSourcePlugin> plugins) => this.plugins = plugins.ToList();

    /// <summary>Every device instance the loaded plugins provide, for the activator to drive.</summary>
    public IEnumerable<string> InstanceIds => plugins.Select(p => p.InstanceId);

    public bool Handles(string instanceId, Config cfg) => Find(instanceId) is not null;

    public async Task<PduData?> ReadAsync(string instanceId, Config cfg, CancellationToken ct)
    {
        if (Find(instanceId) is not { } plugin) return null;
        var data = await plugin.PollAsync(cfg, ct);
        if (data is null) return null;

        // A plugin declares a device, not a topic tree. Wiring each entity to its parent is what gives an
        // outlet the path `<parent>/<device>/outlets/<n>/state` and the unique_id Home Assistant keys on —
        // and without it every value publishes to a bare leaf topic (`state`, `name`) at the broker root,
        // where nothing is subscribed and the command topics never match.
        if (data.Devices.Count > 0 && data.Devices[0].Record_Parent is null)
            RawSnapshotMapper.Rewire(data, cfg.MQTT.ParentTopic,
                cfg.Overrides?.rPDU2MQTT?.ID is { Length: > 0 } id ? id : "rPDU2MQTT");

        return data;
    }

    public TimeSpan Interval(string instanceId, Config cfg)
        => Find(instanceId)?.PollInterval(cfg) ?? TimeSpan.FromSeconds(Math.Max(1, cfg.Primary.PollInterval));

    private IDeviceSourcePlugin? Find(string instanceId)
        => plugins.FirstOrDefault(p => string.Equals(p.InstanceId, instanceId, StringComparison.OrdinalIgnoreCase));
}
