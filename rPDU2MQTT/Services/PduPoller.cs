using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Services;

/// <summary>
/// v2 producer: polls the PDU on its interval and publishes a <see cref="PduSnapshot"/> to the bus.
/// For now there is a single instance (today's one PDU); multi-instance comes in a later phase.
/// Consumers still read the PDU directly until they are migrated onto the bus.
/// </summary>
public sealed class PduPoller : BackgroundService
{
    private readonly Config cfg;
    private readonly PDU pdu;
    private readonly IMessageBus bus;
    private readonly string instanceId;

    public PduPoller(Config cfg, PDU pdu, IMessageBus bus)
    {
        this.cfg = cfg;
        this.pdu = pdu;
        this.bus = bus;
        instanceId = string.IsNullOrWhiteSpace(cfg.PDU?.Connection?.Host) ? "pdu" : cfg.PDU!.Connection!.Host!;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(1, cfg.PDU.PollInterval));
        using var timer = new PeriodicTimer(interval);

        while (true)
        {
            try
            {
                var data = await pdu.GetRootData_Public(stoppingToken);
                await bus.PublishAsync(new PduSnapshot(instanceId, DateTime.UtcNow, data), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Error(ex, $"{nameof(PduPoller)} poll failed.");
            }

            try
            {
                if (!await timer.WaitForNextTickAsync(stoppingToken))
                    break;
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}
