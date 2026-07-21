using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Grains.Abstractions.Discovery;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// What a sampled payload says about the binding it could feed — the guessing behind the Nodes editor's
/// topic autocomplete, kept out of the browser and out of the broker so it can be checked on its own.
/// </summary>
public class TopicSampleAnalyzerTests
{
    [Fact]
    public void Unit_InThePayload_DecidesTheMetric()
    {
        // A unit is the strongest signal there is — it outranks whatever the topic is called.
        Assert.Equal("realpower", TopicSampleAnalyzer.Analyze("shed/thing/state", "1234 W").Metric);
        Assert.Equal("energy", TopicSampleAnalyzer.Analyze("shed/thing/state", "12.5 kWh").Metric);
        Assert.Equal("current", TopicSampleAnalyzer.Analyze("shed/thing/state", "3.2A").Metric);
        Assert.Equal("voltage", TopicSampleAnalyzer.Analyze("shed/thing/state", "241.7 V").Metric);
        Assert.Equal("frequency", TopicSampleAnalyzer.Analyze("shed/thing/state", "60 Hz").Metric);
    }

    [Fact]
    public void Value_And_Unit_AreReadOutOfTheReading()
    {
        var hint = TopicSampleAnalyzer.Analyze("solar_assistant/inverter_1/pv_power/state", "3.4 kW");
        Assert.Equal(3.4, hint.Value);
        Assert.Equal("kW", hint.Unit);          // spelled the way the unit vocabulary spells it
        Assert.Equal("realpower", hint.Metric);
        Assert.False(hint.IsJson);

        // A bare number still gives a value; there's just no unit to report.
        var bare = TopicSampleAnalyzer.Analyze("meter/1/power", "750");
        Assert.Equal(750, bare.Value);
        Assert.Null(bare.Unit);
        Assert.Equal("realpower", bare.Metric);  // ...so the topic decides

        // A unit the metric can't convert isn't offered as one.
        Assert.Null(TopicSampleAnalyzer.Analyze("meter/1/power", "750 zz").Unit);
    }

    [Fact]
    public void Topic_Words_Decide_WhenThePayloadIsBare()
    {
        Assert.Equal("voltage", TopicSampleAnalyzer.Analyze("emon/main/voltage", "241").Metric);
        Assert.Equal("current", TopicSampleAnalyzer.Analyze("emon/main/amps", "12").Metric);
        Assert.Equal("energy", TopicSampleAnalyzer.Analyze("emon/main/energy", "12").Metric);
        Assert.Equal("powerfactor", TopicSampleAnalyzer.Analyze("emon/main/power_factor", "0.98").Metric);

        // More specific words win over the ones they contain.
        Assert.Equal("apparentpower", TopicSampleAnalyzer.Analyze("emon/main/apparent_power", "800").Metric);

        // Nothing to go on is not a guess.
        Assert.Null(TopicSampleAnalyzer.Analyze("some/opaque/topic", "42").Metric);
    }

    [Fact]
    public void JsonPayload_Offers_ItsNumericFields()
    {
        var hint = TopicSampleAnalyzer.Analyze("tele/plug/SENSOR",
            """{"Time":"2026-07-21","ENERGY":{"Power":123,"Voltage":"241.2 V","Total":9.5,"Name":"kitchen"}}""");

        Assert.True(hint.IsJson);
        Assert.Contains("ENERGY.Power", hint.Fields);
        Assert.Contains("ENERGY.Total", hint.Fields);
        Assert.Contains("ENERGY.Voltage", hint.Fields);   // a numeric string is a number to the ingest
        Assert.DoesNotContain("ENERGY.Name", hint.Fields); // ...but a name isn't
        Assert.DoesNotContain("Time", hint.Fields);

        // The field's own name is the better hint for a JSON binding; the topic is the fallback.
        Assert.Equal("voltage", TopicSampleAnalyzer.MetricForField("tele/plug/SENSOR", "ENERGY.Voltage"));
        Assert.Equal("realpower", TopicSampleAnalyzer.MetricForField("tele/plug/SENSOR", "ENERGY.Power"));
    }

    [Fact]
    public void Garbage_Doesnt_Throw()
    {
        Assert.False(TopicSampleAnalyzer.Analyze("t", null).IsJson);
        Assert.Empty(TopicSampleAnalyzer.Analyze("t", "{not json").Fields);   // looked like JSON, wasn't
        Assert.Null(TopicSampleAnalyzer.Analyze("t", "").Value);
    }
}

/// <summary>
/// The topic index exists only while someone is browsing: it's leased, and it's capped. Both of those are
/// the point — the alternative is a background process quietly indexing every topic on the broker forever.
/// </summary>
public class TopicIndexGrainTests
{
    private static TopicSample Sample(string topic, string payload)
        => new() { Topic = topic, Payload = payload, SeenUtc = DateTime.UtcNow };

    [Fact]
    public async Task NobodyBrowsing_MeansNothingIsCollected()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var index = cluster.GrainFactory.GetGrain<ITopicIndexGrain>(0);

            // Un-leased: the subscriber shouldn't even be listening...
            Assert.False(await index.Wanted());

            // ...and anything pushed at it anyway is dropped rather than accumulated.
            await index.Observe(new List<TopicSample> { Sample("solar/pv/power", "1200 W") });
            Assert.Empty(await index.Search("solar", 10));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task Browsing_LeasesTheIndex_AndSearchesIt()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var index = cluster.GrainFactory.GetGrain<ITopicIndexGrain>(0);

            var state = await index.Renew();
            Assert.False(state.Listening);        // nothing has reported yet
            Assert.True(await index.Wanted());    // ...but the subscriber is now asked to

            await index.Observe(new List<TopicSample>
            {
                Sample("solar_assistant/inverter_1/pv_power/state", "3.4 kW"),
                Sample("solar_assistant/inverter_1/grid_voltage/state", "241 V"),
                Sample("tele/plug/SENSOR", """{"ENERGY":{"Power":12}}"""),
            });

            Assert.True((await index.Renew()).Listening);

            var solar = await index.Search("pv_power", 10);
            Assert.Equal("solar_assistant/inverter_1/pv_power/state", Assert.Single(solar).Topic);

            // Shortest first: what you typed, not the deepest branch of the tree.
            var all = await index.Search("", 10);
            Assert.Equal("tele/plug/SENSOR", all.First().Topic);

            Assert.Equal("3.4 kW", (await index.Get("solar_assistant/inverter_1/pv_power/state"))!.Payload);
            Assert.Null(await index.Get("nothing/here"));
        }
        finally { await cluster.StopAllSilosAsync(); }
    }

    [Fact]
    public async Task ChattyBroker_CantGrowItPastItsCap()
    {
        var cluster = await GrainTestCluster.StartAsync();
        try
        {
            var index = cluster.GrainFactory.GetGrain<ITopicIndexGrain>(0);
            await index.Renew();

            var flood = new List<TopicSample>();
            for (var i = 0; i < 2500; i++) flood.Add(Sample($"noisy/{i}/state", i.ToString()));
            await index.Observe(flood);

            var state = await index.Renew();
            Assert.Equal(state.Capacity, state.Topics);   // held at the cap, not at 2500
        }
        finally { await cluster.StopAllSilosAsync(); }
    }
}
