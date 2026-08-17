using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Core.Status;

/// <summary>What a component's dot means.</summary>
public enum StatusLevel { Off, Good, Warn, Bad }

/// <summary>How a card renders the instant it carries, if it shows one.</summary>
public enum AgeStyle { None, Ago, At }

/// <summary>
/// What a process can see of one component. Reported on a timer; never a verdict, only facts.
/// </summary>
/// <param name="Enabled">Configured/turned on at all? False means grey, whatever else says.</param>
/// <param name="Ok">Healthy? Null means "no outcome yet" — nothing has been attempted.</param>
/// <param name="Detail">The card's second line: a host, a topic, an error.</param>
/// <param name="EventUtc">When the thing being described happened.</param>
/// <param name="IntervalSeconds">The cadence expected, where that decides staleness.</param>
/// <param name="Title">Card title, when a component is one of many of its kind.</param>
/// <param name="Count">A count worth showing — values exported, entities discovered.</param>
public sealed record ComponentReport(
    bool Enabled = true,
    bool? Ok = null,
    string? Detail = null,
    DateTime? EventUtc = null,
    int IntervalSeconds = 0,
    string? Title = null,
    int Count = 0);

/// <summary>One card on the Status board.</summary>
public sealed record ComponentStatus(
    string Id, string Title, StatusLevel Level, string State, string? Detail,
    DateTime? EventUtc, AgeStyle Age, int Count, int Order);

/// <summary>
/// The Status board, in memory.
///
/// <para>
/// Replaces a grain per component plus a projection grain. Each of those held one report and ran its own
/// ten-second timer purely to re-evaluate and push a card that had probably not changed; in one process
/// that is a dictionary and a function. Evaluating <b>on read</b> rather than on a tick also removes the
/// staleness the timers existed to paper over — an "…ago" is computed when someone looks, so it can never
/// be out of date, and a component going quiet turns amber without anything having to notice.
/// </para>
/// <para>
/// Silence is handled here, once, so no component has to know how to say "nobody is telling us about this
/// any more".
/// </para>
/// </summary>
public sealed class StatusBoard
{
    /// <summary>Past this with no report, the verdict is "nobody is reporting this any more".</summary>
    private const int SilentAfterSeconds = 90;

