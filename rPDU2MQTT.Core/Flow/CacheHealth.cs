namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Whether the shared cache is actually answering, as opposed to being configured.
///
/// <para>
/// The distinction matters because an unreachable cache is invisible from the outside: the bridge keeps
/// polling, keeps publishing, and quietly falls back to accumulating energy in memory. The counters then
/// stop being shared between replicas and stop surviving a restart — which downstream reads as a meter
/// reset. So this is set from a real round-trip, and the Status board shows it.
/// </para>
/// </summary>
public sealed class CacheHealth
{
    private volatile string? error;

    /// <summary>
    /// Whether anything has actually tried yet. Without this, a configured-but-idle cache reported as
    /// UNREACHABLE purely because nothing had used it — indistinguishable from one that is genuinely
    /// down, which is the same "never reported vs stopped reporting" confusion this class exists to avoid.
    /// </summary>
    public bool Attempted { get; private set; }

    /// <summary>True once an operation has succeeded; false after one has failed.</summary>
    public bool Reachable { get; private set; }

    /// <summary>Why the last attempt failed, when it did.</summary>
    public string? Error => error;

    public void Succeeded() { Attempted = true; Reachable = true; error = null; }
    public void Failed(string message) { Attempted = true; Reachable = false; error = message; }
}
