using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// Polls every device — a configured PDU, or one a plugin supplies — and publishes each snapshot on the bus.
///
/// <para>
/// This replaces a chain that existed to spread one poll across processes: an activator drove a PDU grain,
/// the grain polled and held the result, handed each device its own document, each device grain handed each
/// outlet its own, each outlet fed a measured node grain, a tree of node grains rolled the values up, and a
/// sync service polled the PDU grain every second to publish its snapshot onto the local bus. In one process
/// all of that is: read the device, publish the snapshot. Everything downstream already listens to the bus.
/// </para>
/// <para>
/// The roll-up the node grains computed is not lost — <c>FlowGraphBuilder</c> computes it from the same
/// snapshot and config, and always did. The grain tree was a second implementation of it whose only reader
/// was a diagnostics panel.
/// </para>
/// </summary>
public sealed class DevicePollService : BackgroundService
{
    private readonly Config cfg;
    private readonly IReadOnlyList<IDeviceReader> readers;
    private readonly IMessageBus bus;
    private readonly HealthState health;
    private readonly ISingleOwnerLease lease;
    private readonly IntegrationStatus status;

    private readonly Dictionary<string, DateTime> lastPoll = new(StringComparer.OrdinalIgnoreCase);
    // The failure currently being reported per device, so an outage logs once rather than every poll.
    private readonly Dictionary<string, string> failing = new(StringComparer.OrdinalIgnoreCase);

    public DevicePollService(
        Config cfg, IEnumerable<IDeviceReader> readers, IMessageBus bus, HealthState health,
        IntegrationStatus status, ISingleOwnerLease? lease = null)
    {
        this.cfg = cfg;
        this.readers = readers.ToList();
        this.bus = bus;
        this.health = health;
        this.status = status;
        this.lease = lease ?? new SoleOwnerLease();
    }

    /// <summary>Every device instance to poll: the configured PDUs, plus whatever plugins supply.</summary>
    private IEnumerable<string> Instances =>
        cfg.Pdus.Keys.Concat(readers.OfType<PluginDeviceReader>().SelectMany(r => r.InstanceIds))
                     .Distinct(StringComparer.OrdinalIgnoreCase);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            try { await Poll(stoppingToken); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Log.Error(ex, "Device poll pass failed."); }
        }
        while (await Ticks.Next(timer, stoppingToken));
    }

    /// <summary>One pass. Public so a test can drive it without a host.</summary>
    public async Task Poll(CancellationToken ct)
    {
        foreach (var id in Instances)
        {
            if (readers.FirstOrDefault(r => r.Handles(id, cfg)) is not { } reader) continue;

            var interval = reader.Interval(id, cfg);
            if (lastPoll.TryGetValue(id, out var last) && DateTime.UtcNow - last < interval) continue;
            lastPoll[id] = DateTime.UtcNow;

            // A device is a shared resource: many answer one client at a time, and every replica polling
            // independently is how reads start timing out.
            await lease.RunIfOwnerAsync($"device:{id}", async token =>
            {
                try
                {
                    var data = await reader.ReadAsync(id, cfg, token);
                    // Nothing to report is not "everything went to zero": leave the last snapshot to go
                    // stale, which is what marks the device unavailable downstream.
                    if (data is null) return;

                    await bus.PublishAsync(new PduSnapshot(id, DateTime.UtcNow, data), token);
                    health.RecordPollSuccess();
                    status.RecordSuccess(id, data.Devices.Sum(d => d.Outlets.Count));

                    if (failing.Remove(id))
                        Log.Information($"Device '{id}' is answering again.");
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    status.RecordFailure(id, ex.Message);
                    // Said once per outage, not once per poll: a device down for an hour should not be the
                    // only thing in the log.
                    if (!failing.TryGetValue(id, out var was) || was != ex.Message)
                    {
                        failing[id] = ex.Message;
                        Log.Error($"Device '{id}' poll failed: {ex.Message}. Its last readings will go stale "
                                + "rather than being republished as current.");
                    }
                }
            }, ct);
        }
    }
}
