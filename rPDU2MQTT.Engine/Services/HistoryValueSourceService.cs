using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;

namespace rPDU2MQTT.Services;

/// <summary>
/// Keeps <see cref="HistoryValueSource"/> refreshed while the fallback is switched on, and tells it which
/// nodes to ask about — every node the configured hierarchy names, since those are the ones that could
/// have a value read back for them.
/// </summary>
public sealed class HistoryValueSourceService : BackgroundService
{
    private readonly Config cfg;
    private readonly HistoryValueSource source;

    public HistoryValueSourceService(Config cfg, HistoryValueSource source)
    {
        this.cfg = cfg;
        this.source = source;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        Log.Information("History value fallback is on: a node nothing live reports will take the most recent "
                      + "value stored about it. Live readings always win.");
        source.Start();

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(60));
        while (await timer.WaitForNextTickAsync(stoppingToken))
            await source.RefreshAsync(stoppingToken);
    }
}
