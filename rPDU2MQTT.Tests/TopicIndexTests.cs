using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Discovery;
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
public class TopicIndexBehaviourTests
{
    private static TopicSample Sample(string topic, string payload)
        => new() { Topic = topic, Payload = payload, SeenUtc = DateTime.UtcNow };

    [Fact]
    public void NobodyBrowsing_MeansNothingIsCollected()
    {
        var index = new TopicIndex();

        // Un-leased: the subscriber shouldn't even be listening...
        Assert.False(index.Wanted());

        // ...and anything pushed at it anyway is dropped rather than accumulated.
        index.Observe(new List<TopicSample> { Sample("solar/pv/power", "1200 W") });
        Assert.Empty(index.Search("solar", 10));
    }

    [Fact]
    public void Browsing_LeasesTheIndex_AndSearchesIt()
    {
        var index = new TopicIndex();

        var state = index.Renew(null);
        Assert.False(state.Listening);        // nothing has reported yet
        Assert.True(index.Wanted());    // ...but the subscriber is now asked to

        index.Observe(new List<TopicSample>
        {
            Sample("solar_assistant/inverter_1/pv_power/state", "3.4 kW"),
            Sample("solar_assistant/inverter_1/grid_voltage/state", "241 V"),
            Sample("tele/plug/SENSOR", """{"ENERGY":{"Power":12}}"""),
        });

        Assert.True((index.Renew(null)).Listening);

        var solar = index.Search("pv_power", 10);
        Assert.Equal("solar_assistant/inverter_1/pv_power/state", Assert.Single(solar).Topic);

        // Shortest first: what you typed, not the deepest branch of the tree.
        var all = index.Search("", 10);
        Assert.Equal("tele/plug/SENSOR", all.First().Topic);

        Assert.Equal("3.4 kW", (index.Get("solar_assistant/inverter_1/pv_power/state"))!.Payload);
        Assert.Null(index.Get("nothing/here"));
    }

    [Fact]
    public void ChattyBroker_CantGrowItPastItsCap()
    {
        var index = new TopicIndex();
        index.Renew(null);

        var flood = new List<TopicSample>();
        for (var i = 0; i < 2500; i++) flood.Add(Sample($"noisy/{i}/state", i.ToString()));
        index.Observe(flood);

        var state = index.Renew(null);
        Assert.Equal(state.Capacity, state.Topics);   // held at the cap, not at 2500
    }

    [Fact]
    public void Filter_DefaultsToWildcard_Narrows_AndBlankKeepsIt()
    {
        var index = new TopicIndex();

        // Default is the bare wildcard, and that's what the subscriber is told to subscribe to.
        Assert.Equal("#", (index.Renew(null)).Filter);
        Assert.Equal("#", index.DesiredFilter());

        // Narrowing to a prefix re-subscribes and drops what was held for the old filter.
        index.Observe(new List<TopicSample> { Sample("anything/1", "x") });
        var narrowed = index.Renew("solar_assistant/#");
        Assert.Equal("solar_assistant/#", narrowed.Filter);
        Assert.Equal(0, narrowed.Topics);   // cleared on the filter change
        Assert.Equal("solar_assistant/#", index.DesiredFilter());

        // A blank renew keeps the current filter (the detail lookups renew this way; they must not reset it).
        Assert.Equal("solar_assistant/#", (index.Renew(null)).Filter);
        Assert.Equal("solar_assistant/#", (index.Renew("  ")).Filter);
    }

    [Fact]
    public void DeniedSubscription_IsVisible_AsGrantedFalse()
    {
        var index = new TopicIndex();
        index.Renew(null);

        // Before the subscriber reports, grant is unknown (null) — not a silent "false".
        Assert.Null((index.Renew(null)).Granted);

        // The subscriber reports the SUBACK outcome; a denial surfaces so the browser can explain it.
        index.ReportSubscription(false);
        Assert.False((index.Renew(null)).Granted);

        index.ReportSubscription(true);
        Assert.True((index.Renew(null)).Granted);
    }

    [Fact]
    public void NobodyBrowsing_HasNoDesiredFilter()
    {
        // Un-leased: the subscriber must be told to subscribe to nothing.
        Assert.Equal("", new TopicIndex().DesiredFilter());
    }

