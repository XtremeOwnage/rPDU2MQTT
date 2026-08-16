using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Integrations.Vertiv;

/// <summary>
/// The Vertiv rPDU itself, as an integration — so the hardware this bridge was written for appears in the
/// registry, the startup banner, the Status board and <c>/health/integrations</c> alongside everything
/// else, instead of being the one thing that is special.
///
/// <para>
/// The poll deliberately stays in <c>PduGrain</c>. That grain is not just a timer: it is the single
/// cluster-wide activation per PDU, and it supervises the device, outlet and group child grains that
/// outlet writes are routed through. Moving the read out here would take the supervision with it and break
/// control — the opposite of an improvement, for the sake of symmetry.
/// </para>
/// <para>
/// The follow-up that would finish this properly is inverting the dependency rather than moving it: have
/// <c>PduGrain</c> poll <i>through</i> <see cref="IDeviceSourcePlugin"/> instead of the Vertiv client
/// directly. A new vendor would then inherit the single activation and the child supervision rather than
/// having to reimplement them, which is the thing that actually makes a second make of hardware equal to
/// the first.
/// </para>
/// </summary>
public sealed class VertivIntegration : IIntegration, IStatusProvider
{
    private readonly Config cfg;
    private readonly ISnapshotCache snapshots;
    private readonly PduInstanceRegistry? registry;

    public VertivIntegration(Config cfg, ISnapshotCache snapshots, PduInstanceRegistry? registry = null)
    {
        this.cfg = cfg;
        this.snapshots = snapshots;
        this.registry = registry;
    }

    public string Id => "vertiv";
    public string DisplayName => "Vertiv rPDU";
    public IntegrationGroup Group => IntegrationGroup.Sources;

    public bool Enabled(Config c) => c.Pdus.Count > 0;

    public string? Misconfigured(Config c)
        => c.Pdus.Count > 0 && c.Pdus.Values.All(p => string.IsNullOrWhiteSpace(p.Connection?.Host))
            ? "Every configured PDU is missing Connection.Host."
            : null;

    /// <summary>
    /// Healthy when every configured PDU has answered recently. Judged per instance against that
    /// instance's own poll interval, so a five-minute poller is not called stale by a thirty-second one's
    /// standard.
    /// </summary>
    public IntegrationHealth Status(Config c)
    {
        if (!Enabled(c)) return new(HealthLevel.Off, "No PDUs configured");
        if (Misconfigured(c) is { } fault) return new(HealthLevel.Bad, "Misconfigured", fault);

        var now = DateTime.UtcNow;
        var fresh = new List<string>();
        var stale = new List<string>();
        var silent = new List<string>();

        foreach (var (id, pdu) in c.Pdus)
        {
            var snapshot = snapshots.Get(id);
            if (snapshot is null) { silent.Add(id); continue; }
            if (SnapshotFreshness.IsStale(snapshot.TimestampUtc, pdu.PollInterval, now)) stale.Add(id);
            else fresh.Add(id);
        }

        if (stale.Count == 0 && silent.Count == 0)
            return new(HealthLevel.Good, "Polling", $"{fresh.Count} PDU(s)");

        // Never polled and stopped answering are different problems: one is "check the address", the other
        // is "it was working". Naming which instances are affected is what makes either actionable.
        var detail = string.Join(" · ",
            new[]
            {
                stale.Count > 0 ? $"stale: {string.Join(", ", stale)}" : null,
                silent.Count > 0 ? $"no data yet: {string.Join(", ", silent)}" : null,
            }.Where(x => x is not null));

        return fresh.Count > 0
            ? new(HealthLevel.Warn, $"{fresh.Count} of {c.Pdus.Count} polling", detail)
            : new(HealthLevel.Bad, "Not polling", detail);
    }

    /// <summary>
    /// Actually reach each PDU, rather than reporting how old the last snapshot is. Freshness is what the
    /// board watches continuously; a probe is what an operator triggers when it is already wrong, and at
    /// that point "the last poll was 4 minutes ago" is the question, not the answer.
    /// </summary>
    public async Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
    {
        if (!Enabled(c)) return (true, "no PDUs configured");
        if (Misconfigured(c) is { } fault) return (false, fault);
        if (registry is null) return (false, "no PDU client in this process");

        var reached = new List<string>();
        var failed = new List<string>();

        foreach (var (id, pdu) in registry.All)
        {
            try
            {
                var data = await pdu.GetRootData_Public(ct);
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
