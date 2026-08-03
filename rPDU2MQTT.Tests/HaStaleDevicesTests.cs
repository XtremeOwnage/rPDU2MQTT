using rPDU2MQTT.Core.HomeAssistant;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Deleting registry entries out of someone's Home Assistant is not undoable from here, so the selection
/// rule is narrow and every way it could be too broad is pinned.
/// </summary>
public class HaStaleDevicesTests
{
    private static HaDevice Dev(string id, string name, string ident, int entities = 0, string? entry = "mqtt1")
        => new(id, name, [ident], entities, entry is null ? [] : [entry]);

    [Fact]
    public void OursWithNoEntities_IsStale()
    {
        // The live case: 39 devices from a build that named outlets rack_pdu_1 where the current one says
        // pdu_1. Their configs are long gone, so no MQTT retraction can ever reach them.
        var stale = HaStaleDevices.Stale([
            Dev("1", "Proxmox: Kube04", "energyflow_outlet_rack_pdu_1_9"),
            Dev("2", "Rack-PDU-1", "energyflow_pdu_rack_pdu_1"),
            Dev("3", "Outlet 4", "rPDU2MQTT_A0AE_outlets_4"),
        ]);

        Assert.Equal(3, stale.Count);
    }

    [Fact]
    public void ADeviceThatStillHasEntities_IsNeverTouched()
    {
        // The rule that makes this safe rather than clever: entities mean it is live, and deleting it would
        // take working sensors out of dashboards and history.
        Assert.Empty(HaStaleDevices.Stale([Dev("1", "Live outlet", "energyflow_outlet_pdu_1_4", entities: 3)]));
    }

    [Fact]
    public void AnotherIntegrationIsNeverTouched()
    {
        Assert.Empty(HaStaleDevices.Stale([
            Dev("1", "Attic", "acurite_986_attic"),
            Dev("2", "Zigbee thing", "0x00124b0022"),
        ]));
    }

    [Fact]
    public void AnIdentifierThatMerelyContainsOurName_IsNotOurs()
    {
        // Ownership is a prefix. Someone else mirroring our naming is not ours to delete.
        Assert.Empty(HaStaleDevices.Stale([Dev("1", "Mirror", "solar_rPDU2MQTT_copy")]));
    }

    [Fact]
    public void ADeviceWithNoConfigEntry_IsSkipped()
    {
        // Removal is per config entry; with none there is nothing to call, and claiming it was deleted
        // would be a lie the next refresh exposes.
        Assert.Empty(HaStaleDevices.Stale([Dev("1", "Orphan", "energyflow_x", entry: null)]));
    }

    [Fact]
    public void MultipleIdentifiers_MatchIfAnyIsOurs()
    {
        var d = new HaDevice("1", "Dual", ["some_other_id", "energyflow_grid"], 0, ["mqtt1"]);
        Assert.Single(HaStaleDevices.Stale([d]));
    }
}
