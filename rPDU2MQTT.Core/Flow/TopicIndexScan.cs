namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Waits for the browsable topic index to fill before reading it.
///
/// <para>
/// Asking the index for a filter does not subscribe: the process holding the broker connection polls for
/// the wanted filter on a timer, subscribes, and the retained messages arrive after that. Reading the index
/// straight after asking therefore returns nothing, every time — which is what a scan of a broker full of
/// matching topics reported.
/// </para>
/// <para>
/// So: ask, wait, read, and keep reading until the count stops rising. A fixed sleep would have to assume
/// the worst case on every scan; stopping when the count settles finishes as soon as the broker has
/// delivered what it has.
/// </para>
/// </summary>
public static class TopicIndexScan
{
    /// <summary>
    /// Poll <paramref name="search"/> until its count repeats or <paramref name="deadline"/> passes,
    /// renewing the lease each time so it cannot lapse mid-scan.
    /// </summary>
    /// <param name="renew">Re-assert the wanted filter (and keep the lease alive).</param>
    /// <param name="search">Read the index as it stands.</param>
    /// <param name="delay">Gap between polls.</param>
    /// <param name="deadline">Give up and return whatever has arrived.</param>
    public static async Task<IReadOnlyList<T>> SettleAsync<T>(
        Func<Task> renew, Func<Task<IReadOnlyList<T>>> search,
        Func<TimeSpan, Task> delay, TimeSpan pollEvery, DateTime deadline, Func<DateTime> now,
        CancellationToken ct = default)
    {
        await renew();

        var previous = -1;
        IReadOnlyList<T> latest = [];
        while (now() < deadline && !ct.IsCancellationRequested)
        {
            await delay(pollEvery);
            await renew();
            latest = await search();

            // Two consecutive equal, non-zero counts: the broker has finished delivering. Zero is not a
            // settled answer — it is the state the index starts in, and stopping there would reproduce the
            // bug this exists to fix.
            if (latest.Count > 0 && latest.Count == previous) break;
            previous = latest.Count;
        }
        return latest;
    }
}
