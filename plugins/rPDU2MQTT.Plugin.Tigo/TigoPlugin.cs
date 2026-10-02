using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugin.Tigo;

/// <summary>
/// Tigo TS4 optimizers, read from a TAP's RS485 bus (#tigo). Each optimizer is a source a flow node can bind:
/// <c>{ Type: "tigo", Metric: "realpower", Settings: { Optimizer: "&lt;serial&gt;" } }</c>, with
/// <c>voltage</c>, <c>current</c> and <c>temperature</c> beside it. Energy follows from the power the way it
/// does for any other node, and the panels, strings and MPPTs are ordinary nodes wired in the hierarchy.
///
/// <para>
/// Written as a plugin on purpose: it references Core and nothing else, so it reaches the bridge only through
/// the contracts any third-party plugin has. The bridge ships it in <c>plugins/tigo/</c>.
/// </para>
/// </summary>
public sealed class TigoPlugin : IIntegration, IConfigurablePlugin, IValueSourcePlugin, INodeProvider, IStatusProvider,
    IIntegrationApi, ISingleOwnerLeaseUser
{
    public string Id => "tigo";
    public string DisplayName => "Tigo TAP";
    public IntegrationGroup Group => IntegrationGroup.Sources;

    public string SourceType => "tigo";
    public string SourceTypeLabel => "Tigo optimizer";
    /// <summary>Called every few seconds, not only on a binding change: it is also how edited settings are picked up.</summary>
    public int RefreshSeconds => 5;

    public Type ConfigType => typeof(TigoSettings);

    private TigoSettings settings = new();
    private string settingsSeen = "";
    private ISingleOwnerLease lease = new SoleOwnerLease();
    private readonly object gate = new();
    private readonly Dictionary<string, TigoConnectionRunner> runners = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> runnerPrints = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>(node, metric key) → (optimizer serial, field).</summary>
    private Dictionary<(string Node, string Key), (string Serial, string Field)> bound = new();

    public void ApplyConfig(object s) => settings = (TigoSettings)s;
    public void UseLease(ISingleOwnerLease lease) => this.lease = lease;

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

    /// <summary>The settings as saved now. The host binds them once at startup; a save later is read from here.</summary>
    private TigoSettings Current(Config cfg)
    {
        if (cfg.Plugins is null || !cfg.Plugins.TryGetValue(Id, out var raw) || raw is null) return settings;
        var print = raw is string str ? str : JsonSerializer.Serialize(raw);
        if (print == settingsSeen) return settings;
        settingsSeen = print;
        PluginConfigBinder.Bind(this, Id, cfg.Plugins);
        return settings;
    }

    // --- Reading the buses -------------------------------------------------------------------------------

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
    }

    /// <summary>Which reading a metric takes, unless the binding names one.</summary>
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

    /// <summary>The latest reading of one optimizer, and whether its TAP is still answering.</summary>
    private (OptimizerReading? Reading, bool TapAlive) Find(string serial, DateTime nowUtc)
    {
        OptimizerReading? best = null;
        var alive = false;
        foreach (var r in Runners())
        {
            if (r.Bus.LastAnswerUtc is { } answered && nowUtc - answered < TimeSpan.FromSeconds(60)) alive = true;
            var hit = r.Bus.Optimizers.FirstOrDefault(o => string.Equals(o.Serial, serial, StringComparison.OrdinalIgnoreCase));
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
        // Optimizers run on their panel's power, so they go quiet in the dark. While the TAP still answers,
        // a quiet optimizer is producing nothing — that is a true zero for power and current. Its voltage and
        // temperature are simply not known.
        if (alive && reading is not null && target.Field is "power" or "iin") return true;
        return false;
    }

    // --- Discovery, status, actions ---------------------------------------------------------------------

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
        var down = rs.Where(r => !r.Standby && !r.Connected).ToList();
        var optimizers = rs.Sum(r => r.Bus.Optimizers.Count);
        var others = rs.Where(r => r.Bus.OtherController).ToList();
        if (others.Count > 0)
            return new(HealthLevel.Warn, "Another controller on the bus",
                $"{string.Join(", ", others.Select(r => r.Settings.Id))}: a CCA is polling, so Poll mode is not transmitting. Switch to Listen.");
        if (down.Count > 0)
            return new(HealthLevel.Bad, "Not connected", string.Join("; ", down.Select(r => $"{r.Settings.Id}: {r.LastError ?? "connecting"}")));
        var silent = rs.Where(r => r.Bus.LastAnswerUtc is null || DateTime.UtcNow - r.Bus.LastAnswerUtc > TimeSpan.FromSeconds(60)).ToList();
        if (silent.Count > 0)
            return new(HealthLevel.Warn, "TAP not answering", string.Join("; ", silent.Select(r => $"{r.Settings.Id}: connected, no TAP answers seen"
                + (r.Settings.Kind == TigoMode.Listen ? " — is the CCA polling?" : r.Bus.GatewayId is null ? " — set the gateway id" : ""))));
        return new(HealthLevel.Good, $"{optimizers} optimizer(s)", $"{rs.Count} bus(es)");
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
                results.Add($"{c.Id}: {c.Host}:{c.Port} reachable");
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

    /// <summary>What the Solar Array page draws: the buses, and every optimizer with its latest reading.</summary>
    public object Snapshot(DateTime nowUtc)
    {
        var rs = Runners().ToList();
        return new
        {
            ok = true,
            staleSeconds = settings.StaleSeconds,
            connections = rs.Select(r => new
            {
                id = r.Settings.Id, name = r.Settings.Name ?? r.Settings.Id, mode = r.Settings.Kind.ToString().ToLowerInvariant(),
                connected = r.Connected, standby = r.Standby, error = r.LastError,
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
