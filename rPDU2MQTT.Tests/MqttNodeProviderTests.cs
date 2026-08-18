using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Discovery;
using rPDU2MQTT.Hosting;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What the broker offers as nodes to adopt.
/// <para>
/// The rule that matters: never offer this bridge's own output. Adopting a topic it just published feeds it
/// its own readings, and on a live broker those topics outnumber everything else — every one of the first
/// hundred offered was ours before this.
/// </para>
/// </summary>
public class MqttNodeProviderTests
{
    private static TopicIndex IndexOf(params string[] topics)
    {
        var index = new TopicIndex();
        index.Renew("#");   // a browse is open, otherwise the index refuses to accumulate
        index.Observe(topics.Select(t => new TopicSample { Topic = t, Payload = "12.5", SeenUtc = DateTime.UtcNow }).ToList());
        return index;
    }

    private static Config Config()
    {
        var cfg = new Config();
        cfg.MQTT.ParentTopic = "rPDU2MQTT";
        cfg.HASS.DiscoveryTopic = "homeassistant";
        return cfg;
    }

    [Fact]
    public async Task OurOwnTopicsAreNeverOffered()
    {
        var index = IndexOf(
            "rPDU2MQTT/0/outlets/0/state",
            "rPDU2MQTT/energyflow/shed",
            "homeassistant/device/rPDU2MQTT_0/config",
            "solar_assistant/inverter_1/pv_power/state",
            "shellies/plug1/relay/0/power");

        var nodes = await new MqttNodeProvider(index).DiscoverAsync(Config(), null, CancellationToken.None);

        Assert.Equal(
            ["shellies/plug1/relay/0/power", "solar_assistant/inverter_1/pv_power/state"],
            nodes.Select(n => n.Key).OrderBy(k => k));
    }

    [Fact]
    public async Task ADifferentParentTopicChangesWhatCountsAsOurs()
    {
        // The exclusion follows configuration, not a hardcoded name: someone bridging a SECOND rPDU2MQTT
        // under a different parent topic should still be able to adopt its topics.
        var index = IndexOf("rPDU2MQTT/0/outlets/0/state", "other_bridge/0/outlets/0/state");
        var cfg = Config();
        cfg.MQTT.ParentTopic = "other_bridge";

        var nodes = await new MqttNodeProvider(index).DiscoverAsync(cfg, null, CancellationToken.None);

        Assert.Equal("rPDU2MQTT/0/outlets/0/state", Assert.Single(nodes).Key);
    }

    [Fact]
    public async Task ASimilarlyNamedTopicIsNotOurs()
    {
        // Prefix matching is by segment: "rPDU2MQTT_backup/..." is somebody else's tree.
        var index = IndexOf("rPDU2MQTT_backup/0/state", "rPDU2MQTT/0/state");

        var nodes = await new MqttNodeProvider(index).DiscoverAsync(Config(), null, CancellationToken.None);

        Assert.Equal("rPDU2MQTT_backup/0/state", Assert.Single(nodes).Key);
    }
}
