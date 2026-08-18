using rPDU2MQTT.Abstractions.Pdu;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Core;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.OneView;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Which PDU a write reaches. The solution bridges any number of PDUs, so an outlet or group on the second
/// PDU must never be actioned through the first. Nothing resolves a PDU by convenience: the instance that
/// polled the device is the instance the write goes to, and when nothing has polled it the write goes
/// nowhere rather than to whichever PDU happens to be primary.
/// </summary>
public class DeviceOutletControlTests
{
    /// <summary>A snapshot cache holding exactly what the test says has been polled.</summary>
    private sealed class Cache : ISnapshotCache
    {
        private readonly List<PduSnapshot> all = new();
        public PduSnapshot? Latest => all.LastOrDefault();
        public PduSnapshot? Get(string instanceId) => all.FirstOrDefault(s => s.InstanceId == instanceId);
        public IReadOnlyCollection<PduSnapshot> All => all;

        public Cache Add(string instanceId, string? deviceId = null, string? groupKey = null, string? key = null)
        {
            var data = new PduData();
            if (deviceId is not null) data.Devices.Add(new Device { Key = key ?? deviceId, Entity_Name = deviceId });
            if (groupKey is not null) data.Groups.Add(new OneViewGroup { Key = groupKey });
            all.Add(new PduSnapshot(instanceId, DateTime.UtcNow, data));
            return this;
        }
    }

