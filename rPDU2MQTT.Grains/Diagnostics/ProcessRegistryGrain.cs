using rPDU2MQTT.Grains.Abstractions.Diagnostics;

namespace rPDU2MQTT.Grains.Diagnostics;

/// <summary>Holds each process's latest self-report; prunes long-dead ones. Replaces the MQTT heartbeat beacons.</summary>
public sealed class ProcessRegistryGrain : Grain, IProcessRegistryGrain
{
    // Keep entries well past "stale" so the GUI can still show a recently-gone process as stale before it drops.
    private const int PruneAfterSeconds = 300;

    private readonly Dictionary<string, ProcessInfo> processes = new(StringComparer.Ordinal);

    public Task Register(ProcessInfo info)
    {
        if (!string.IsNullOrEmpty(info.Id)) processes[info.Id] = info;
        return Task.CompletedTask;
    }

    public Task<List<ProcessInfo>> Active()
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-PruneAfterSeconds);
        foreach (var id in processes.Where(kv => kv.Value.TimestampUtc < cutoff).Select(kv => kv.Key).ToList())
            processes.Remove(id);
        return Task.FromResult(processes.Values.ToList());
    }
}
