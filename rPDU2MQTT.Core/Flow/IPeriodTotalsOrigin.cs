namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Where today's figures actually start from.
///
/// <para>
/// A daily total is only the day's total if the accumulator carried its state across the last restart. When
/// it did not — the store was empty, or there was nowhere durable to keep it — the figure is the energy
/// since the process started, and calling that "since the day rolled over" is a claim nothing supports. On
/// a deployment that rolls out several times a day, it is wrong most of the time.
/// </para>
/// <para>
/// Reported rather than inferred: the GUI cannot tell a genuine zero (a solar array at night) from a total
/// that was reset an hour ago, and those two look identical on a tile.
/// </para>
/// </summary>
public interface IPeriodTotalsOrigin
{
    /// <summary>Node states carried across the restart. Zero means today's figures start from the process.</summary>
    int CarriedOverNodes { get; }

    /// <summary>The instant the daily figures actually accumulate from.</summary>
    DateTime AccumulatingSinceUtc { get; }

    /// <summary>Where the totals are kept — "cache", "file", or "memory" — so the fix is obvious.</summary>
    string StoreKind { get; }
}
