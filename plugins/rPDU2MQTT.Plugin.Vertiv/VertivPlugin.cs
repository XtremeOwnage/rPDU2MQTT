using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Plugin.Vertiv;

/// <summary>Vertiv rPDU: instances, polling, writes, status and probe.</summary>
public sealed class VertivPlugin : IIntegration, IStatusProvider, IPduInstanceProvider
{
    private ISnapshotCache? snapshots;
    private IDeviceReader? reader;

    public PduAttachment Attach(Config cfg, ISnapshotCache snapshots)
    {
        var registry = new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg));
        this.snapshots = snapshots;
        reader = new VertivDeviceReader(registry);
        return new(registry, reader);
    }

    public string Id => "vertiv";
    public string DisplayName => "Vertiv rPDU";
    public IntegrationGroup Group => IntegrationGroup.Sources;

    public bool Enabled(Config c) => c.ConfiguredPdus.Any();

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
