namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// The outcome of the last export pass for one integration, kept per id.
///
/// <para>
/// One of these replaces the bespoke status holder each destination grew (<c>EmonCmsStatus</c> and its
/// siblings), and with it the branch per integration in <c>StatusReporter</c>. Thread-safe: the host
/// writes, the GUI and the status reporter read.
/// </para>
/// </summary>
public sealed class IntegrationStatus
{
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> byId = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>What one integration last did.</summary>
    /// <param name="Count">How much was sent — measurements, tiers, whatever the destination counts.</param>
    public sealed record Entry(
        DateTime? LastAttemptUtc, DateTime? LastSuccessUtc, bool? LastOk, string? LastError, int Count);

    public void RecordSuccess(string id, int count)
    {
        lock (gate)
        {
            var now = DateTime.UtcNow;
            byId[id] = new Entry(now, now, true, null, count);
        }
    }

    public void RecordFailure(string id, string error)
    {
        lock (gate)
        {
            byId.TryGetValue(id, out var prior);
            byId[id] = new Entry(DateTime.UtcNow, prior?.LastSuccessUtc, false, error, prior?.Count ?? 0);
        }
    }

    /// <summary>What this integration last did, or null if it has not run.</summary>
    public Entry? For(string id)
    {
        lock (gate) return byId.TryGetValue(id, out var e) ? e : null;
    }

    /// <summary>Every integration that has run, for the Status board.</summary>
    public IReadOnlyDictionary<string, Entry> All()
    {
        lock (gate) return new Dictionary<string, Entry>(byId, StringComparer.OrdinalIgnoreCase);
    }
}
