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
        do
        {
            try { state.IsLeader = await grains.GetGrain<ILeaderGrain>(0).Renew(id, LeaseSeconds); }
            catch { state.IsLeader = false; }   // can't reach the cluster → never assume leadership
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
