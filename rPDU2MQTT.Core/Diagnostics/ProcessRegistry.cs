namespace rPDU2MQTT.Core.Diagnostics;

/// <summary>The EmonCMS outcome a process carries with its registration.</summary>
public sealed record EmonCmsReport
{
    public bool? Ok { get; init; }
    public DateTime? LastSuccessUtc { get; init; }
    public string? LastError { get; init; }
    public int Count { get; init; }
}

/// <summary>One process's self-report — what the Status board lists.</summary>
public sealed record ProcessInfo
{
    public string Id { get; init; } = "";
    public string[] Roles { get; init; } = [];
    public string? Host { get; init; }
    public DateTime StartedUtc { get; init; }
    public string? Version { get; init; }
    public DateTime TimestampUtc { get; init; }
    public EmonCmsReport? EmonCms { get; init; }
}

/// <summary>
/// Each process's latest self-report.
///
/// <para>
/// In one process this is a list of one, and that is the honest shape of it — the grain existed so a split
/// deployment's GUI could list every role process. The registry stays because the Status board and the
/// diagnostics page read it, and because keeping the shape means a multi-process build could repopulate it
/// from elsewhere without either of those changing.
/// </para>
/// </summary>
public sealed class ProcessRegistry
{
    /// <summary>A consumer marks a process stale once its last registration is older than this.</summary>
    public const int StaleAfterSeconds = 45;

    /// <summary>Kept well past "stale", so the GUI can show a recently-gone process as stale before it drops.</summary>
    private const int PruneAfterSeconds = 300;

    private readonly object gate = new();
    private readonly Dictionary<string, ProcessInfo> processes = new(StringComparer.Ordinal);

    public void Register(ProcessInfo info)
    {
        if (string.IsNullOrEmpty(info.Id)) return;
        lock (gate) processes[info.Id] = info;
    }

    /// <summary>Every process registered recently. Long-dead ones are dropped rather than shown forever.</summary>
    public IReadOnlyList<ProcessInfo> Active()
    {
        var cutoff = DateTime.UtcNow.AddSeconds(-PruneAfterSeconds);
        lock (gate)
        {
            foreach (var id in processes.Where(kv => kv.Value.TimestampUtc < cutoff).Select(kv => kv.Key).ToList())
                processes.Remove(id);
            return processes.Values.ToList();
        }
    }
}
