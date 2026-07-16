using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Services;

/// <summary>
/// Periodically runs <see cref="EmonCmsFeedSync"/> in the Worker role when <c>EmonCMS.Feeds.AutoConfigure</c>
/// is on (#163). Always registered and self-gating each pass, so enabling it in the GUI (or the manual
/// "Provision now" button) takes effect without a restart.
/// </summary>
public sealed class EmonCmsFeedProvisioner : BackgroundService
{
    private readonly Config config;
    private readonly EmonCmsFeedSync sync;

    public EmonCmsFeedProvisioner(Config config, EmonCmsFeedSync sync)
    {
        this.config = config;
        this.sync = sync;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Slower than the poll — feed topology changes rarely, and each pass is several API calls.
        var period = TimeSpan.FromSeconds(Math.Max(30, config.Primary.PollInterval * 6));
        using var timer = new PeriodicTimer(period);
        do
        {
            var e = config.EmonCMS;   // read fresh each tick — live-reload the toggle/settings.
            if (e.Enabled && e.Feeds.AutoConfigure && !string.IsNullOrWhiteSpace(e.Url) && !string.IsNullOrWhiteSpace(e.ApiKey))
            {
                try
                {
                    var result = await sync.ReconcileAsync(stoppingToken);
                    if (!result.Ok) Log.Debug($"EmonCMS feed provisioning: {result.Message}");
                }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { Log.Warning($"EmonCMS feed provisioning failed: {ex.Message}"); }
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
