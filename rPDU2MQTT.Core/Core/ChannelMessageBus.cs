using System.Runtime.CompilerServices;
using System.Threading.Channels;

namespace rPDU2MQTT.Core;

/// <summary>
/// In-process <see cref="IMessageBus"/> backed by <see cref="System.Threading.Channels"/>. Each
/// subscriber gets its own bounded channel; publishing fans out with a non-blocking write so one slow
/// consumer never stalls producers or other consumers (its buffer drops the oldest snapshot instead).
/// </summary>
public sealed class ChannelMessageBus : IMessageBus
{
    private readonly object gate = new();
    private readonly List<Channel<PduSnapshot>> subscribers = new();

    public ValueTask PublishAsync(PduSnapshot snapshot, CancellationToken cancellationToken = default)
    {
        Channel<PduSnapshot>[] targets;
        lock (gate)
            targets = subscribers.ToArray();

        foreach (var channel in targets)
            // DropOldest buffers: this always succeeds, evicting a stale snapshot for a lagging consumer.
            channel.Writer.TryWrite(snapshot);

        return ValueTask.CompletedTask;
    }

    public IAsyncEnumerable<PduSnapshot> Subscribe(int capacity = 16, CancellationToken cancellationToken = default)
    {
        // Register eagerly (not lazily inside the iterator) so snapshots published between Subscribe()
        // and the first read are buffered rather than dropped.
        var channel = Channel.CreateBounded<PduSnapshot>(new BoundedChannelOptions(Math.Max(1, capacity))
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });

        lock (gate)
            subscribers.Add(channel);

        return Read(channel, cancellationToken);
    }

    /// <summary>
    /// One subscriber's stream. Cancelling it means that subscriber is going away — a consumer shutting
    /// down — which is an ending, not a fault.
    /// </summary>
    /// <remarks>
    /// Written as a manual read loop rather than <c>ReadAllAsync(token)</c> because that throws
    /// <see cref="OperationCanceledException"/> on cancellation, and an iterator cannot catch around a
    /// <c>yield return</c> — only <c>try/finally</c> is legal there. So the exception escaped into whatever
    /// was enumerating: <c>SnapshotCache</c>, a BackgroundService, which reported it to the host as a
    /// crashed background service on every clean shutdown. Awaiting inside the try and yielding outside it
    /// is what lets the ending be an ending.
    /// </remarks>
    private async IAsyncEnumerable<PduSnapshot> Read(Channel<PduSnapshot> channel, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        try
        {
            while (true)
            {
                PduSnapshot? item;
                try
                {
                    if (!await channel.Reader.WaitToReadAsync(cancellationToken)) break;   // writer completed
                    if (!channel.Reader.TryRead(out item)) continue;                        // raced another read
                }
                catch (OperationCanceledException) { break; }

                yield return item;
            }
        }
        finally
        {
            lock (gate)
                subscribers.Remove(channel);
            channel.Writer.TryComplete();
        }
    }
}
