namespace rPDU2MQTT.Grains.Abstractions.Status;

/// <summary>
/// The Status board (singleton, key 0) — the projection of every component grain's current card. It decides
/// nothing: the component grains push their verdicts here on change and on a heartbeat, and drop themselves
/// when their reporter is gone for good. One grain call renders the whole board.
/// </summary>
public interface IStatusBoardGrain : IGrainWithIntegerKey
{
    /// <summary>A component grain publishing its newly computed card.</summary>
    Task Publish(ComponentStatus status);

    /// <summary>A component grain retiring itself — nothing has reported it for long enough to give up.</summary>
    Task Drop(string id);

    /// <summary>Every card, in board order.</summary>
    Task<List<ComponentStatus>> Board();
}
