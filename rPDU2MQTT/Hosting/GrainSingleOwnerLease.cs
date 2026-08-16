using Orleans;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Grains.Abstractions.Cluster;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// <see cref="ISingleOwnerLease"/> backed by a per-key grain, so "one owner of this resource" holds across
/// a real cluster rather than only within one process.
///
/// <para>
/// This is the one piece of distributed coordination an integration is allowed to need, and it never learns
/// what provides it — the seam is in Core, this implementation is in the host, and swapping Orleans for
/// anything else means replacing this file. <c>LeaderState</c> is the same arrangement for leadership.
/// </para>
/// </summary>
public sealed class GrainSingleOwnerLease : ISingleOwnerLease
{
    // Long enough that a slow poll does not lose the lease mid-work, short enough that a dead process's
    // devices are taken over within a few polls rather than left silent.
    private const int LeaseSeconds = 30;

    private readonly IGrainFactory grains;
    private readonly string id;

    public GrainSingleOwnerLease(IGrainFactory grains, ProcessIdentity self)
    {
        this.grains = grains;
        id = self.Id;
    }

    public async Task<bool> RunIfOwnerAsync(string key, Func<CancellationToken, Task> work, CancellationToken ct)
    {
        bool owns;
        try { owns = await grains.GetGrain<IOwnerLeaseGrain>(key).Claim(id, LeaseSeconds); }
        catch (Exception ex)
        {
            // A cluster that cannot be asked is not permission to double up: a second process polling a
            // serial gateway is precisely the failure this exists to prevent.
            Log.Debug($"Owner lease for '{key}' could not be claimed ({ex.Message}); skipping this pass.");
            return false;
        }

        if (!owns) return false;
        await work(ct);
        return true;
    }
}