    [Fact]
    public void TopicsUnder_ReturnsEverything_WhereSearchWouldCapAndReorder()
    {
        // A sweep that must retract every retained discovery message cannot use Search: it caps at 200 and
        // orders by topic length for autocomplete relevance, so on a busy broker it would quietly hand back a
        // subset and the rest would survive the "clear" — the exact failure the sweep exists to prevent.
        var index = new TopicIndex();
        index.Renew("homeassistant/#");

        var samples = Enumerable.Range(0, 400)
            .Select(i => new TopicSample { Topic = $"homeassistant/device/rPDU2MQTT_dev{i:000}/config", SeenUtc = DateTime.UtcNow })
            .Append(new TopicSample { Topic = "other/thing", SeenUtc = DateTime.UtcNow })
            .ToList();
        index.Observe(samples);

        var swept = index.TopicsUnder("homeassistant/");
        Assert.Equal(400, swept.Count);
        Assert.DoesNotContain("other/thing", swept);

        // What the old path would have given the sweep.
        var browsed = index.Search(null, 5000);
        Assert.True(browsed.Count <= 200, $"Search is meant to stay a browse, got {browsed.Count}");
    }

    [Fact]
    public void TopicsUnder_MatchesOnPrefix_NotSubstring()
    {
        var index = new TopicIndex();
        index.Renew("#");
        index.Observe(new List<TopicSample>
        {
            new() { Topic = "homeassistant/device/a/config", SeenUtc = DateTime.UtcNow },
            new() { Topic = "mirror/homeassistant/device/b/config", SeenUtc = DateTime.UtcNow },
        });

        var found = index.TopicsUnder("homeassistant/");
        Assert.Equal(new[] { "homeassistant/device/a/config" }, found);
    }
}

public class TopicIndexLeaseTests
{
    private static TopicSample Sample(string topic, string? payload = "1")
        => new() { Topic = topic, Payload = payload, SeenUtc = DateTime.UtcNow };

    [Fact]
    public void NobodyBrowsing_MeansNothingIsIndexed()
    {
        // Asking is what starts it; not asking is what stops it. Observing without a lease must not
        // accumulate, or "leased" means nothing.
        var index = new TopicIndex();
        index.Observe([Sample("a/b")]);

        Assert.False(index.Wanted());
        Assert.Empty(index.Search(null, 10));
    }

    [Fact]
    public void RenewingOpensIt_AndAskingKeepsItOpen()
    {
        var index = new TopicIndex();
        index.Renew(null);
        index.Observe([Sample("solar/pv_power"), Sample("solar/battery_soc")]);

        Assert.True(index.Wanted());
        Assert.Equal(2, index.Search(null, 10).Count);
        Assert.Single(index.Search("battery", 10));
    }

    [Fact]
    public void ANarrowedFilterIsNotResetByAPlainRenew()
    {
        // The detail lookups renew with no filter; if that reset the filter to '#' every time, narrowing it
        // on a broker whose ACL forbids the wildcard would be undone by the next click.
        var index = new TopicIndex();
        index.Renew("solar/#");
        index.Observe([Sample("solar/x")]);
        index.Renew(null);

        Assert.Equal("solar/#", index.DesiredFilter());
        Assert.Single(index.Search(null, 10));   // and it kept what it had
    }

    [Fact]
    public void ChangingTheFilterStartsAgain()
    {
        var index = new TopicIndex();
        index.Renew("a/#");
        index.Observe([Sample("a/one")]);
        index.Renew("b/#");

        Assert.Empty(index.Search(null, 10));
        Assert.Equal("b/#", index.DesiredFilter());
    }

    [Fact]
    public void ADeniedSubscriptionIsReported_SoAnEmptyBrowseIsExplained()
    {
        // An ACL forbidding the wildcard is the usual reason a browse stays empty on a working broker.
        // Saying so beats showing nothing.
        var index = new TopicIndex();
        index.Renew(null);
        index.ReportSubscription(granted: false);

        Assert.False(index.Renew(null).Granted);
    }

    [Fact]
    public void ItStopsGrowing_RatherThanFollowingAChattyBrokerForever()
    {
        var index = new TopicIndex();
        index.Renew(null);
        index.Observe([.. Enumerable.Range(0, TopicIndex.Capacity + 500).Select(i => Sample($"t/{i}"))]);

        Assert.True(index.Search(null, int.MaxValue).Count <= TopicIndex.Capacity);
    }
}
