using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Core;
using rPDU2MQTT.Grains.Abstractions.Cluster;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Runs on every silo (v3). Renews a short cluster-leadership lease on a timer and publishes the result into
/// <see cref="LeaderState"/>, which the run-once work (publishers/exporters) reads to self-gate. This is what
/// lets the fleet be homogeneous — identical instances scaled by replica count — instead of static
/// worker/api/ui roles: exactly one instance holds the lease and does the run-once work, and if it dies
/// another takes over within a lease.
/// </summary>
public sealed class LeaderRenewalService : BackgroundService
{
    private const int LeaseSeconds = 15;
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(5);

    private readonly IGrainFactory grains;
    private readonly LeaderState state;
    // Stable for this process's lifetime, unique across instances — the leader grain matches renewals by it.
    private readonly string id = $"{Environment.GetEnvironmentVariable("RPDU2MQTT_POD_NAME") ?? Environment.MachineName}:{Guid.NewGuid():N}";

    public LeaderRenewalService(IGrainFactory grains, LeaderState state)
    {
        this.grains = grains;
        this.state = state;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        bool? was = null;        // null = nothing reported yet, so the first outcome is always announced
        var complained = false;  // one line per outage, not one every five seconds

        do
        {
            bool now;
            try
            {
                now = await grains.GetGrain<ILeaderGrain>(0).Renew(id, LeaseSeconds);
                complained = false;
            }
            catch (Exception ex)
            {
                // Never assume leadership when the cluster is unreachable — but never lose the reason either.
                // This used to be a bare `catch { }`, and the cost of that silence was total: every run-once
                // service self-gates on this flag, so a failing renewal stopped the MQTT publish, the Home
                // Assistant discovery and the energy-flow export dead, with nothing in the log to say so and
                // a broker still showing yesterday's retained values as if they were current.
                now = false;
                if (!complained)
                {
                    complained = true;
                    Log.Warning($"Cluster leadership could not be renewed ({ex.GetType().Name}: {ex.Message}). "
                              + "This instance will not publish, export or run Home Assistant discovery until it "
                              + "recovers — those all run on the leader only.");
                }
            }

            if (was != now)
            {
                Log.Information(now
                    ? "Cluster leadership acquired — this instance runs the publishers, exporters and discovery."
                    : "Cluster leadership lost or held elsewhere — this instance publishes nothing until it returns.");
                was = now;
            }
            state.IsLeader = now;
        }
        while (await SafeWait(timer, stoppingToken));

        state.IsLeader = false;
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
