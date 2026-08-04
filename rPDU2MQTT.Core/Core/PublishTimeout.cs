namespace rPDU2MQTT.Core;

/// <summary>
/// Bounds how long we wait for a network publish, without cancelling the publish itself.
///
/// <para>
/// A QoS-1 publish waits for the broker to acknowledge it, and nothing in the protocol promises one ever
/// arrives — a broker dropping the message on an ACL, or a link that is up but not delivering, simply never
/// answers. Awaiting that unbounded does not fail, it <em>stops</em>: the pass never returns, so the timer
/// loop that would have started the next one never comes round again. Seen live, where the PDU publisher
/// and the energy-flow export each ran exactly one pass, hung inside it, and stayed that way with nothing in
/// the log — because a service waiting forever is not an error, it is just quiet.
/// </para>
/// <para>
/// The distinction this class exists for: the <b>wait</b> is abandoned, the <b>publish</b> is not cancelled.
/// An earlier attempt passed a timeout token straight into the MQTT client, and cancelling a publish
/// mid-flight tore the connection down — turning "not acknowledging" into "disconnected", which is strictly
/// worse and took a live bridge offline. So the task is left to finish or fail on its own, and only our
/// patience runs out.
/// </para>
/// </summary>
public static class PublishTimeout
{
    /// <summary>
    /// Await <paramref name="publish"/> for at most <paramref name="timeout"/>.
    /// </summary>
    /// <param name="publish">Starts the publish. Its own cancellation, if any, is the caller's business.</param>
    /// <param name="timeout">How long to wait before giving up on the acknowledgement.</param>
    /// <param name="topic">Named in the exception, so the failure points at something actionable.</param>
    /// <param name="ct">Shutdown. Cancelling this is not a broker fault and does not raise a timeout.</param>
    /// <exception cref="TimeoutException">The publish did not complete within <paramref name="timeout"/>.</exception>
    public static async Task RunAsync(Func<Task> publish, TimeSpan timeout, string topic, CancellationToken ct = default)
    {
        var task = publish();

        // An abandoned task that faults later would surface as an unobserved exception on the finalizer
        // thread, long after the message it belongs to stopped mattering. Watch it so it dies quietly.
        _ = task.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);

        using var expiry = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var delay = Task.Delay(timeout, expiry.Token);

        if (await Task.WhenAny(task, delay).ConfigureAwait(false) == task)
        {
            expiry.Cancel();                        // don't leave a timer pending for the full timeout
            await task.ConfigureAwait(false);       // observe it — a genuine publish failure still throws
            return;
        }

        // Shutting down is not the broker's fault, and must not be reported as one.
        ct.ThrowIfCancellationRequested();

        throw new TimeoutException(
            $"The broker did not acknowledge a publish to '{topic}' within {timeout.TotalSeconds:0}s. This pass "
          + "is abandoned and the next one will retry. A connection that is up but never acknowledges usually "
          + "means the broker is refusing the topic — check its ACL for this user.");
    }
}
