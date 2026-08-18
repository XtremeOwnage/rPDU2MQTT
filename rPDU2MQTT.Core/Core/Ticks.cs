namespace rPDU2MQTT.Core;

/// <summary>
/// Waiting for the next tick of a periodic loop.
/// </summary>
public static class Ticks
{
    /// <summary>
    /// The next tick, with shutdown treated as an ending rather than a fault.
    ///
    /// <para>
    /// Every timed service in this codebase needs this and fifteen of them had written it out. The reason
    /// it cannot simply be inlined is subtle enough to be worth having once: in
    /// <c>do { … } while (await timer.WaitForNextTickAsync(ct))</c> the await sits in the while-condition,
    /// which is <i>outside</i> the try — so cancelling on shutdown throws past the loop's own handler and
    /// the host reports a background-service crash on every clean stop.
    /// </para>
    /// </summary>
    public static async Task<bool> Next(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
