using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// Keeps each contributed value source in step with the bindings that name it — a plugin's, or a built-in
/// that speaks the same contract (Home Assistant entities).
///
/// <para>
/// The same arrangement the MQTT ingest has always had: reconcile on a timer rather than wiring once at
/// startup, so adding or retargeting a binding in the GUI takes effect without a restart. A plugin
/// implements <see cref="IValueSourcePlugin.ReconcileAsync"/> and is handed exactly its own bindings; it
/// never walks the config looking for them, and never sees bindings belonging to another source type.
/// </para>
/// </summary>
public sealed class ValueSourcePluginHost : BackgroundService
{
    private readonly Config cfg;
    private readonly IntegrationRegistry registry;

    // What each source was last told, so an unchanged config is not re-applied every tick.
    private readonly Dictionary<string, string> applied = new(StringComparer.OrdinalIgnoreCase);

    // When each source was last reconciled, so a poller can be driven on its own cadence rather than only
    // when its bindings change.
    private readonly Dictionary<string, DateTime> lastRun = new(StringComparer.OrdinalIgnoreCase);

    public ValueSourcePluginHost(Config cfg, IntegrationRegistry registry)
    {
        this.cfg = cfg;
        this.registry = registry;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Five seconds rather than fifteen: the pass itself is a fingerprint comparison per source, and the
        // tick is now also what paces a polling source — a source asking to be read every 5s should get 5s
        // rather than the next multiple of the host's own cadence.
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        do
        {
            try { await Reconcile(stoppingToken, DateTime.UtcNow); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Error(ex, "Value-source plugin reconcile failed."); }
        }
        while (await Core.Ticks.Next(timer, stoppingToken));
    }

    /// <summary>One reconcile pass. Public so a test can drive it without a host.</summary>
    public Task Reconcile(CancellationToken ct) => Reconcile(ct, DateTime.UtcNow);

    /// <summary>Testable overload: decide what is due against an explicit "now".</summary>
    public async Task Reconcile(CancellationToken ct, DateTime nowUtc)
    {
        foreach (var source in registry.All.OfType<IValueSourcePlugin>())
        {
            var bindings = SourceBindings.For(cfg, source.SourceType);

            // Cheap change detection: a source that is already supplying the right bindings is left alone,
            // so a plugin's ReconcileAsync can be expensive (opening a connection, subscribing) without
            // that cost being paid every fifteen seconds.
            var fingerprint = string.Join('␟', bindings.Select(b => $"{b.NodeId}|{b.Key()}|{b.Source.Topic}|{b.Source.Feed}|{string.Join(',', b.Source.Settings.Select(kv => kv.Key + '=' + kv.Value))}"));
            var unchanged = applied.TryGetValue(source.SourceType, out var last) && last == fingerprint;

            // A poller reads by reconciling, so leaving it alone leaves its values frozen. It says how often
            // it wants to be called and is called that often whether or not anything was edited; a
            // subscriber (RefreshSeconds 0) still only hears about changes.
            var due = source.RefreshSeconds > 0
                   && (!lastRun.TryGetValue(source.SourceType, out var ran)
                       || (nowUtc - ran).TotalSeconds >= source.RefreshSeconds);
            if (unchanged && !due) continue;

            try
            {
                await source.ReconcileAsync(cfg, bindings, ct);
                applied[source.SourceType] = fingerprint;
                lastRun[source.SourceType] = nowUtc;

                // Only worth a line when something actually changed — a poller reconciles on every cadence
                // and would otherwise write the same sentence to the log all day.
                if (unchanged) continue;
                Log.Information($"Value source '{source.SourceType}': {bindings.Count} binding(s) across "
                              + $"{bindings.Select(b => b.NodeId).Distinct(StringComparer.OrdinalIgnoreCase).Count()} node(s).");
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                // Not recorded as applied, so the next tick tries again — a source that failed to take up
                // its bindings must not be left believing it has them.
                Log.Warning($"Value source '{source.SourceType}' could not take up its bindings: {ex.Message}");
            }
        }
    }
}
