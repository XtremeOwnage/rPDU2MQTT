using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Integrations.Mqtt;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What the tier export puts in the <c>energy</c> field when nothing determines it.
///
/// <para>
/// The sensor built for that field is <c>state_class: total_increasing</c>. To Home Assistant a
/// total_increasing series that drops is a meter reset: the next reading is taken as a delta from zero and
/// the whole counter lands on that day. Publishing a 0 for "no reading" therefore does not read as "no
/// reading" — it reads as an entire lifetime of energy consumed in one afternoon. Seen live as 12 MWh on a
/// Sunday, against a house that uses about 50 kWh a day.
/// </para>
/// </summary>
public class EnergyExportZeroTests
{
    private sealed class Captured : IMessagePublisher
    {
        public Dictionary<string, string> Sent { get; } = new();
        public Task PublishAsync(string topic, string payload, bool retain, CancellationToken ct, DateTime? timestampUtc = null)
        {
            Sent[topic] = payload;
            return Task.CompletedTask;
        }
    }

    private sealed class Fixed : IFlowValueSource
    {
        private readonly Dictionary<string, double> v;
        public Fixed(Dictionary<string, double> x) => v = x;
        public bool TryGetValue(string node, string metric, out double value) => v.TryGetValue(node + "|" + metric, out value);
    }

    private static Config Configured()
    {
        var cfg = new Config();
        cfg.EnergyFlow.MqttExport = true;
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "solar", Label = "Solar", Kind = "solar" });
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "home", Label = "Home", Kind = "load" });
        cfg.EnergyFlow.Links.Add(new EnergyFlowLink { From = "solar", To = "home" });
        return cfg;
    }

    private static async Task<Dictionary<string, JsonElement>> Export(Dictionary<string, double> live)
    {
        var cfg = Configured();
        var publisher = new Captured();
        var source = new Fixed(live);
        var integration = new MqttIntegration(cfg, publisher, source);
        var pass = ExportPass.Build([new PduSnapshot("pdu", DateTime.UtcNow, new PduData())], cfg, source);

        await integration.SendAsync(pass, CancellationToken.None);

        return publisher.Sent
            .Where(kv => !kv.Key.Contains("/config") && !string.IsNullOrWhiteSpace(kv.Value))
            .ToDictionary(kv => kv.Key, kv => JsonDocument.Parse(kv.Value).RootElement.Clone());
    }

    /// <summary>Power is measured, energy is not. The energy field must say so, not say zero.</summary>
    [Fact]
    public async Task NoEnergyReading_IsNotPublishedAsZero()
    {
        var sent = await Export(new() { ["solar|realpower"] = 4200 });

        var solar = sent.Values.Single(v => v.GetProperty("id").GetString() == "solar");
        Assert.Equal(4200, solar.GetProperty("power").GetDouble());

        var energy = solar.GetProperty("energy");
        Assert.True(energy.ValueKind == JsonValueKind.Null,
            $"energy was published as {energy} with nothing measuring it — to a total_increasing sensor "
          + "that is a meter reset, and the next real reading is counted as a day's usage");
    }

    /// <summary>A reading of 0 is a reading, and must still be published as 0.</summary>
    [Fact]
    public async Task AMeasuredZero_IsStillPublished()
    {
        var sent = await Export(new() { ["solar|realpower"] = 0, ["solar|energy"] = 0 });

        var solar = sent.Values.Single(v => v.GetProperty("id").GetString() == "solar");
        Assert.Equal(JsonValueKind.Number, solar.GetProperty("energy").ValueKind);
        Assert.Equal(0, solar.GetProperty("energy").GetDouble());
    }

    /// <summary>And a real counter goes out unchanged.</summary>
    [Fact]
    public async Task AMeasuredCounter_IsPublishedAsItIs()
    {
        var sent = await Export(new() { ["solar|realpower"] = 4200, ["solar|energy"] = 14616.54 });

        var solar = sent.Values.Single(v => v.GetProperty("id").GetString() == "solar");
        Assert.Equal(14616.54, solar.GetProperty("energy").GetDouble(), 3);
    }
}
