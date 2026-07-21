using Orleans.Concurrency;
using rPDU2MQTT.Grains.Abstractions.Status;

namespace rPDU2MQTT.Grains.Status;

/// <summary>
/// The Status board projection (singleton, key 0). Holds the card each component grain last published and
/// serves the lot in board order — it computes no verdicts of its own, so there is nowhere for a second
/// opinion about a component's health to creep in.
/// </summary>
[Reentrant]
public sealed class StatusBoardGrain : Grain, IStatusBoardGrain
{
    private readonly Dictionary<string, ComponentStatus> cards = new(StringComparer.OrdinalIgnoreCase);

    public Task Publish(ComponentStatus status)
    {
        if (!string.IsNullOrEmpty(status.Id)) cards[status.Id] = status;
        return Task.CompletedTask;
    }

    public Task Drop(string id)
    {
        cards.Remove(id);
        return Task.CompletedTask;
    }

    public Task<List<ComponentStatus>> Board()
        => Task.FromResult(cards.Values.OrderBy(c => c.Order).ThenBy(c => c.Id, StringComparer.OrdinalIgnoreCase).ToList());
}
