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

    public ValueSourcePluginHost(Config cfg, IntegrationRegistry registry)
    {
        this.cfg = cfg;
        this.registry = registry;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        do
        {
            try { await Reconcile(stoppingToken); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Error(ex, "Value-source plugin reconcile failed."); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    /// <summary>One reconcile pass. Public so a test can drive it without a host.</summary>
    public async Task Reconcile(CancellationToken ct)
    {
        foreach (var source in registry.All.OfType<IValueSourcePlugin>())
        {
            var bindings = SourceBindings.For(cfg, source.SourceType);

            // Cheap change detection: a source that is already supplying the right bindings is left alone,
            // so a plugin's ReconcileAsync can be expensive (opening a connection, subscribing) without
            // that cost being paid every fifteen seconds.
            var fingerprint = string.Join('␟', bindings.Select(b => $"{b.NodeId}|{b.Key()}|{b.Source.Topic}|{string.Join(',', b.Source.Settings.Select(kv => kv.Key + '=' + kv.Value))}"));
            if (applied.TryGetValue(source.SourceType, out var last) && last == fingerprint) continue;

            try
            {
                await source.ReconcileAsync(cfg, bindings, ct);
                applied[source.SourceType] = fingerprint;
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

    /// <summary>
    /// The tick wait, with shutdown treated as an ending rather than a fault. The await used to sit in the
    /// while-condition outside the try, so cancelling on shutdown threw past the handler and the host
    /// reported a background service crash on every clean stop.
    /// </summary>
    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }

}
