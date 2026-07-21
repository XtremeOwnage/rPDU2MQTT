namespace rPDU2MQTT.Core;

/// <summary>
/// How this process asks to be restarted (#192).
/// <para>
/// Stopping the process is the obvious way and the wrong one under Kubernetes: the container exits 0, the
/// pod is reported <c>Completed</c> — which reads as "this workload finished", not "please run it again" —
/// and the kubelet restarts it on an exponential backoff that reaches minutes. So where the orchestrator can
/// replace the pod, ask it to; only fall back to stopping when there's nothing to ask.
/// </para>
/// </summary>
public interface IProcessRestarter
{
    /// <summary>
    /// Restart this process as promptly as the environment allows. Returns a description of what was done,
    /// for the caller to report; never throws.
    /// </summary>
    Task<string> RestartAsync(string reason, CancellationToken cancellationToken = default);
}

/// <summary>
/// Whether this process is stopping because it asked to be restarted, and the exit code that says so.
/// <para>
/// A restart-by-stopping must not exit 0. Exit 0 means "the job is done" — it's what puts a pod in
/// <c>Completed</c>, and it makes a deliberate restart indistinguishable from a clean finish in any log or
/// dashboard. <see cref="ExitCode"/> is <c>75</c> (the BSD <c>EX_TEMPFAIL</c>: "temporary failure, retry").
/// </para>
/// </summary>
public static class SelfRestart
{
    /// <summary>Exit code used when the process is stopping so that something will start it again.</summary>
    public const int ExitCode = 75;

    private static int requested;

    /// <summary>Has a restart been requested? Read by the host to pick its exit code.</summary>
    public static bool Requested => Volatile.Read(ref requested) != 0;

    /// <summary>Why, for the log line that accompanies the exit.</summary>
    public static string? Reason { get; private set; }

    /// <summary>Mark this process as stopping in order to be restarted.</summary>
    public static void Mark(string reason)
    {
        Reason = reason;
        Interlocked.Exchange(ref requested, 1);
    }

    /// <summary>The exit code this process should return: 75 when it wants to come back, 0 otherwise.</summary>
    public static int ExitCodeFor(bool restartRequested) => restartRequested ? ExitCode : 0;

    /// <summary>Reset — for tests.</summary>
    internal static void Clear()
    {
        Interlocked.Exchange(ref requested, 0);
        Reason = null;
    }
}
