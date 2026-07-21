using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.EmonCms;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Grains.EmonCms;

/// <summary>
/// EmonCMS's configuration as an actor (singleton, key 0) — see <see cref="IEmonCmsFeedGrain"/>.
/// <para>
/// The reconciliation itself stays in <see cref="EmonCmsFeedSync"/> (Engine), which knows the API; this grain
/// owns <i>when</i> and <i>how often</i> it happens, and is the reason it can only happen once at a time.
/// Because a grain call is serialized per activation, a periodic poke arriving while a human's "Provision
/// now" is still running waits its turn instead of racing it.
/// </para>
/// </summary>
public sealed class EmonCmsFeedGrain : Grain, IEmonCmsFeedGrain
{
    /// <summary>Feed topology changes rarely and a pass is several API calls — don't hammer someone's server.</summary>
    private static readonly TimeSpan MinInterval = TimeSpan.FromSeconds(60);

    private readonly Config config;
    private readonly EmonCmsFeedSync sync;
    private readonly ILogger<EmonCmsFeedGrain> log;

    private EmonFeedReport last = new();
    private DateTime lastRunUtc = DateTime.MinValue;

    public EmonCmsFeedGrain(Config config, EmonCmsFeedSync sync, ILogger<EmonCmsFeedGrain> log)
    {
        this.config = config;
        this.sync = sync;
        this.log = log;
    }

    public Task<EmonFeedReport> Last() => Task.FromResult(last);

    public async Task<EmonFeedReport> Reconcile(bool force)
    {
        var e = config.EmonCMS;
        if (!e.Enabled) return Report(false, "EmonCMS is disabled.");
        if (!force && !e.Feeds.AutoConfigure) return Report(false, "Feed auto-configuration is off.");
        if (string.IsNullOrWhiteSpace(e.Url) || string.IsNullOrWhiteSpace(e.ApiKey))
            return Report(false, "EmonCMS Url and a read/write ApiKey are required for feed provisioning.");

        // A human asking is always worth a call; a timer asking is not.
        if (!force && DateTime.UtcNow - lastRunUtc < MinInterval) return last;
        lastRunUtc = DateTime.UtcNow;

        log.LogDebug("EmonCMS: reconciling feeds ({Trigger}).", force ? "requested" : "periodic");
        try
        {
            var result = await sync.ReconcileAsync(CancellationToken.None);
            last = new EmonFeedReport
            {
                Ok = result.Ok,
                Message = result.Message,
                FeedsCreated = result.FeedsCreated,
                ProcessesSet = result.ProcessesSet,
                VirtualFeeds = result.VirtualFeeds,
                AtUtc = DateTime.UtcNow,
            };

            if (result.Ok && (result.FeedsCreated > 0 || result.ProcessesSet > 0 || result.VirtualFeeds > 0))
                log.LogInformation("EmonCMS: created {Feeds} feed(s), {Processes} processlist(s), {Virtual} virtual feed(s).",
                    result.FeedsCreated, result.ProcessesSet, result.VirtualFeeds);
            else if (!result.Ok)
                log.LogWarning("EmonCMS feed provisioning: {Message}", result.Message);

            return last;
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "EmonCMS feed provisioning failed.");
            return Report(false, $"Feed provisioning failed: {ex.Message}");
        }
    }

    public async Task<EmonFeedReport> DeleteAll()
    {
        try
        {
            var result = await sync.DeleteAllAsync(CancellationToken.None);
            log.LogInformation("EmonCMS: delete-all requested — {Message}", result.Message);
            return last = new EmonFeedReport { Ok = result.Ok, Message = result.Message, AtUtc = DateTime.UtcNow };
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "EmonCMS feed delete failed.");
            return Report(false, $"Delete feeds failed: {ex.Message}");
        }
    }

    /// <summary>A refusal or a failure — recorded like any other outcome so the GUI can show why nothing happened.</summary>
    private EmonFeedReport Report(bool ok, string message)
        => last = new EmonFeedReport { Ok = ok, Message = message, AtUtc = DateTime.UtcNow };
}
