using System.Runtime.CompilerServices;
using System.Threading.Channels;
using rPDU2MQTT.Abstractions.Pipeline;

namespace rPDU2MQTT.Core.Pipeline;

/// <summary>
/// In-process reference implementation of <see cref="ISnapshotStream{T}"/>, generalising the v2
/// <see cref="ChannelMessageBus"/> to any <see cref="ISnapshot"/>. Each subscriber gets its own bounded
/// channel; emitting fans out with a non-blocking write, so one slow consumer never stalls the producer or
/// other consumers — its buffer drops the oldest snapshot instead. This is the transport a single-process
/// (or single-silo) deployment uses; a distributed transport (an Orleans stream) would implement the same
/// interface, and nothing that publishes or consumes has to change.
/// </summary>
public sealed class ChannelSnapshotStream<T> : ISnapshotStream<T> where T : ISnapshot
{
    private readonly object gate = new();
    private readonly List<Channel<T>> subscribers = new();

    public ValueTask EmitAsync(T snapshot, CancellationToken cancellationToken = default)
    {
        Channel<T>[] targets;
        lock (gate)
            targets = subscribers.ToArray();

        foreach (var channel in targets)
            // DropOldest buffers: TryWrite always succeeds, evicting a stale snapshot for a lagging consumer.
            channel.Writer.TryWrite(snapshot);

        return ValueTask.CompletedTask;
    }

    public IAsyncEnumerable<T> Subscribe(int capacity = 16, CancellationToken cancellationToken = default)
    {
        // Register eagerly (not lazily inside the iterator) so snapshots emitted between Subscribe() and the
        // first read are buffered rather than dropped.
        var channel = Channel.CreateBounded<T>(new BoundedChannelOptions(Math.Max(1, capacity))
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });

        lock (gate)
            subscribers.Add(channel);

        return Read(channel, cancellationToken);
    }

    private async IAsyncEnumerable<T> Read(Channel<T> channel, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var item in channel.Reader.ReadAllAsync(cancellationToken))
                yield return item;
        }
        finally
        {
            lock (gate)
                subscribers.Remove(channel);
            channel.Writer.TryComplete();
        }
    }
}
