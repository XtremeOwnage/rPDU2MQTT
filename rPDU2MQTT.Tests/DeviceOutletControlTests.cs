using rPDU2MQTT.Classes;
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
/// <para>
/// (These assertions came from the grain tree's ownership tests. The tree is gone; the rule isn't.)
/// </para>
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

        public Cache Add(string instanceId, string? deviceId = null, string? groupKey = null)
        {
            var data = new PduData();
            if (deviceId is not null) data.Devices.Add(new Device { Key = deviceId, Entity_Name = deviceId });
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

        Assert.Contains("No PDU has reported device 'pdu-unknown'", await control.Control("pdu-unknown", 1, "off"));
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
        Assert.Contains("'rack-b' is not configured", await control.Control("pdu-b", 1, "on"));
        Assert.Equal("", await control.SetOutletConfig("pdu-b", 1, "onDelay", "5", isDelay: true));
    }

    [Fact]
    public async Task UnknownActions_ReachNoDeviceAtAll()
    {
        var control = Control(new Cache().Add("rack-a", deviceId: "pdu-a", groupKey: "Rack 1"), "rack-a");

        // Rejected before anything is resolved, so a typo on a command topic can't reach the hardware.
        Assert.Contains("Unknown outlet action 'frobnicate'", await control.Control("pdu-a", 1, "frobnicate"));
        Assert.Contains("Unknown group action 'frobnicate'", await control.ControlGroup("Rack 1", "frobnicate"));
    }

    [Fact]
    public async Task GroupNobodyReports_IsRefused_NotGuessedAt()
    {
        var control = Control(new Cache().Add("rack-a", deviceId: "pdu-a"), "rack-a");
        Assert.Contains("No PDU reports a group 'rack-1'", await control.ControlGroup("rack-1", "on"));
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
}
