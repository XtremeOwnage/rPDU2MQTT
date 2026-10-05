using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>Tigo TS4 optimizers read from a TAP's RS485 bus.</summary>
public sealed class TigoPlugin : IIntegration, IConfigurablePlugin, IValueSourcePlugin, INodeProvider, IStatusProvider,
    IIntegrationApi, ISingleOwnerLeaseUser, IGuiPageProvider, IPluginStoreUser, INodeManager
{
    public string Id => "tigo";
    public string DisplayName => "Tigo TAP";
    public IntegrationGroup Group => IntegrationGroup.Sources;

    public IReadOnlyList<GuiPage> Pages { get; } =
    [
        new("solar-array", "Solar Array", "Energy Flow", "☀", "Plugins.tigo.Strings,Plugins.tigo.StringPanels,Plugins.tigo.Mppts,Plugins.tigo.GroupPanels"),
        new("panel-types", "Panel Types", "Energy Flow", "▦", "Plugins.tigo.PanelTypes"),
    ];
    public string? PageAsset(string file) => GuiPageAssets.Read(typeof(TigoPlugin).Assembly, file);
    public IReadOnlyList<ManagedNodeRule> ManagedNodes => [new(SourceType: SourceType), new(Tag: "pv-string")];
    public IReadOnlyList<string> PageSettings { get; } = ["PanelTypes", "Strings", "StringPanels", "Mppts", "GroupPanels"];

    public string SourceType => "tigo";
    public string SourceTypeLabel => "Tigo optimizer";
    /// <summary>Also how edited settings are picked up.</summary>
    public int RefreshSeconds => 5;

    public Type ConfigType => typeof(TigoSettings);

    private TigoSettings settings = new();
    private string settingsSeen = "";
    private ISingleOwnerLease lease = new SoleOwnerLease();
    private IPluginStore store = new NullPluginStore();
    private DateTime lastSaved = DateTime.MinValue;
    private static readonly TimeSpan SaveEvery = TimeSpan.FromSeconds(30);
    private readonly object gate = new();
    private readonly Dictionary<string, TigoConnectionRunner> runners = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> runnerPrints = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<(string Node, string Key), (string Serial, string Field)> bound = new();

    public void ApplyConfig(object s) => settings = (TigoSettings)s;
    public void UseLease(ISingleOwnerLease lease) => this.lease = lease;
    public void UseStore(IPluginStore store) => this.store = store;

    public bool Enabled(Config cfg) => Current(cfg).Enabled;

    public string? Misconfigured(Config cfg)
    {
        var s = Current(cfg);
        if (!s.Enabled) return null;
        if (!s.Connections.Any(c => c.Enabled && !string.IsNullOrWhiteSpace(c.Host)))
            return "No TAP bus is configured: add a connection with the gateway's host and port.";
        var dup = s.Connections.GroupBy(c => c.Id, StringComparer.OrdinalIgnoreCase).FirstOrDefault(g => g.Count() > 1);
        return dup is not null ? $"Two connections share the id '{dup.Key}'." : null;
    }

    /// <summary>Rebinds settings when the saved config changes.</summary>
    private TigoSettings Current(Config cfg)
    {
        if (cfg.Plugins is null || !cfg.Plugins.TryGetValue(Id, out var raw) || raw is null) return settings;
        var print = raw is string str ? str : JsonSerializer.Serialize(raw);
        if (print == settingsSeen) return settings;
        settingsSeen = print;
        PluginConfigBinder.Bind(this, Id, cfg.Plugins);
        return settings;
    }

    public async Task ReconcileAsync(Config cfg, IReadOnlyList<SourceBinding> bindings, CancellationToken ct)
    {
        var s = Current(cfg);
        var wanted = s.Enabled
            ? s.Connections.Where(c => c.Enabled && !string.IsNullOrWhiteSpace(c.Host) && !string.IsNullOrWhiteSpace(c.Id))
                           .GroupBy(c => c.Id, StringComparer.OrdinalIgnoreCase).Select(g => g.First()).ToList()
            : [];

        List<TigoConnectionRunner> stopping = [];
        lock (gate)
        {
            foreach (var id in runners.Keys.ToList())
            {
                var still = wanted.FirstOrDefault(c => string.Equals(c.Id, id, StringComparison.OrdinalIgnoreCase));
                if (still is not null && runnerPrints[id] == TigoConnectionRunner.Fingerprint(still)) continue;
                stopping.Add(runners[id]);
                runners.Remove(id);
                runnerPrints.Remove(id);
            }
            foreach (var c in wanted.Where(c => !runners.ContainsKey(c.Id)))
            {
                var runner = new TigoConnectionRunner(c);
                Restore(runner);
                runners[c.Id] = runner;
                runnerPrints[c.Id] = TigoConnectionRunner.Fingerprint(c);
                runner.Start(lease);
            }

            var map = new Dictionary<(string, string), (string, string)>();
            foreach (var b in bindings)
            {
                if (b.Setting("Optimizer") is not { Length: > 0 } serial) continue;
                map[(b.NodeId, b.Key())] = (serial.Trim(), FieldFor(b.Source.Metric, b.Setting("Field")));
            }
            bound = map;
        }
        foreach (var r in stopping) await r.StopAsync();
        if (DateTime.UtcNow - lastSaved >= SaveEvery) { lastSaved = DateTime.UtcNow; Save(); }
    }

    // Names and last readings survive a restart: the CCA sends the node table only when it starts.
    private static readonly JsonSerializerOptions StoreJson = new();

    private void Restore(TigoConnectionRunner r)
    {
        var names = new List<(ushort, ushort, string)>();
        foreach (var (key, serial) in store.Read("serials:" + r.Settings.Id))
            if (key.Split(':') is [var gw, var node] && ushort.TryParse(gw, System.Globalization.NumberStyles.HexNumber, null, out var g)
                && ushort.TryParse(node, out var n)) names.Add((g, n, serial));
        var saved = new List<OptimizerReading>();
        foreach (var json in store.Read("readings:" + r.Settings.Id).Values)
        {
            try { if (JsonSerializer.Deserialize<OptimizerReading>(json, StoreJson) is { } o) saved.Add(o); }
            catch (JsonException) { }
        }
        r.Bus.Restore(names, saved);
    }

    internal void Save()
    {
        foreach (var r in Runners().Where(r => r.Connected && !r.Standby))
        {
            store.Write("serials:" + r.Settings.Id, r.Bus.Serials.ToDictionary(x => $"{x.Gw:X4}:{x.Node}", x => x.Serial));
            store.Write("readings:" + r.Settings.Id, r.Bus.Optimizers.ToDictionary(o => o.Serial, o => JsonSerializer.Serialize(o, StoreJson)));
        }
    }

    public static string FieldFor(string? metric, string? field) => (field ?? "").Trim().ToLowerInvariant() switch
    {
        "vin" or "vout" or "iin" or "power" or "temp" or "duty" or "rssi" => field!.Trim().ToLowerInvariant(),
        _ => (metric ?? "").ToLowerInvariant() switch
        {
            "voltage" => "vin",
            "current" => "iin",
            "temperature" => "temp",
            _ => "power",
        },
    };

    private static double Read(PowerReport r, string field) => field switch
    {
        "vin" => r.VoltsIn,
        "vout" => r.VoltsOut,
        "iin" => r.AmpsIn,
        "temp" => r.TemperatureC,
        "duty" => r.DutyPercent,
        "rssi" => r.Rssi,
        _ => r.Watts,
    };

    private IEnumerable<TigoConnectionRunner> Runners() { lock (gate) return runners.Values.ToList(); }

    /// <summary>Matches the 16-hex serial, or the label form <c>4-DFA5A5Y</c> (7th nibble, last 6 hex, check letter).</summary>
    internal static bool SameOptimizer(string configured, string serial)
    {
        configured = configured.Trim();
        if (string.Equals(configured, serial, StringComparison.OrdinalIgnoreCase)) return true;
        if (Label.Match(configured) is not { Success: true } m || serial.Length != 16) return false;
        return char.ToUpperInvariant(serial[6]) == m.Groups[1].Value[0]
            && serial.EndsWith(m.Groups[2].Value, StringComparison.OrdinalIgnoreCase);
    }

    private static readonly System.Text.RegularExpressions.Regex Label =
        new(@"^([0-9A-F])-([0-9A-F]{6})[A-Z]$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

    private (OptimizerReading? Reading, bool TapAlive) Find(string serial, DateTime nowUtc)
    {
        OptimizerReading? best = null;
        var alive = false;
        foreach (var r in Runners())
        {
            if (r.Bus.LastAnswerUtc is { } answered && nowUtc - answered < TimeSpan.FromSeconds(60)) alive = true;
            var hit = r.Bus.Optimizers.FirstOrDefault(o => SameOptimizer(serial, o.Serial));
            if (hit is not null && (best is null || hit.AtUtc > best.AtUtc)) best = hit;
        }
        return (best, alive);
    }

    public bool TryGetValue(string nodeId, string metric, out double value)
    {
        value = 0;
        (string Serial, string Field) target;
        lock (gate) { if (!bound.TryGetValue((nodeId, metric), out target)) return false; }
        var now = DateTime.UtcNow;
        var (reading, alive) = Find(target.Serial, now);
        if (reading is not null && now - reading.AtUtc <= TimeSpan.FromSeconds(Math.Max(10, settings.StaleSeconds)))
        {
            value = Read(reading.Report, target.Field);
            return true;
        }
        // Quiet optimizer on a live TAP: zero power and current.
        if (alive && reading is not null && target.Field is "power" or "iin") return true;
        return false;
    }

    public Task<IReadOnlyList<DiscoveredNode>> DiscoverAsync(Config cfg, string? search, CancellationToken ct)
    {
        var found = Runners().SelectMany(r => r.Bus.Optimizers)
            .GroupBy(o => o.Serial, StringComparer.OrdinalIgnoreCase).Select(g => g.OrderByDescending(o => o.AtUtc).First())
            .Where(o => string.IsNullOrWhiteSpace(search) || o.Serial.Contains(search.Trim(), StringComparison.OrdinalIgnoreCase))
            .OrderBy(o => o.Serial, StringComparer.OrdinalIgnoreCase)
            .Select(o => new DiscoveredNode(o.Serial, $"Optimizer {o.Serial}", "realpower", "W", Math.Round(o.Report.Watts, 1), "solar",
                "tigo_" + o.Serial.ToLowerInvariant()))
            .ToList();
        return Task.FromResult<IReadOnlyList<DiscoveredNode>>(found);
    }

    public IntegrationHealth Status(Config cfg)
    {
        var s = Current(cfg);
        if (!s.Enabled) return new(HealthLevel.Off, "Disabled");
        if (Misconfigured(cfg) is { } fault) return new(HealthLevel.Bad, "Misconfigured", fault);
        var rs = Runners().ToList();
        if (rs.Count == 0) return new(HealthLevel.Warn, "Starting");
        if (rs.All(r => r.Standby)) return new(HealthLevel.Good, "Standby", "Another process owns the TAP gateway(s).");
        var now = DateTime.UtcNow;
        var states = rs.Select(r => (Runner: r, State: State(r, now))).ToList();
        var worst = states.MaxBy(x => Severity(x.State.Level));
        if (worst.State.Level == HealthLevel.Good)
            return new(HealthLevel.Good, $"TAP answering · {rs.Sum(r => r.Bus.Optimizers.Count)} optimizer(s)", string.Join("; ", states.Select(x => Line(x.Runner, x.State))));
        return new(worst.State.Level, worst.State.Summary, string.Join("; ", states.Select(x => Line(x.Runner, x.State))));
    }

    public async Task<(bool Ok, string Detail)> ProbeAsync(Config cfg, CancellationToken ct)
    {
        var s = Current(cfg);
        if (s.Connections.Count == 0) return (false, "No TAP bus is configured.");
        var results = new List<string>();
        var ok = true;
        foreach (var c in s.Connections.Where(c => c.Enabled))
        {
            try
            {
                using var client = new System.Net.Sockets.TcpClient();
                using var t = CancellationTokenSource.CreateLinkedTokenSource(ct);
                t.CancelAfter(TimeSpan.FromSeconds(4));
                await client.ConnectAsync(c.Host, c.Port, t.Token);
                var r = Runners().FirstOrDefault(x => string.Equals(x.Settings.Id, c.Id, StringComparison.OrdinalIgnoreCase));
                if (r is null) { ok = false; results.Add($"{c.Id}: {c.Host}:{c.Port} reachable, not read yet"); continue; }
                var state = State(r, DateTime.UtcNow);
                if (state.Level != HealthLevel.Good) ok = false;
                results.Add(Line(r, state));
            }
            catch (Exception ex) { ok = false; results.Add($"{c.Id}: {c.Host}:{c.Port} — {ex.Message}"); }
        }
        return (ok, string.Join("; ", results));
    }

    public IReadOnlyList<IntegrationAction> Actions =>
    [
        new("optimizers", "Optimizers", "Every optimizer seen on the TAP buses, with its latest reading.", ActionEffect.Read,
            (ctx, ct) => Task.FromResult<object?>(Snapshot(DateTime.UtcNow))),
    ];

    internal sealed record BusState(HealthLevel Level, string Summary, string Detail);

    internal BusState State(TigoConnectionRunner r, DateTime nowUtc)
    {
        if (r.Standby) return new(HealthLevel.Good, "Standby", "another process reads this gateway");
        if (!r.Connected) return new(HealthLevel.Bad, "Not connected", r.LastError ?? "connecting");
        if (r.Bus.OtherController && r.Settings.Kind == TigoMode.Poll)
            return new(HealthLevel.Warn, "Another controller on the bus", "a CCA is polling, so Poll mode is not transmitting; switch to Listen");
        if (r.SilentSeconds(nowUtc) is { } quiet)
            return new(HealthLevel.Warn, "No serial data", $"connected to {r.Settings.Host}:{r.Settings.Port}, no bytes from the RS485 side in {quiet} s; check A/B wiring and the gateway's serial settings (38400 8N1, raw TCP)");
        if (r.Bus.Frames == 0)
            return r.BytesReceived == 0
                ? new(HealthLevel.Warn, "Waiting for data", $"connected to {r.Settings.Host}:{r.Settings.Port}, nothing received yet")
                : new(HealthLevel.Warn, "No TAP frames", $"{r.BytesReceived} bytes from the gateway, none decode as TAP frames; check the baud rate (38400 8N1) and that its protocol is None");
        if (r.Bus.LastAnswerUtc is not { } answered || nowUtc - answered > Unanswered)
            return new(HealthLevel.Warn, "TAP not answering", $"{r.Bus.Frames} frames, no TAP answer in the last {Unanswered.TotalSeconds:0} s"
                + (r.Settings.Kind == TigoMode.Listen ? "; is the CCA polling?" : r.Bus.GatewayId is null ? "; set the gateway id" : ""));
        var seen = r.Bus.Optimizers.Count;
        var reporting = r.Bus.Optimizers.Count(o => (nowUtc - o.AtUtc).TotalSeconds <= settings.StaleSeconds);
        return new(HealthLevel.Good, "TAP answering", $"TAP {r.Bus.GatewayId:X4} answered {(nowUtc - answered).TotalSeconds:0} s ago; {seen} optimizer(s) seen, {reporting} reporting"
            + (seen == 0 ? " (optimizers report only while their panels have light)" : ""));
    }

    private static readonly TimeSpan Unanswered = TimeSpan.FromSeconds(60);
    private static int Severity(HealthLevel l) => l switch { HealthLevel.Bad => 2, HealthLevel.Warn => 1, _ => 0 };
    private static string Line(TigoConnectionRunner r, BusState s) => $"{r.Settings.Name ?? r.Settings.Id}: {s.Summary} — {s.Detail}";

    public object Snapshot(DateTime nowUtc)
    {
        var rs = Runners().ToList();
        return new
        {
            ok = true,
            message = rs.Count == 0 ? "No TAP bus is running." : string.Join("; ", rs.Select(r => Line(r, State(r, nowUtc)))),
            staleSeconds = settings.StaleSeconds,
            connections = rs.Select(r => new
            {
                id = r.Settings.Id, name = r.Settings.Name ?? r.Settings.Id, mode = r.Settings.Kind.ToString().ToLowerInvariant(),
                connected = r.Connected, standby = r.Standby, error = r.LastError,
                state = State(r, nowUtc) is var st ? new { level = st.Level.ToString().ToLowerInvariant(), summary = st.Summary, detail = st.Detail } : null,
                bytes = r.BytesReceived, silentSeconds = r.SilentSeconds(nowUtc),
                gatewayId = r.Bus.GatewayId is { } g ? g.ToString("X4") : null,
                frames = r.Bus.Frames, powerReports = r.Bus.PowerReports, polls = r.Bus.Polls, unanswered = r.Bus.Unanswered,
                otherController = r.Bus.OtherController,
                lastAnswerSeconds = r.Bus.LastAnswerUtc is { } a ? (double?)Math.Round((nowUtc - a).TotalSeconds, 1) : null,
            }),
            optimizers = rs.SelectMany(r => r.Bus.Optimizers.Select(o => new
            {
                serial = o.Serial, connection = r.Settings.Id, nodeId = o.NodeId, named = !o.Serial.StartsWith("node-", StringComparison.Ordinal),
                vin = Math.Round(o.Report.VoltsIn, 2), vout = Math.Round(o.Report.VoltsOut, 2), iin = Math.Round(o.Report.AmpsIn, 3),
                power = Math.Round(o.Report.Watts, 1), temp = Math.Round(o.Report.TemperatureC, 1),
                duty = Math.Round(o.Report.DutyPercent, 1), rssi = o.Report.Rssi,
                ageSeconds = Math.Round((nowUtc - o.AtUtc).TotalSeconds, 1), reports = o.Reports,
            })).OrderBy(o => o.serial, StringComparer.OrdinalIgnoreCase),
        };
    }
}
