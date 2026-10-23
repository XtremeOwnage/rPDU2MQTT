using System.Net;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Plugin.IotaWatt;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>IoTaWatt read directly over its query API, against a canned device.</summary>
public class IotaWattPluginTests
{
    private static readonly DateTime Now = new(2026, 10, 23, 12, 0, 0, DateTimeKind.Utc);
    private static long Unix(DateTime t) => new DateTimeOffset(t).ToUnixTimeSeconds();

    private const string Series = """
        {"series":[{"name":"Main","unit":"Watts"},{"name":"Solar","unit":"Watts"},{"name":"Voltage","unit":"Volts"},{"name":"Total_Amps","unit":"Amps"}]}
        """;

    /// <summary>Answers by URL; records every request.</summary>
    private sealed class Device(Func<string, (HttpStatusCode, string)> answer) : HttpMessageHandler
    {
        public readonly List<string> Requests = [];

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var url = Uri.UnescapeDataString(request.RequestUri!.ToString());
            Requests.Add(url);
            var (code, body) = answer(url);
            return Task.FromResult(new HttpResponseMessage(code) { Content = new StringContent(body) });
        }
    }

    private sealed class MemoryStore : IPluginStore
    {
        public readonly Dictionary<string, Dictionary<string, string>> Data = new();
        public IReadOnlyDictionary<string, string> Read(string name) => Data.TryGetValue(name, out var d) ? d : new();
        public void Write(string name, IReadOnlyDictionary<string, string> fields) => Data[name] = new(fields);
    }

    private static IotaWattSettings Settings(params string[] ids) => new()
    {
        Enabled = true,
        Devices = [.. ids.Select(id => new IotaWattDevice { Id = id, Url = $"http://{id}.local/" })],
    };

    private static EnergyFlowSource Bind(string series, string metric = "realpower", string? device = null, string accumulation = "lifetime")
    {
        var s = new EnergyFlowSource { Type = "iotawatt", Metric = metric, Accumulation = accumulation, Settings = { ["Series"] = series } };
        if (device is not null) s.Settings["Device"] = device;
        return s;
    }

    private static (IotaWattPlugin Plugin, Device Device) Plugin(IotaWattSettings settings, Func<string, (HttpStatusCode, string)> answer,
        IPluginStore? store = null, params (string Node, EnergyFlowSource Source)[] bindings)
    {
        var device = new Device(answer);
        var plugin = new IotaWattPlugin(device);
        plugin.ApplyConfig(settings);
        if (store is not null) plugin.UseStore(store);
        plugin.Bind([.. bindings.Select(b => new SourceBinding(b.Node, b.Source.Metric, b.Source))]);
        return (plugin, device);
    }

    private static (HttpStatusCode, string) Ok(string body) => (HttpStatusCode.OK, body);

    private static string Live(params object?[][] rows)
        => "{\"range\":[0,0],\"labels\":[],\"data\":[" + string.Join(",", rows.Select(r =>
               "[" + string.Join(",", r.Select(v => v is null ? "null" : Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture))) + "]")) + "]}";

    [Fact]
    public async Task APowerSeriesIsRead_FromTheNewestLoggedGroup_AtThatGroupsTime()
    {
        var t1 = Now.AddSeconds(-10);
        var t2 = Now.AddSeconds(-5);
        var (plugin, device) = Plugin(Settings("main"),
            url => url.Contains("show=series") ? Ok(Series) : Ok(Live([Unix(t1), 900.5, 1200], [Unix(t2), 950.25, null], [Unix(Now), null, null])),
            null, ("house", Bind("main")), ("solar", Bind("Solar")));

        await plugin.PollAsync(Settings("main"), Now, CancellationToken.None);

        Assert.True(plugin.TryDescribe("house", "realpower", out var house));
        Assert.Equal(950.25, house.Value, 3);
        Assert.Equal(t2, house.AtUtc);
        // A null in the newest group does not hide the one before it.
        Assert.True(plugin.TryGetValue("solar", "realpower", Now, out var solar));
        Assert.Equal(1200, solar, 3);

        // Every live binding on a device is one select, with the series' own spelling.
        var live = Assert.Single(device.Requests, r => r.Contains("select="));
        Assert.Contains("select=[time.utc.unix,Main.watts,Solar.watts]", live);
        Assert.Contains("begin=s-30s&end=s&group=5s", live);
        Assert.Equal("http://main.local/query?show=series", device.Requests[0]);
    }

    [Fact]
    public async Task EachMetricAsksForItsOwnUnit()
    {
        var (plugin, device) = Plugin(Settings("main"),
            url => url.Contains("show=series") ? Ok(Series) : Ok(Live([Unix(Now), 12.5, 1500, 121.2, 60.01, 0.95, 7.5])),
            null,
            ("a", Bind("Main", "current")), ("b", Bind("Main", "apparentpower")), ("c", Bind("Voltage", "voltage")),
            ("d", Bind("Voltage", "frequency")), ("e", Bind("Main", "powerfactor")), ("f", Bind("Total_Amps", "current")));

        await plugin.PollAsync(Settings("main"), Now, CancellationToken.None);

        Assert.Contains(device.Requests, r => r.Contains("[time.utc.unix,Main.amps,Main.va,Voltage.volts,Voltage.hz,Main.pf,Total_Amps]"));
        Assert.True(plugin.TryGetValue("a", "current", Now, out var a)); Assert.Equal(12.5, a, 3);
        Assert.True(plugin.TryGetValue("b", "apparentpower", Now, out var b)); Assert.Equal(1500, b, 3);
        Assert.True(plugin.TryGetValue("c", "voltage", Now, out var c)); Assert.Equal(121.2, c, 3);
        Assert.True(plugin.TryGetValue("d", "frequency", Now, out var d)); Assert.Equal(60.01, d, 3);
        Assert.True(plugin.TryGetValue("e", "powerfactor", Now, out var e)); Assert.Equal(0.95, e, 3);
        Assert.True(plugin.TryGetValue("f", "current", Now, out var f)); Assert.Equal(7.5, f, 3);
        Assert.Empty(plugin.Withheld);
    }

    [Fact]
    public async Task TodaysEnergy_IsWattHoursSinceMidnight_InKilowattHours()
    {
        var (plugin, device) = Plugin(Settings("main"),
            url => url.Contains("show=series") ? Ok(Series) : Ok(Live([5432.1])),
            null, ("house", Bind("Main", "energy", accumulation: "period")));

        await plugin.PollAsync(Settings("main"), Now, CancellationToken.None);

        Assert.Contains(device.Requests, r => r.Contains("select=[Main.wh]&begin=d&end=s&group=all"));
        var key = Assert.Single(plugin.ReportedKeys);
        Assert.True(plugin.TryGetValue("house", key.Metric, Now, out var kwh));
        Assert.Equal(5.4321, kwh, 4);
    }

    [Fact]
    public async Task ALifetimeCounter_CountsFromAnInstantPinnedOnTheFirstPoll()
    {
        var store = new MemoryStore();
        var (plugin, device) = Plugin(Settings("main"),
            url => url.Contains("show=series") ? Ok(Series) : Ok(Live([100.0])),
            store, ("house", Bind("Main", "energy")));

        await plugin.PollAsync(Settings("main"), Now, CancellationToken.None);
        await plugin.PollAsync(Settings("main"), Now.AddMinutes(1), CancellationToken.None);

        var pinned = store.Data["energy-since"]["main"];
        Assert.Equal(Unix(Now).ToString(), pinned);
        Assert.Equal(2, device.Requests.Count(r => r.Contains($"begin={pinned}&end=s&group=all")));

        // A restarted bridge reads the pinned instant back rather than starting the counter again.
        var (again, second) = Plugin(Settings("main"),
            url => url.Contains("show=series") ? Ok(Series) : Ok(Live([150.0])),
            store, ("house", Bind("Main", "energy")));
        await again.PollAsync(Settings("main"), Now.AddHours(1), CancellationToken.None);
        Assert.Contains(second.Requests, r => r.Contains($"begin={pinned}&"));
    }

    [Fact]
    public async Task AConfiguredStart_IsUsedForLifetimeEnergy()
    {
        var settings = Settings("main");
        settings.Devices[0].EnergySince = "2024-01-01";
        var (plugin, device) = Plugin(settings,
            url => url.Contains("show=series") ? Ok(Series) : Ok(Live([100.0])),
            new MemoryStore(), ("house", Bind("Main", "energy")));

        await plugin.PollAsync(settings, Now, CancellationToken.None);

        Assert.Contains(device.Requests, r => r.Contains("begin=2024-01-01&"));
    }

    [Fact]
    public async Task BindingsThatCannotBeRead_AreWithheld_AndSayWhy()
    {
        var (plugin, device) = Plugin(Settings("main"),
            url => url.Contains("show=series") ? Ok(Series) : Ok(Live([Unix(Now), 10])),
            null, ("a", Bind("Nope")), ("b", Bind("Voltage", "realpower")), ("c", Bind("Main")),
            ("d", new EnergyFlowSource { Type = "iotawatt", Metric = "realpower" }), ("e", Bind("Main", device: "other")));

        await plugin.PollAsync(Settings("main"), Now, CancellationToken.None);

        var withheld = plugin.Withheld.ToDictionary(w => w.Node, w => w.Reason);
        Assert.Contains("no input or output called 'Nope'", withheld["a"]);
        Assert.Contains("voltage input", withheld["b"]);
        Assert.Contains("Settings.Series", withheld["d"]);
        Assert.Contains("'other'", withheld["e"]);
        Assert.False(withheld.ContainsKey("c"));
        // An unreadable series never reaches the select, where IoTaWatt would reject the whole query.
        Assert.Contains(device.Requests, r => r.Contains("select=[time.utc.unix,Main.watts]"));
        Assert.Equal(HealthLevel.Warn, plugin.Status(Config(Settings("main"))).Level);
    }

    [Fact]
    public async Task WithTwoDevices_ABindingMustNameOne()
    {
        var (plugin, device) = Plugin(Settings("main", "sub"),
            url => url.Contains("show=series") ? Ok(Series) : Ok(Live([Unix(Now), url.Contains("sub.local") ? 20 : 10])),
            null, ("x", Bind("Main")), ("y", Bind("Main", device: "SUB")));

        await plugin.PollAsync(Settings("main", "sub"), Now, CancellationToken.None);

        Assert.Contains("set Settings.Device", Assert.Single(plugin.Withheld).Reason);
        Assert.True(plugin.TryGetValue("y", "realpower", Now, out var y));
        Assert.Equal(20, y, 3);
        Assert.DoesNotContain(device.Requests, r => r.StartsWith("http://main.local/query?select"));
    }

    [Fact]
    public async Task AFailedPoll_IsReported_AndKeepsTheLastReadingToExpireOnItsOwn()
    {
        var fail = false;
        var (plugin, _) = Plugin(Settings("main"),
            url => url.Contains("show=series") ? Ok(Series)
                 : fail ? (HttpStatusCode.BadRequest, "{\"error\":\"invalid query. Invalid series: Main\"}")
                 : Ok(Live([Unix(Now), 10])),
            null, ("house", Bind("Main")));

        await plugin.PollAsync(Settings("main"), Now, CancellationToken.None);
        fail = true;
        await plugin.PollAsync(Settings("main"), Now.AddSeconds(10), CancellationToken.None);

        var status = plugin.Status(Config(Settings("main")));
        Assert.Equal(HealthLevel.Bad, status.Level);
        Assert.Contains("Invalid series: Main", status.Detail);
        Assert.True(plugin.TryGetValue("house", "realpower", Now.AddSeconds(10), out _));
        Assert.False(plugin.TryGetValue("house", "realpower", Now.AddHours(1), out _));
    }

    [Fact]
    public void SettingsBindFromThePluginsSection_AndFaultsAreNamed()
    {
        var plugin = new IotaWattPlugin();
        var cfg = new Config
        {
            Plugins = new Dictionary<string, object?>
            {
                ["iotawatt"] = new Dictionary<string, object?>
                {
                    ["Enabled"] = "true",
                    ["PollIntervalSeconds"] = "2",
                    ["Devices"] = new List<object?> { new Dictionary<string, object?> { ["Id"] = "main", ["Url"] = "10.0.0.5" } },
                },
            },
        };

        Assert.True(plugin.Enabled(cfg));
        Assert.Null(plugin.Misconfigured(cfg));
        Assert.Equal(5, plugin.RefreshSeconds);   // clamped: IoTaWatt does not sample while it answers

        Assert.Equal("No IoTaWatt is configured: add a device with its URL.",
            new IotaWattPlugin().Misconfigured(Config(new IotaWattSettings { Enabled = true })));
        Assert.Contains("share the id", new IotaWattPlugin().Misconfigured(Config(Settings("a", "A"))));
    }

    private static Config Config(IotaWattSettings s)
        => new() { Plugins = new Dictionary<string, object?> { ["iotawatt"] = PluginConfigBinder.ToNode(s) } };
}