    private static PduInstanceRegistry Registry(params string[] ids)
    {
        var cfg = new Config();
        foreach (var id in ids)
        {
            var pdu = new PduConfig();
            pdu.Connection.Host = $"10.0.0.{Array.IndexOf(ids, id) + 1}";
            cfg.Pdus[id] = pdu;
        }
        return new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg));
    }

    private static DeviceOutletControl Control(Cache cache, params string[] configured)
        => new(Registry(configured), cache);

    [Fact]
    public async Task UnpolledDevice_WritesToNothing()
    {
        // Nothing has polled it, so nothing knows which PDU it is on. The honest answer is to write to none
        // of them — not to guess at the primary, which is how an outlet on rack-b gets switched via rack-a.
        var control = Control(new Cache().Add("rack-a", deviceId: "pdu-a"), "rack-a");

        var refused = await control.Control("pdu-unknown", 1, "off");
        Assert.False(refused.Ok);
        Assert.Contains("No PDU has reported device 'pdu-unknown'", refused.Message);
        Assert.Equal("", await control.SetOutletConfig("pdu-unknown", 1, "onDelay", "5", isDelay: true));
    }

    [Fact]
    public async Task Write_GoesToThePdu_ThatReportedTheDevice()
    {
        // Two PDUs polled, only rack-a configured here. A device rack-b reported resolves to rack-b — and so
        // fails naming rack-b, which is the proof it did not quietly write through the PDU that does exist.
        var cache = new Cache().Add("rack-a", deviceId: "pdu-a").Add("rack-b", deviceId: "pdu-b");
        var control = Control(cache, "rack-a");

        Assert.Equal("rack-a", control.InstanceFor("pdu-a"));
        Assert.Equal("rack-b", control.InstanceFor("pdu-b"));
        var refused = await control.Control("pdu-b", 1, "on");
        Assert.False(refused.Ok);
        Assert.Contains("'rack-b' is not configured", refused.Message);
        Assert.Equal("", await control.SetOutletConfig("pdu-b", 1, "onDelay", "5", isDelay: true));
    }

    [Fact]
    public async Task UnknownActions_ReachNoDeviceAtAll()
    {
        var control = Control(new Cache().Add("rack-a", deviceId: "pdu-a", groupKey: "Rack 1"), "rack-a");

        // Rejected before anything is resolved, so a typo on a command topic can't reach the hardware.
        var outlet = await control.Control("pdu-a", 1, "frobnicate");
        var group = await control.ControlGroup("Rack 1", "frobnicate");
        Assert.False(outlet.Ok);
        Assert.False(group.Ok);
        Assert.Contains("Unknown outlet action 'frobnicate'", outlet.Message);
        Assert.Contains("Unknown group action 'frobnicate'", group.Message);
    }

    [Fact]
    public async Task GroupNobodyReports_IsRefused_NotGuessedAt()
    {
        var control = Control(new Cache().Add("rack-a", deviceId: "pdu-a"), "rack-a");
        var refused = await control.ControlGroup("rack-1", "on");
        Assert.False(refused.Ok);
        Assert.Contains("No PDU reports a group 'rack-1'", refused.Message);
    }

    [Fact]
    public void SameGroupName_OnTwoPdus_IsTwoGroups()
    {
        // The collision that made group control ambiguous: keyed by name alone, "Rack 1" on two PDUs was one
        // owner and the last poll decided where an action went. A group action means every PDU that has it.
        var cache = new Cache().Add("rack-a", groupKey: "Rack 1").Add("rack-b", groupKey: "Rack 1");
        var control = Control(cache, "rack-a", "rack-b");

        Assert.Equal(new[] { "rack-a", "rack-b" }, control.InstancesWithGroup("Rack 1"));
        Assert.Empty(control.InstancesWithGroup("Rack 2"));
    }

    /// <summary>A plugin that supplies one device and can switch its outlets.</summary>
    private sealed class HelloPlugin : IIntegration, IDeviceSourcePlugin, IDeviceControlPlugin
    {
        public readonly List<string> Wrote = [];

        public string Id => "hello";
        public string DisplayName => "Hello";
        public IntegrationGroup Group => IntegrationGroup.Sources;
        public bool Enabled(Config c) => true;

        // The plugin names its INSTANCE; the device it reports carries a different id, which is what a
        // write addresses.
        public string InstanceId => "hello";
        public Task<rPDU2MQTT.Models.PDU.PduData?> PollAsync(Config cfg, CancellationToken ct)
            => Task.FromResult<rPDU2MQTT.Models.PDU.PduData?>(null);

        public bool Supports(string action) => action is "on" or "off";
        public Task<string> ControlOutletAsync(Config cfg, string deviceId, int outletIndex, string action, CancellationToken ct)
        {
            Wrote.Add($"{deviceId}|{outletIndex}|{action}");
            return Task.FromResult(action);
        }
    }

    [Fact]
    public async Task APluginsDevice_IsWrittenByThePlugin_HoweverItIsAddressed()
    {
        // The plugin files its snapshots under "hello"; the device in them is "hello_device". A write may
        // name either, and both have to reach the plugin — matching only the instance id let a write to the
        // device id fall through to the PDU path, where it was refused and reported as success.
        var plugin = new HelloPlugin();
        var cfg = new Config();
        var cache = new Cache().Add("hello", deviceId: "hello_device");
        var control = new DeviceOutletControl(
            Registry("rack-a"), cache, log: null, integrations: new IntegrationRegistry([plugin]), cfg: cfg);

        var byDevice = await control.Control("hello_device", 0, "off");
        var byInstance = await control.Control("hello", 1, "on");

        Assert.True(byDevice.Ok);
        Assert.True(byInstance.Ok);
        Assert.Equal(["hello_device|0|off", "hello|1|on"], plugin.Wrote);
    }

    [Fact]
    public async Task AnActionThePluginDoesNotSupport_IsRefused_NotSentOn()
    {
        var plugin = new HelloPlugin();
        var control = new DeviceOutletControl(
            Registry("rack-a"), new Cache().Add("hello", deviceId: "hello_device"), log: null,
            integrations: new IntegrationRegistry([plugin]), cfg: new Config());

        var result = await control.Control("hello_device", 0, "reboot");

        Assert.False(result.Ok);
        Assert.Empty(plugin.Wrote);
    }

    [Fact]
    public async Task ADeviceAnswersToEitherOfItsNames()
    {
        // Its topic path is built from the key, its readings are published under the entity name, and a
        // command arrives carrying whichever one the sender saw. Both have to reach the same device.
        var plugin = new HelloPlugin();
        var control = new DeviceOutletControl(
            Registry("rack-a"), new Cache().Add("hello", deviceId: "hello_device", key: "hw"), log: null,
            integrations: new IntegrationRegistry([plugin]), cfg: new Config());

        Assert.Equal("hello", control.InstanceFor("hello_device"));
        Assert.Equal("hello", control.InstanceFor("hw"));
        Assert.True((await control.Control("hw", 0, "off")).Ok);
        Assert.Equal(["hw|0|off"], plugin.Wrote);
    }
}
