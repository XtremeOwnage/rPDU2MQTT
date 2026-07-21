namespace rPDU2MQTT.Grains.Abstractions.EmonCms;

/// <summary>What a feed-provisioning pass did, and when.</summary>
[GenerateSerializer]
public sealed record EmonFeedReport
{
    [Id(0)] public bool Ok { get; init; }
    [Id(1)] public string Message { get; init; } = "No provisioning run yet.";
    [Id(2)] public int FeedsCreated { get; init; }
    [Id(3)] public int ProcessesSet { get; init; }
    [Id(4)] public int VirtualFeeds { get; init; }
    [Id(5)] public DateTime? AtUtc { get; init; }
}

/// <summary>
/// The single cluster-wide owner of EmonCMS's configuration (singleton, key 0): creating feeds, setting
/// input processlists, and deleting what we created.
/// <para>
/// These are writes to someone else's database, made with several dependent API calls (create the feed, then
/// point the input's processlist at it). Two processes doing that concurrently is how you get duplicate feeds
/// and half-applied processlists — which is exactly what an actor prevents: one activation, one caller at a
/// time, cluster-wide. It replaces a leader check with a structural guarantee, and gives the GUI's "Provision
/// now" button and the periodic pass the same single path in.
/// </para>
/// </summary>
public interface IEmonCmsFeedGrain : IGrainWithIntegerKey
{
    /// <summary>
    /// Bring EmonCMS's feeds in line with the config. Throttled — a periodic caller can poke this as often
    /// as it likes — unless <paramref name="force"/> says a human asked for it.
    /// </summary>
    Task<EmonFeedReport> Reconcile(bool force);

    /// <summary>Delete every feed this project created (under its tag). Always runs; it's an explicit act.</summary>
    Task<EmonFeedReport> DeleteAll();

    /// <summary>The last pass's outcome, for the GUI to show without triggering one.</summary>
    Task<EmonFeedReport> Last();
}
