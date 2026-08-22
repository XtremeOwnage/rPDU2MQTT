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

    /// <summary>Several passes through ONE integration, so its high-water marks carry across them.</summary>
    private static async Task<List<Dictionary<string, JsonElement>>> ExportSequence(params Dictionary<string, double>[] passes)
    {
        var cfg = Configured();
        var publisher = new Captured();
        var results = new List<Dictionary<string, JsonElement>>();
        MqttIntegration? integration = null;

        foreach (var live in passes)
        {
            var source = new Fixed(live);
            integration ??= new MqttIntegration(cfg, publisher, source);
            var pass = ExportPass.Build([new PduSnapshot("pdu", DateTime.UtcNow, new PduData())], cfg, source);
            publisher.Sent.Clear();
            await integration.SendAsync(pass, CancellationToken.None);
            results.Add(publisher.Sent
                .Where(kv => !kv.Key.Contains("/config") && !string.IsNullOrWhiteSpace(kv.Value))
                .ToDictionary(kv => kv.Key, kv => JsonDocument.Parse(kv.Value).RootElement.Clone()));
        }
        return results;
    }

    private static JsonElement Node(Dictionary<string, JsonElement> sent, string id)
        => sent.Values.Single(v => v.GetProperty("id").GetString() == id);

    /// <summary>
    /// A roll-up sums the links whose flow is known, so a contributor going stale makes the parent's total
    /// smaller with nothing wrong at the meter. Publishing that dip into a total_increasing sensor records
    /// the whole counter as one period's usage (#403).
    /// </summary>
    [Fact]
    public async Task ALifetimeCounterIsNotPublishedGoingBackwards()
    {
        var sent = await ExportSequence(
            new() { ["solar|realpower"] = 4200, ["solar|energy"] = 14616.54 },
            new() { ["solar|realpower"] = 4200, ["solar|energy"] = 9800.00 },
            new() { ["solar|realpower"] = 4200, ["solar|energy"] = 14620.00 });

        Assert.Equal(14616.54, Node(sent[0], "solar").GetProperty("energy").GetDouble(), 3);

        var dipped = Node(sent[1], "solar").GetProperty("energy");
        Assert.True(dipped.ValueKind == JsonValueKind.Null,
            $"a lifetime counter went backwards to {dipped} — to a total_increasing sensor that is a meter "
          + "reset, and the next reading is recorded as a whole counter's worth of usage");

        // …and it publishes again by itself once the reading passes where it was.
        Assert.Equal(14620.00, Node(sent[2], "solar").GetProperty("energy").GetDouble(), 3);
    }

    /// <summary>Power is a rate, not a counter: it falls all the time and must keep being published.</summary>
    [Fact]
    public async Task PowerIsNotGuarded()
    {
        var sent = await ExportSequence(
            new() { ["solar|realpower"] = 4200 },
            new() { ["solar|realpower"] = 120 });

        Assert.Equal(120, Node(sent[1], "solar").GetProperty("power").GetDouble());
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
