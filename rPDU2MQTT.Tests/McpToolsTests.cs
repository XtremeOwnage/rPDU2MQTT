using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

public class McpToolsTests
{
    private static McpTools Tools(Config cfg) => new(
        cfg, new NoPduInstances(), new SnapshotCache(new ChannelMessageBus()), new HealthState(), new FakeHiveMQClient(),
        live: null, status: null, history: null);

    [Fact]
    public void ReadsAnswerBeforeAnySnapshot()
    {
        var tools = Tools(new Config());
        Assert.Empty(tools.ListSnapshots());
        Assert.Empty(tools.GetReadings());
        Assert.Empty(tools.GetStatus());
        Assert.True(tools.GetHealth().MqttConnected);
    }

    [Fact]
    public async Task History_SaysSoWhenNotEnabled()
    {
        var result = await Tools(new Config()).GetHistory(["outlet:pdu:0"]);
        Assert.Contains("not enabled", System.Text.Json.JsonSerializer.Serialize(result));
    }
}
