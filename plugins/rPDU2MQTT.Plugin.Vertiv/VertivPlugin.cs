using System.Text.Json;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugin.Vertiv;

/// <summary>Vertiv rPDU: instances, polling, writes, status and probe.</summary>
public sealed class VertivPlugin : IIntegration, IStatusProvider, IPduInstanceProvider, IConfigurablePlugin
{
    private ISnapshotCache? snapshots;
    private IDeviceReader? reader;
    private VertivSettings settings = new();
    private string settingsSeen = "";

    public Type ConfigType => typeof(VertivSettings);
    public void ApplyConfig(object s) => settings = (VertivSettings)s;

    public PduAttachment Attach(Config cfg, ISnapshotCache snapshots)
    {
        var registry = new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg), () => Current(cfg).Enabled);
        this.snapshots = snapshots;
        reader = new VertivDeviceReader(registry);
        return new(registry, reader);
    }

    /// <summary>Rebinds settings when the saved config changes.</summary>
    private VertivSettings Current(Config cfg)
    {
        if (cfg.Plugins is null || !cfg.Plugins.TryGetValue(Id, out var raw) || raw is null) return settings;
        var print = raw is string str ? str : JsonSerializer.Serialize(raw);
        if (print == settingsSeen) return settings;
        settingsSeen = print;
        PluginConfigBinder.Bind(this, Id, cfg.Plugins);
        return settings;
    }

    public string Id => "vertiv";
    public string DisplayName => "Vertiv rPDU";
    public IntegrationGroup Group => IntegrationGroup.Sources;

    public bool Enabled(Config c) => Current(c).Enabled && c.ConfiguredPdus.Any();

    /// <summary>Freshness of each configured PDU, judged against its own poll interval.</summary>
    public IntegrationHealth Status(Config c)
    {
        if (!Enabled(c)) return new(HealthLevel.Off, "No PDUs configured");

        var now = DateTime.UtcNow;
        var fresh = new List<string>();
        var stale = new List<string>();
        var silent = new List<string>();

        foreach (var (id, pdu) in c.ConfiguredPdus)
        {
            var snapshot = snapshots?.Get(id);
            if (snapshot is null) { silent.Add(id); continue; }
            if (SnapshotFreshness.IsStale(snapshot.TimestampUtc, pdu.PollInterval, now)) stale.Add(id);
            else fresh.Add(id);
        }

        if (stale.Count == 0 && silent.Count == 0)
            return new(HealthLevel.Good, "Polling", $"{fresh.Count} PDU(s)");

        var detail = string.Join(" · ",
            new[]
            {
                stale.Count > 0 ? $"stale: {string.Join(", ", stale)}" : null,
                silent.Count > 0 ? $"no data yet: {string.Join(", ", silent)}" : null,
            }.Where(x => x is not null));

        return fresh.Count > 0
            ? new(HealthLevel.Warn, $"{fresh.Count} of {c.ConfiguredPdus.Count()} polling", detail)
            : new(HealthLevel.Bad, "Not polling", detail);
    }

    /// <summary>Reads each configured PDU now.</summary>
    public async Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
    {
        if (!Enabled(c)) return (true, "no PDUs configured");
        if (reader is null) return (false, "no PDU reader in this process");

        var reached = new List<string>();
        var failed = new List<string>();

        foreach (var id in c.ConfiguredPdus.Select(kv => kv.Key))
        {
            try
            {
                var data = await reader.ReadAsync(id, c, ct);
                if (data is null) { failed.Add($"{id}: nothing returned"); continue; }
                var outlets = data.Devices?.Sum(d => d.Outlets?.Count ?? 0) ?? 0;
                reached.Add($"{id}: {data.Devices?.Count ?? 0} device(s), {outlets} outlet(s)");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex) { failed.Add($"{id}: {ex.Message}"); }
        }

        return failed.Count == 0
            ? (true, string.Join(" · ", reached))
            : (false, string.Join(" · ", failed.Concat(reached)));
    }
}