    /// <summary>Past this it is gone rather than quiet, and the card is retired.</summary>
    private const int GiveUpAfterSeconds = 300;

    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.OrdinalIgnoreCase);

    private sealed record Entry(ComponentReport Report, DateTime ReportedUtc, ComponentKind Kind);

    /// <summary>The verdict rule a component is judged by — its kind, not its identity.</summary>
    public enum ComponentKind { Broker, Device, Integration, Cache, History, Node, Process }

    /// <summary>Record what this process can see. Cheap, idempotent, called on a timer.</summary>
    public void Report(string id, ComponentKind kind, ComponentReport report)
    {
        if (string.IsNullOrWhiteSpace(id)) return;
        lock (gate) entries[id] = new Entry(report, DateTime.UtcNow, kind);
    }

    /// <summary>Forget a component — it is gone rather than quiet.</summary>
    public void Drop(string id)
    {
        lock (gate) entries.Remove(id);
    }

    /// <summary>
    /// Every card, in board order, evaluated as of now. Cards nobody has reported for long enough are
    /// dropped rather than shown stale.
    /// </summary>
    public IReadOnlyList<ComponentStatus> Board()
    {
        var now = DateTime.UtcNow;
        List<(string Id, Entry E)> snapshot;
        lock (gate)
        {
            foreach (var dead in entries.Where(e => (now - e.Value.ReportedUtc).TotalSeconds > GiveUpAfterSeconds)
                                        .Select(e => e.Key).ToList())
                entries.Remove(dead);
            snapshot = entries.Select(e => (e.Key, e.Value)).ToList();
        }

        return snapshot
            .Select(x => Evaluate(x.Id, x.E, now))
            .OrderBy(c => c.Order).ThenBy(c => c.Id, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>One component's card, or null if it has never been reported.</summary>
    public ComponentStatus? For(string id)
    {
        lock (gate)
            return entries.TryGetValue(id, out var e) ? Evaluate(id, e, DateTime.UtcNow) : null;
    }

    private static ComponentStatus Evaluate(string id, Entry entry, DateTime now)
    {
        var r = entry.Report;
        var (order, defaultTitle, age) = Shape(entry.Kind);
        var title = string.IsNullOrWhiteSpace(r.Title) ? defaultTitle : r.Title!;

        // Nobody has reported this recently. Said once, here, rather than by every component.
        if ((now - entry.ReportedUtc).TotalSeconds > SilentAfterSeconds)
            return new(id, title, StatusLevel.Warn, "No reports", "Nothing has reported on this recently",
                       r.EventUtc, age, r.Count, order);

        var (level, state, detail) = entry.Kind switch
        {
            ComponentKind.Broker => !r.Enabled
                ? (StatusLevel.Off, "Disabled", (string?)null)
                : r.Ok == true ? (StatusLevel.Good, "Connected", r.Detail)
                : (StatusLevel.Bad, "Disconnected", r.Detail),

            // Judged against ITS OWN interval: a five-minute poller is not stale by a thirty-second one's
            // standard, which is why the cadence travels on the report.
            ComponentKind.Device => r.EventUtc is not { } polled
                ? (StatusLevel.Warn, "No data yet", r.Detail ?? "Waiting for the first poll")
                : SnapshotFreshness.IsStale(polled, r.IntervalSeconds, now)
                    ? (StatusLevel.Bad, "Stale", "Updated")
                    : (StatusLevel.Good, "Polling", "Updated"),

            // Configured but unreachable is a real failure here, not an "off": the counters it holds are
            // what let a restart continue a total instead of looking like a meter reset.
            ComponentKind.Cache => !r.Enabled
                ? (StatusLevel.Off, "Not configured", r.Detail)
                : r.Ok is null ? (StatusLevel.Warn, "Checking", r.Detail)
                : r.Ok == false ? (StatusLevel.Bad, "Unreachable", r.Detail)
                : (StatusLevel.Good, "Connected", r.Detail),

            ComponentKind.History => !r.Enabled
                ? (StatusLevel.Off, "Off", r.Detail)
                : r.Ok == true ? (StatusLevel.Good, "Reachable", r.Detail)
                : r.Ok == false ? (StatusLevel.Bad, "Unreachable", r.Detail)
                : (StatusLevel.Warn, "Not checked", r.Detail),

            ComponentKind.Process => (StatusLevel.Good, "Running", r.Detail),

            // Integrations and nodes: enabled, failing, working, or enabled and yet to report.
            _ => !r.Enabled ? (StatusLevel.Off, "Disabled", r.Detail)
               : r.Ok == false ? (StatusLevel.Bad, "Failing", r.Detail)
               : r.Ok == true ? (StatusLevel.Good, "Exporting", r.Detail)
               : (StatusLevel.Warn, "No data yet", r.Detail ?? "Enabled, nothing reported yet"),
        };

        return new(id, title, level, state, detail, r.EventUtc, age, r.Count, order);
    }

    /// <summary>Where a kind sorts, what it is called, and how its instant reads.</summary>
    private static (int Order, string Title, AgeStyle Age) Shape(ComponentKind kind) => kind switch
    {
        ComponentKind.Broker => (10, "MQTT", AgeStyle.None),
        ComponentKind.Device => (20, "PDU", AgeStyle.Ago),
        ComponentKind.Integration => (30, "Integration", AgeStyle.Ago),
        ComponentKind.Cache => (55, "Cache", AgeStyle.None),
        ComponentKind.History => (58, "History", AgeStyle.None),
        ComponentKind.Process => (70, "Process", AgeStyle.Ago),
        _ => (80, "Node", AgeStyle.Ago),
    };

    /// <summary>The card an integration gets from its own verdict, so one rule serves board and health.</summary>
    public static ComponentReport From(IntegrationHealth health, string title, int count = 0, DateTime? at = null)
        => new(
            Enabled: health.Level != HealthLevel.Off,
            Ok: health.Level switch
            {
                HealthLevel.Good => true,
                HealthLevel.Bad => false,
                _ => null,
            },
            Detail: health.Detail ?? health.Summary,
            EventUtc: at,
            Title: title,
            Count: count);
}
