using rPDU2MQTT.Services.Gui;

namespace rPDU2MQTT.Plugin.Locations;

/// <summary>Publishes to Home Assistant on the configured schedule, on the lease owner only.</summary>
internal sealed class HaSyncRunner(Func<LocationEndpoints> endpoints, Func<Config> config, ISingleOwnerLease lease)
{
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(30);
    private readonly CancellationTokenSource stop = new();
    private Task? loop;
    private string? seen;
    private DateTime last = DateTime.MinValue;

    public DateTime? LastAt { get; private set; }
    public bool LastOk { get; private set; } = true;
    public string? LastMessage { get; private set; }

    public void Start() => loop ??= Task.Run(() => Run(stop.Token));

    public async Task StopAsync()
    {
        stop.Cancel();
        if (loop is not null) { try { await loop; } catch { /* stopping */ } }
    }

    private async Task Run(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(Tick, ct);
                var cfg = config();
                if (Due(cfg, DateTime.UtcNow))
                    await lease.RunIfOwnerAsync("locations:ha-sync", c => Once(cfg, c), ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { return; }
            catch (Exception ex) { LastOk = false; LastMessage = ex.Message; }
        }
    }

    /// <summary>Whether a publish is due; records what it saw.</summary>
    internal bool Due(Config cfg, DateTime now)
    {
        var modes = LocationSettings.Of(cfg).HomeAssistant ?? new();
        if (string.IsNullOrWhiteSpace(cfg.HASS.Url) || string.IsNullOrWhiteSpace(cfg.HASS.Token)) return false;
        switch (modes.Schedule)
        {
            case HaSyncMode.Interval:
                if (now - last < TimeSpan.FromMinutes(Math.Max(5, modes.IntervalMinutes))) return false;
                last = now;
                return true;
            case HaSyncMode.OnChange:
                var print = ConfigSchema.ToJson(cfg);
                if (print == seen) return false;
                seen = print;
                return true;
            default:
                return false;
        }
    }

    private async Task Once(Config cfg, CancellationToken ct)
    {
        var (ok, message, _) = await endpoints().SyncAsync(cfg, apply: true, ct);
        (LastAt, LastOk, LastMessage) = (DateTime.UtcNow, ok, message);
    }
}
