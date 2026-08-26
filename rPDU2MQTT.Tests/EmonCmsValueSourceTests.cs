using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Integrations.EmonCms;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// EmonCMS read as a value source: how a binding names a feed, what happens when that name does not
/// identify one, and how a feed's reading becomes a flow value.
///
/// <para>
/// No HTTP anywhere here. The one request the poll makes is parsed by <c>ReadFeedList</c> and everything
/// after it is <c>Apply</c>, so every rule below is exercised against a fixed payload rather than a server
/// that has to be running for the test to mean anything.
/// </para>
/// </summary>
public class EmonCmsValueSourceTests
{
    private static readonly DateTime Now = new(2026, 8, 25, 12, 0, 0, DateTimeKind.Utc);

    /// <summary>A config with one node carrying one EmonCMS binding, plus the source already bound to it.</summary>
    private static (EmonCmsValueSource Source, Config Cfg) Bound(params EnergyFlowSource[] sources)
    {
        var cfg = new Config();
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "solar", Sources = [.. sources] });
        var source = new EmonCmsValueSource(cfg);
        source.Bind(SourceBindings.For(cfg, "emoncms"));
        return (source, cfg);
    }

    private static EnergyFlowSource Binding(string feed, string metric = "realpower") =>
        new() { Type = "emoncms", Metric = metric, Feed = feed };

    private static EmonCmsFeed Feed(string id, string name, string tag = "IotaWatt", string unit = "",
                                    double? value = 100, DateTime? at = null)
        => new(id, name, tag, unit, value, at ?? Now);

    // --- Naming a feed --------------------------------------------------------------------------------

    [Fact]
    public void AFeedIsFoundByItsName()
    {
        var (source, _) = Bound(Binding("1_power"));
        source.Apply([Feed("945", "1_power", value: 122.4)], Now);

        Assert.True(source.TryGetValue("solar", "realpower", Now, out var v));
        Assert.Equal(122.4, v, 3);
    }

    [Fact]
    public void AFeedIsFoundByItsNumericId()
    {
        // The id is what survives a rename, so it has to be accepted as an address in its own right.
        var (source, _) = Bound(Binding("945"));
        source.Apply([Feed("945", "1_power", value: 122.4)], Now);

        Assert.True(source.TryGetValue("solar", "realpower", Now, out var v));
        Assert.Equal(122.4, v, 3);
    }

    [Fact]
    public void AName_CanBeQualifiedWithItsTag()
    {
        var (source, _) = Bound(Binding("grid/energy", "energy"));
        source.Apply([Feed("1", "energy", tag: "solar", value: 11), Feed("2", "energy", tag: "grid", value: 22)], Now);

        Assert.True(source.TryGetValue("solar", "energy", Now, out var v));
        Assert.Equal(22, v, 3);
    }

    /// <summary>
    /// The failure this whole index exists to prevent. EmonCMS names are unique only within a tag, so
    /// "energy" under both solar and grid is ordinary — and binding a node to whichever came back first
    /// would look exactly like a working configuration while charting the wrong circuit.
    /// </summary>
    [Fact]
    public void AnAmbiguousName_SuppliesNothing_AndSaysWhy()
    {
        var (source, _) = Bound(Binding("energy", "energy"));
        source.Apply([Feed("1", "energy", tag: "solar", value: 11), Feed("2", "energy", tag: "grid", value: 22)], Now);

        Assert.False(source.TryGetValue("solar", "energy", Now, out _));
        var withheld = Assert.Single(source.Withheld);
        Assert.Contains("names 2 feeds", withheld.Reason);
        Assert.Contains("solar/energy", withheld.Reason);
        Assert.Contains("grid/energy", withheld.Reason);
    }

    [Fact]
    public void AFeedThatIsNotThere_SuppliesNothing_AndNamesIt()
    {
        var (source, _) = Bound(Binding("typo_power"));
        source.Apply([Feed("945", "1_power")], Now);

        Assert.False(source.TryGetValue("solar", "realpower", Now, out _));
        Assert.Contains("typo_power", Assert.Single(source.Withheld).Reason);
    }

    [Fact]
    public void ABindingWithNoFeed_SaysSo()
    {
        var (source, _) = Bound(new EnergyFlowSource { Type = "emoncms", Metric = "realpower" });
        source.Apply([Feed("945", "1_power")], Now);

        Assert.Contains("does not say which EmonCMS feed", Assert.Single(source.Withheld).Reason);
    }

    /// <summary>
    /// A feed EmonCMS created but nothing has logged to yet holds no value. Reporting that as 0 would put a
    /// number this bridge invented into the roll-up, and a zero is indistinguishable from a real one.
    /// </summary>
    [Fact]
    public void AFeedWithNoValueYet_IsNotZero()
    {
        var (source, _) = Bound(Binding("1_energy", "energy"));
        source.Apply([Feed("946", "1_energy", value: null)], Now);

        Assert.False(source.TryGetValue("solar", "energy", Now, out _));
        Assert.Contains("no value yet", Assert.Single(source.Withheld).Reason);
    }

    // --- Turning a reading into a flow value ----------------------------------------------------------

    [Fact]
    public void TheFeedsOwnUnit_IsConvertedToTheCanonicalOne()
    {
        // A feed in kW and one in W have to roll up together rather than differing by a thousand.
        var (source, _) = Bound(Binding("pv"));
        source.Apply([Feed("1", "pv", unit: "kW", value: 4.2)], Now);

        Assert.True(source.TryGetValue("solar", "realpower", Now, out var v));
        Assert.Equal(4200, v, 3);
    }

    [Fact]
    public void TheBindingsUnit_WinsOverTheServers()
    {
        // Correcting a mislabelled feed has to be possible from this end; the operator may not own the server.
        var binding = Binding("pv");
        binding.Unit = "W";
        var (source, _) = Bound(binding);
        source.Apply([Feed("1", "pv", unit: "kW", value: 4200)], Now);

        Assert.True(source.TryGetValue("solar", "realpower", Now, out var v));
        Assert.Equal(4200, v, 3);
    }

    [Fact]
    public void ScaleIsAppliedOnTopOfTheUnitConversion()
    {
        var binding = Binding("grid");
        binding.Scale = -1;                      // a meter that signs import negative
        var (source, _) = Bound(binding);
        source.Apply([Feed("1", "grid", unit: "kW", value: -1.5)], Now);

        Assert.True(source.TryGetValue("solar", "realpower", Now, out var v));
        Assert.Equal(1500, v, 3);
    }

    /// <summary>
    /// Freshness is judged against the feed's timestamp, not the poll's. A dead publisher leaves its last
    /// reading sitting in the feed indefinitely, and "we fetched it a second ago" says nothing at all about
    /// when it was true.
    /// </summary>
    [Fact]
    public void AFeedThatStoppedHoursAgo_IsStale_EvenThoughThePollJustRan()
    {
        var binding = Binding("1_power");
        binding.StaleAfterSeconds = 900;
        var (source, _) = Bound(binding);

        source.Apply([Feed("945", "1_power", value: 122.4, at: Now.AddHours(-3))], Now);

        Assert.False(source.TryGetValue("solar", "realpower", Now, out _));
        // Still described, so the GUI can tell "stopped three hours ago" from "never reported".
        Assert.True(source.TryDescribe("solar", "realpower", Now, out var reading));
        Assert.False(reading.Fresh);
        Assert.Equal(122.4, reading.Value, 3);
    }

    [Fact]
    public void AFreshFeed_IsSupplied()
    {
        var binding = Binding("1_power");
        binding.StaleAfterSeconds = 900;
        var (source, _) = Bound(binding);

        source.Apply([Feed("945", "1_power", value: 122.4, at: Now.AddSeconds(-60))], Now);

        Assert.True(source.TryGetValue("solar", "realpower", Now, out var v));
        Assert.Equal(122.4, v, 3);
    }

    /// <summary>A signed feed bound as 'split' fans into both directions, exactly as an MQTT one does.</summary>
    [Fact]
    public void ASplitBinding_FansIntoBothDirections()
    {
        var binding = Binding("battery");
        binding.Direction = "split";
        var (source, _) = Bound(binding);
        source.Apply([Feed("1", "battery", value: -800)], Now);   // charging

        Assert.True(source.TryGetValue("solar", FlowMetricKey.For("realpower", "in"), Now, out var charge));
        Assert.Equal(800, charge, 3);
    }

    /// <summary>
    /// Retyping or deleting a binding has to stop it feeding the graph on the next poll. Leaving the reading
    /// to expire on its own would keep a removed source in the hierarchy for its whole staleness window.
    /// </summary>
    [Fact]
    public void ARemovedBinding_StopsSupplyingOnTheNextPoll()
    {
        var (source, cfg) = Bound(Binding("1_power"));
        source.Apply([Feed("945", "1_power", value: 122.4)], Now);
        Assert.True(source.TryGetValue("solar", "realpower", Now, out _));

        cfg.EnergyFlow.Nodes[0].Sources.Clear();
        source.Bind(SourceBindings.For(cfg, "emoncms"));
        source.Apply([Feed("945", "1_power", value: 122.4)], Now);

        Assert.False(source.TryGetValue("solar", "realpower", Now, out _));
    }

    // --- Switching on, and what it needs ---------------------------------------------------------------

    [Fact]
    public void ItIsOffUntilSomethingIsBoundToIt()
    {
        var cfg = new Config { EmonCMS = { Url = "http://emon", Enabled = true } };
        Assert.False(new EmonCmsValueSource(cfg).Enabled(cfg));

        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "solar", Sources = [Binding("1_power")] });
        Assert.True(new EmonCmsValueSource(cfg).Enabled(cfg));
    }

    /// <summary>Reading feeds is not exporting: a bound node must work without EmonCMS.Enabled.</summary>
    [Fact]
    public void ReadingDoesNotRequireTheExportToBeOn_OnlyAUrl()
    {
        var (source, cfg) = Bound(Binding("1_power"));
        Assert.False(cfg.EmonCMS.Enabled);
        Assert.Contains("EmonCMS.Url", source.Misconfigured(cfg));

        cfg.EmonCMS.Url = "http://emon.example";
        Assert.Null(source.Misconfigured(cfg));
    }

    // --- The wire -------------------------------------------------------------------------------------

    [Fact]
    public void TheFeedListIsRead_HoweverEmonCmsTypedIt()
    {
        // Real payloads quote ids and values in some versions and not others, and "unit" may be absent.
        var feeds = EmonCmsValueSource.ReadFeedList("""
            [{"id":"945","name":"1_power","tag":"IotaWatt","unit":"W","value":122.43,"time":1787716750},
             {"id":946,"name":"1_energy","tag":"IotaWatt","value":"0.0272","time":"1787716750"},
             {"id":"947","name":"never_written","tag":"IotaWatt","value":null,"time":null}]
            """);

        Assert.Equal(3, feeds.Count);
        Assert.Equal(122.43, feeds[0].Value);
        Assert.Equal("W", feeds[0].Unit);
        Assert.Equal(new DateTime(2026, 8, 26, 3, 59, 10, DateTimeKind.Utc), feeds[0].AtUtc);
        Assert.Equal("946", feeds[1].Id);
        Assert.Equal(0.0272, feeds[1].Value!.Value, 6);
        Assert.Null(feeds[2].Value);
        Assert.Null(feeds[2].AtUtc);
    }

    [Fact]
    public void AnUnreadableFeedList_IsNoFeeds_NotACrash()
    {
        Assert.Empty(EmonCmsValueSource.ReadFeedList("not json at all"));
        Assert.Empty(EmonCmsValueSource.ReadFeedList("""{"success":false,"message":"invalid apikey"}"""));
    }

    // --- The poll cadence ------------------------------------------------------------------------------

    /// <summary>
    /// A poller reads by reconciling. Before this it was only called when a binding changed, so the values
    /// froze at whatever they were the first time — the bug that made the Home Assistant entity source look
    /// like it was working while reporting a number from process start.
    /// </summary>
    [Fact]
    public async Task APollingSourceIsReconciledAgainOnItsOwnCadence()
    {
        var cfg = new Config();
        cfg.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "solar", Sources = [Binding("1_power")] });

        var poller = new CountingSource("poller", refreshSeconds: 30);
        var subscriber = new CountingSource("subscriber", refreshSeconds: 0);
        var host = new rPDU2MQTT.Services.ValueSourcePluginHost(cfg, new IntegrationRegistry([poller, subscriber]));

        await host.Reconcile(CancellationToken.None, Now);
        await host.Reconcile(CancellationToken.None, Now.AddSeconds(10));
        await host.Reconcile(CancellationToken.None, Now.AddSeconds(40));

        Assert.Equal(2, poller.Calls);        // the first pass, then once the cadence had elapsed
        Assert.Equal(1, subscriber.Calls);    // took its bindings up once; nothing changed since
    }

    private sealed class CountingSource(string type, int refreshSeconds) : IIntegration, IValueSourcePlugin
    {
        public int Calls;
        public string Id => type;
        public string DisplayName => type;
        public IntegrationGroup Group => IntegrationGroup.Integrations;
        public bool Enabled(Config c) => true;
        public string SourceType => type;
        public string SourceTypeLabel => type;
        public int RefreshSeconds => refreshSeconds;
        public bool TryGetValue(string nodeId, string metric, out double value) { value = 0; return false; }
        public Task ReconcileAsync(Config cfg, IReadOnlyList<SourceBinding> bindings, CancellationToken ct)
        {
            Calls++;
            return Task.CompletedTask;
        }
    }
}
