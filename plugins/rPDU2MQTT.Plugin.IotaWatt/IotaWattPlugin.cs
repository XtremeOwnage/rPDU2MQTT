using System.Globalization;
using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Plugin.IotaWatt;

/// <summary>
/// IoTaWatt read directly over its local query API, with no EmonCMS or MQTT in between.
///
/// <para>
/// A node binds <c>{ Type: iotawatt, Metric: realpower, Settings: { Series: Main } }</c>, plus
/// <c>Device</c> when more than one IoTaWatt is configured. Each poll is one <c>select</c> per device for
/// every bound series, so adding bindings does not add requests — IoTaWatt stops sampling while it answers.
/// </para>
/// <para>
/// Energy has no running counter on the device, so it is asked for as watt-hours over a range: since today's
/// midnight for a <c>period</c> binding, and since a fixed instant for a <c>lifetime</c> one. That instant is
/// pinned on the first poll and remembered, so the counter only ever rises.
/// </para>
/// </summary>
public sealed class IotaWattPlugin
    : IIntegration, IConfigurablePlugin, IValueSourcePlugin, IIntegrationApi, IStatusProvider,
      IFlowValueDiagnostics, IWithheldSources, IPluginHostUser, IPluginStoreUser
{
    private static readonly TimeSpan SeriesEvery = TimeSpan.FromMinutes(5);
    private const string EpochStore = "energy-since";
    private const string LabelPrefix = "IoTaWatt '";

    private readonly HttpClient http;
    private IotaWattSettings settings = new();
    private string settingsSeen = "";
    private Config cfg = new();
    private Func<IPeriodAuditor?> auditorOf = () => null;
    private IPeriodAuditor? auditor => auditorOf();
    private IPluginStore store = new NullPluginStore();

    private readonly FlowValueCache latest = new();
    private readonly Dictionary<string, DeviceState> devices = new(StringComparer.OrdinalIgnoreCase);
    private IReadOnlyList<SourceBinding> bindings = [];
    private volatile WithheldSource[] unresolved = [];
    private int resolved;

    private sealed class DeviceState
    {
        public IReadOnlyList<IotaWattSeries> Series = [];
        public DateTime SeriesAtUtc = DateTime.MinValue;
        public DateTime LastPollUtc = DateTime.MinValue;
        public string? Error;
    }

    /// <summary>Loaded as a plugin; the host supplies its services through <see cref="UseHost"/>.</summary>
    public IotaWattPlugin() : this(null) { }

    public IotaWattPlugin(HttpMessageHandler? handler, IPeriodAuditor? auditor = null)
    {
        http = handler is null ? new HttpClient() : new HttpClient(handler);
        http.Timeout = Timeout.InfiniteTimeSpan;   // per request, from TimeoutSeconds
        auditorOf = () => auditor;
    }

    public void UseHost(IPluginHost host)
    {
        cfg = host.Config;
        auditorOf = () => host.Auditor;
    }

    public void UseStore(IPluginStore store) => this.store = store;

    // --- Identity -------------------------------------------------------------------------------------

    public string Id => "iotawatt";
    public string DisplayName => "IoTaWatt";
    public IntegrationGroup Group => IntegrationGroup.Sources;

    public string SourceType => "iotawatt";
    public string SourceTypeLabel => "IoTaWatt series";

    public Type ConfigType => typeof(IotaWattSettings);
    public void ApplyConfig(object s) => settings = (IotaWattSettings)s;

    public int RefreshSeconds => Math.Clamp(settings.PollIntervalSeconds, 5, 3600);

    public bool Enabled(Config c) => Current(c).Enabled;

    public string? Misconfigured(Config c)
    {
        var s = Current(c);
        if (!s.Enabled) return null;
        if (s.Devices.Any(d => d.Enabled && string.IsNullOrWhiteSpace(d.Id)))
            return "A device has no id.";
        if (!Active(s).Any())
            return "No IoTaWatt is configured: add a device with its URL.";
        var dup = s.Devices.GroupBy(d => d.Id.Trim(), StringComparer.OrdinalIgnoreCase).FirstOrDefault(g => g.Count() > 1);
        return dup is not null ? $"Two devices share the id '{dup.Key}'." : null;
    }

    /// <summary>Rebinds settings when the saved config changes.</summary>
    private IotaWattSettings Current(Config c)
    {
        if (c.Plugins is null || !c.Plugins.TryGetValue(Id, out var raw) || raw is null) return settings;
        var print = raw is string str ? str : JsonSerializer.Serialize(raw);
        if (print == settingsSeen) return settings;
        settingsSeen = print;
        PluginConfigBinder.Bind(this, Id, c.Plugins);
        return settings;
    }

    private static IEnumerable<IotaWattDevice> Active(IotaWattSettings s)
        => s.Devices.Where(d => d.Enabled && !string.IsNullOrWhiteSpace(d.Id) && !string.IsNullOrWhiteSpace(d.Url));

    private static string BaseUrl(IotaWattDevice d)
    {
        var url = d.Url.Trim().TrimEnd('/');
        return url.Contains("://", StringComparison.Ordinal) ? url : "http://" + url;
    }

    public IntegrationHealth Status(Config c)
    {
        var s = Current(c);
        if (!s.Enabled) return new(HealthLevel.Off, "Disabled");
        if (Misconfigured(c) is { } fault) return new(HealthLevel.Bad, "Misconfigured", fault);
        if (bindings.Count == 0) return new(HealthLevel.Warn, "Nothing bound", "No node binds an IoTaWatt series.");

        var states = Active(s).Select(d => (d.Id, State: devices.GetValueOrDefault(d.Id))).ToList();
        var failing = states.Where(x => x.State?.Error is not null).Select(x => $"{x.Id}: {x.State!.Error}").ToList();
        if (failing.Count > 0) return new(HealthLevel.Bad, "Cannot read", string.Join("; ", failing));
        if (states.Any(x => x.State is null || x.State.LastPollUtc == DateTime.MinValue))
            return new(HealthLevel.Warn, "No data yet", $"{bindings.Count} binding(s), not yet read");

        var missing = unresolved.Length;
        return missing > 0
            ? new(HealthLevel.Warn, "Some series not found", $"{missing} of {bindings.Count} binding(s) cannot be read")
            : new(HealthLevel.Good, "Reading", $"{resolved} of {bindings.Count} binding(s) · {states.Count} device(s)");
    }

    // --- Values ---------------------------------------------------------------------------------------

    public bool TryGetValue(string nodeId, string metric, out double value) => latest.TryGetValue(nodeId, metric, out value);

    public bool TryGetValue(string nodeId, string metric, DateTime nowUtc, out double value)
        => latest.TryGetValue(nodeId, metric, nowUtc, out value);

    public IReadOnlyCollection<(string Node, string Metric)> ReportedKeys => latest.Keys;

    public bool TryDescribe(string nodeId, string metric, out FlowReading reading) => latest.TryDescribe(nodeId, metric, out reading);

    public IReadOnlyCollection<WithheldSource> Withheld =>
        [.. unresolved, .. ((IWithheldSources)latest).Withheld,
         .. (auditor?.Withheld ?? []).Where(w => w.Source.StartsWith(LabelPrefix, StringComparison.Ordinal)
                && bindings.Any(b => string.Equals(b.NodeId, w.Node, StringComparison.OrdinalIgnoreCase)))];

    public async Task ReconcileAsync(Config c, IReadOnlyList<SourceBinding> bound, CancellationToken ct)
    {
        cfg = c;
        var s = Current(c);
        Bind(bound);
        if (!s.Enabled || Misconfigured(c) is not null) return;
        await PollAsync(s, DateTime.UtcNow, ct);
    }

    /// <summary>Take up these bindings without polling.</summary>
    public void Bind(IReadOnlyList<SourceBinding> bound) => bindings = bound;

    /// <summary>One read of every device. Public so a test can drive a pass at a fixed time.</summary>
    public async Task PollAsync(IotaWattSettings s, DateTime nowUtc, CancellationToken ct)
    {
        var active = Active(s).GroupBy(d => d.Id.Trim(), StringComparer.OrdinalIgnoreCase).Select(g => g.First()).ToList();
        var missing = new List<WithheldSource>();
        var found = 0;

        // Readings no longer produced by any binding are dropped, so a deleted binding stops at once.
        var live = bindings
            .SelectMany(b => FlowMetricKey.Keys(FlowMetricKey.ForAccumulation(b.Source.Metric, b.Source.Accumulation), b.Source.Direction)
                .Select(k => (b.NodeId, Key: k)))
            .ToHashSet();
        foreach (var stale in latest.Keys.Where(k => !live.Contains((k.Node, k.Metric))).ToList())
            latest.Remove(stale.Node, stale.Metric);

        var byDevice = new Dictionary<string, List<SourceBinding>>(StringComparer.OrdinalIgnoreCase);
        foreach (var b in bindings)
        {
            var named = b.Setting("Device")?.Trim();
            IotaWattDevice? device = string.IsNullOrEmpty(named)
                ? active.Count == 1 ? active[0] : null
                : active.FirstOrDefault(d => string.Equals(d.Id.Trim(), named, StringComparison.OrdinalIgnoreCase));
            if (device is null)
            {
                missing.Add(new(b.NodeId, "iotawatt", b.Metric, string.IsNullOrEmpty(named)
                    ? $"{active.Count} IoTaWatts are configured; set Settings.Device to say which one this reads."
                    : $"No enabled IoTaWatt has the id '{named}'."));
                continue;
            }
            if (!byDevice.TryGetValue(device.Id.Trim(), out var list)) byDevice[device.Id.Trim()] = list = [];
            list.Add(b);
        }

        foreach (var device in active)
        {
            if (!byDevice.TryGetValue(device.Id.Trim(), out var mine)) continue;
            if (!devices.TryGetValue(device.Id.Trim(), out var state)) devices[device.Id.Trim()] = state = new();
            found += await PollDeviceAsync(s, device, state, mine, missing, nowUtc, ct);
        }

        resolved = found;
        unresolved = [.. missing];
    }

    private async Task<int> PollDeviceAsync(IotaWattSettings s, IotaWattDevice device, DeviceState state,
        List<SourceBinding> mine, List<WithheldSource> missing, DateTime nowUtc, CancellationToken ct)
    {
        var baseUrl = BaseUrl(device);
        if (state.Series.Count == 0 || nowUtc - state.SeriesAtUtc >= SeriesEvery)
        {
            var (ok, body) = await GetAsync(IotaWattWire.SeriesUrl(baseUrl), s, ct);
            if (!ok) { state.Error = body; return 0; }
            try { state.Series = IotaWattWire.Series(body); }
            catch (JsonException ex) { state.Error = $"{baseUrl}: unreadable series list ({ex.Message})"; return 0; }
            state.SeriesAtUtc = nowUtc;
        }

        // Which column each binding reads, and over which range: live, or energy since an instant.
        var wanted = new List<(SourceBinding Binding, IotaWattColumn Column, string Unit, string? Since)>();
        foreach (var b in mine)
        {
            var name = b.Setting("Series")?.Trim();
            if (string.IsNullOrEmpty(name))
            {
                missing.Add(new(b.NodeId, "iotawatt", b.Metric, "Set Settings.Series to the IoTaWatt input or output to read."));
                continue;
            }
            var series = state.Series.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            if (series is null)
            {
                missing.Add(new(b.NodeId, $"{LabelPrefix}{device.Id}' series '{name}'", b.Metric,
                    $"IoTaWatt '{device.Id}' has no input or output called '{name}'."));
                continue;
            }
            var (modifier, unit, why) = IotaWattWire.ModifierFor(series, b.Source.Metric);
            if (modifier is null)
            {
                missing.Add(new(b.NodeId, $"{LabelPrefix}{device.Id}' series '{series.Name}'", b.Metric, why!));
                continue;
            }
            var since = modifier == "wh"
                ? FlowMetricKey.IsPeriod(b.Source.Accumulation) ? "d" : Since(device, nowUtc)
                : null;
            wanted.Add((b, new IotaWattColumn(series.Name, modifier), unit, since));
        }

        var found = 0;
        string? error = null;
        foreach (var group in wanted.GroupBy(w => w.Since))
        {
            var columns = group.Select(w => w.Column).Distinct().ToList();
            var url = group.Key is null
                ? IotaWattWire.LiveUrl(baseUrl, columns)
                : IotaWattWire.EnergyUrl(baseUrl, columns, group.Key);
            var (ok, body) = await GetAsync(url, s, ct);
            if (!ok) { error = body; continue; }

            Dictionary<IotaWattColumn, IotaWattValue> values;
            try { values = IotaWattWire.Values(body, columns, timed: group.Key is null); }
            catch (JsonException ex) { error = $"{baseUrl}: unreadable query response ({ex.Message})"; continue; }

            foreach (var (b, column, unit, _) in group)
            {
                if (!values.TryGetValue(column, out var v))
                {
                    missing.Add(new(b.NodeId, $"{LabelPrefix}{device.Id}' series '{column.Series}'", b.Metric,
                        "IoTaWatt answered with no value for this series in the last 30 seconds."));
                    continue;
                }
                if (Set(b, device, column, unit, v, nowUtc)) found++;
            }
        }

        state.Error = error;
        if (error is null) state.LastPollUtc = nowUtc;
        return found;
    }

    private bool Set(SourceBinding b, IotaWattDevice device, IotaWattColumn column, string unit, IotaWattValue v, DateTime nowUtc)
    {
        // The binding's Unit wins, for an output whose units IoTaWatt reports differently from what it holds.
        var u = !string.IsNullOrWhiteSpace(b.Source.Unit) ? b.Source.Unit : unit;
        var value = v.Value * FlowUnits.ToCanonicalFactor(b.Source.Metric, u) * b.Source.Scale;

        if (auditor is not null && PeriodCounterAudit.Applies(b.Source))
        {
            var agg = cfg.EnergyFlow.Aggregation;
            var periodKey = EnergyPeriod.KeyFor(nowUtc, EnergyPeriod.Resolve(agg.PeriodTimeZone), agg.PeriodStartHour);
            bool allowed;
            try { allowed = auditor.Allow(b.NodeId, $"{LabelPrefix}{device.Id}' series '{column.Series}'", b.Source.Direction, periodKey, value); }
            catch (Exception ex)
            {
                Log.Debug($"IoTaWatt: could not consult the period audit ({ex.Message}).");
                allowed = true;
            }
            if (!allowed) return false;
        }

        var at = v.AtUtc ?? nowUtc;
        foreach (var (key, x) in FlowMetricKey.Fan(
                     FlowMetricKey.ForAccumulation(b.Source.Metric, b.Source.Accumulation), b.Source.Direction, value))
            latest.Set(b.NodeId, key, x, b.Source.StaleAfterSeconds, at);
        return true;
    }

    /// <summary>Where a lifetime energy counter starts: the configured instant, or the first poll's, remembered.</summary>
    private string Since(IotaWattDevice device, DateTime nowUtc)
    {
        if (!string.IsNullOrWhiteSpace(device.EnergySince)) return device.EnergySince.Trim();

        var pinned = store.Read(EpochStore);
        if (pinned.TryGetValue(device.Id.Trim(), out var since) && since.Length > 0) return since;

        var unix = new DateTimeOffset(nowUtc).ToUnixTimeSeconds();
        since = (unix - unix % 5).ToString(CultureInfo.InvariantCulture);
        store.Write(EpochStore, new Dictionary<string, string>(pinned) { [device.Id.Trim()] = since });
        return since;
    }

    private async Task<(bool Ok, string Body)> GetAsync(string url, IotaWattSettings s, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(s.TimeoutSeconds, 1, 120)));
        var host = new Uri(url).GetLeftPart(UriPartial.Authority);
        try
        {
            using var response = await http.GetAsync(url, timeout.Token);
            var body = await response.Content.ReadAsStringAsync(timeout.Token);
            return response.IsSuccessStatusCode
                ? (true, body)
                : (false, $"{host}: HTTP {(int)response.StatusCode} {IotaWattWire.Error(body)}");
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (OperationCanceledException) { return (false, $"{host}: no answer within {s.TimeoutSeconds}s"); }
        catch (Exception ex) { return (false, $"{host}: {ex.Message}"); }
    }

    // --- Actions --------------------------------------------------------------------------------------

    public IReadOnlyList<IntegrationAction> Actions =>
    [
        new("series", "List series",
            "List each IoTaWatt's inputs and outputs with their current value, so a binding can pick one.",
            ActionEffect.Read,
            async (ctx, ct) =>
            {
                var s = Current(ctx.Config);
                var result = new List<object>();
                foreach (var device in Active(s))
                {
                    var baseUrl = BaseUrl(device);
                    var (ok, body) = await GetAsync(IotaWattWire.SeriesUrl(baseUrl), s, ct);
                    if (!ok) { result.Add(new { device = device.Id, ok = false, message = body, series = Array.Empty<object>() }); continue; }

                    var series = IotaWattWire.Series(body);
                    var columns = series.Select(x => new IotaWattColumn(x.Name, "")).ToList();
                    var values = new Dictionary<IotaWattColumn, IotaWattValue>();
                    if (columns.Count > 0 && await GetAsync(IotaWattWire.LiveUrl(baseUrl, columns), s, ct) is (true, var q))
                        values = IotaWattWire.Values(q, columns, timed: true);

                    result.Add(new
                    {
                        device = device.Id, ok = true, message = $"{series.Count} series",
                        series = series.Select((x, i) => new
                        {
                            name = x.Name, unit = x.Unit,
                            value = values.TryGetValue(columns[i], out var v) ? v.Value : (double?)null,
                        }),
                    });
                }
                return new { ok = result.Count > 0, message = result.Count == 0 ? "No IoTaWatt is configured." : null, devices = result };
            }),
    ];

    public async Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
    {
        var s = Current(c);
        var active = Active(s).ToList();
        if (active.Count == 0) return (false, "no IoTaWatt configured");

        var ok = true;
        var lines = new List<string>();
        foreach (var device in active)
        {
            var (good, body) = await GetAsync(IotaWattWire.SeriesUrl(BaseUrl(device)), s, ct);
            if (!good) { ok = false; lines.Add(body); continue; }
            try { lines.Add($"{device.Id} · {IotaWattWire.Series(body).Count} series"); }
            catch (JsonException) { ok = false; lines.Add($"{device.Id}: not an IoTaWatt series list"); }
        }
        return (ok, string.Join("; ", lines));
    }
}
