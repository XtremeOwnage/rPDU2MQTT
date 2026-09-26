using HiveMQtt.Client;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// Keeps the leader lease (#506): takes it once this process can do the work, renews it while leading,
/// and lets it go on shutdown so a standby takes over at once.
///
/// <para>
/// Registered last, so it is stopped first: on SIGTERM this process stops leading before anything else
/// shuts down, the energy totals are written while it still holds the lease, and the standby is polling
/// within a second rather than when the old pod has finished tearing down.
/// </para>
/// </summary>
public sealed class LeaderLeaseService : IHostedService
{
    /// <summary>Set by the chart on the processes that may lead, when a graceful rollout is configured.</summary>
    public const string EnableVariable = "RPDU2MQTT_LEADER_LEASE";

    /// <summary>Where to keep the lease when the configuration does not enable the Cache: the chart's own Valkey.</summary>
    public const string ConnectionVariable = "RPDU2MQTT_LEADER_LEASE_CONNECTION";

    /// <summary>The lease's length in seconds; 15 unless set.</summary>
    public const string SecondsVariable = "RPDU2MQTT_LEADER_LEASE_SECONDS";

    private readonly LeaderElection election;
    private readonly ILeaseStore store;
    private readonly IHiveMQClient mqtt;
    private readonly LeaderState state;
    private CancellationTokenSource? stopping;
    private Task? loop;

    public LeaderLeaseService(ILeaseStore store, LeaderState state, IHiveMQClient mqtt, string keyPrefix)
    {
        this.store = store;
        this.mqtt = mqtt;
        this.state = state;
        var seconds = int.TryParse(Environment.GetEnvironmentVariable(SecondsVariable), out var s) && s > 0 ? s : 15;
        var owner = $"{Environment.MachineName}:{Guid.NewGuid():N}";
        election = new LeaderElection(store, state, (keyPrefix ?? "") + "leader", owner, TimeSpan.FromSeconds(seconds),
                                      log: m => Log.Information(m));
    }

    /// <summary>Asked for by the environment, and something to keep it in.</summary>
    public static bool Requested
        => string.Equals(Environment.GetEnvironmentVariable(EnableVariable), "true", StringComparison.OrdinalIgnoreCase);

    public Task StartAsync(CancellationToken cancellationToken)
    {
        Log.Information($"Leader lease: coordinating through {election.Key} ({election.Ttl.TotalSeconds:0}s). "
                      + "This process polls, publishes and records only while it holds it.");
        stopping = new CancellationTokenSource();
        loop = Task.Run(() => RunAsync(stopping.Token), CancellationToken.None);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            TimeSpan wait;
            // A pod that is still connecting to the broker would take over and then publish nothing.
            try { wait = election.Tick(mayLead: mqtt.IsConnected()); }
            catch (Exception ex) { Log.Warning($"Leader lease: {ex.Message}"); wait = LeaderElection.AcquireEvery; }
            try { await Task.Delay(wait, ct); } catch (OperationCanceledException) { break; }
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        stopping?.Cancel();
        if (loop is not null) { try { await loop; } catch { /* stopping */ } }

        var wasLeader = state.IsLeader;
        election.Resign();
        if (!wasLeader) return;

        // If a standby takes over, leave the broker cleanly: the last will would otherwise mark every entity
        // unavailable just after the new leader said it was online. With nobody taking over, exit as before
        // and let the will say so.
        var until = DateTime.UtcNow.AddSeconds(3);
        while (DateTime.UtcNow < until && !cancellationToken.IsCancellationRequested)
        {
            try
            {
                if (store.Holder(election.Key) is { } holder && holder != election.Owner)
                {
                    Log.Information("Leader lease: a standby has taken over; disconnecting from the broker cleanly.");
                    try { await mqtt.DisconnectAsync(); } catch (Exception ex) { Log.Debug($"Clean disconnect failed: {ex.Message}"); }
                    return;
                }
            }
            catch { return; }
            try { await Task.Delay(200, cancellationToken); } catch (OperationCanceledException) { return; }
        }
    }
}
