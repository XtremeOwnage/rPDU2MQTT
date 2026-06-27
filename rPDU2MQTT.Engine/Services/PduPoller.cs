using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Services;

/// <summary>
/// v2 producer for a single PDU instance: polls on its interval and publishes a <see cref="PduSnapshot"/>
/// (tagged with the instance id) to the bus. Created and owned by <see cref="InstanceManager"/>;
/// Start/Stop map to loading/unloading the instance.
/// </summary>
public sealed class PduPoller
{
    private readonly string instanceId;
    private readonly PDU pdu;
    private readonly int pollIntervalSeconds;
    private readonly IMessageBus bus;
    private readonly HealthState health;
    private readonly CancellationTokenSource cts = new();
    private Task loop = Task.CompletedTask;

    public PduPoller(string instanceId, PDU pdu, int pollIntervalSeconds, IMessageBus bus, HealthState health)
    {
        this.instanceId = instanceId;
        this.pdu = pdu;
        this.pollIntervalSeconds = pollIntervalSeconds;
        this.bus = bus;
        this.health = health;
    }

    public void Start() => loop = RunAsync(cts.Token);

    public async Task StopAsync()
    {
        await cts.CancelAsync();
        try { await loop; } catch (OperationCanceledException) { /* expected */ }
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(Math.Max(1, pollIntervalSeconds)));

        while (true)
        {
            try
            {
                var data = await pdu.GetRootData_Public(cancellationToken);
                await bus.PublishAsync(new PduSnapshot(instanceId, DateTime.UtcNow, data), cancellationToken);

                // A successful poll is the readiness signal: we can reach the PDU.
                health.RecordPollSuccess();
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Error(ex, $"PduPoller '{instanceId}' poll failed.");
            }

            try
            {
                if (!await timer.WaitForNextTickAsync(cancellationToken))
                    break;
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}
