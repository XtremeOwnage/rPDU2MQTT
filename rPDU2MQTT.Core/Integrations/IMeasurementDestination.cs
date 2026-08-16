using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// An integration that receives readings and the energy-flow hierarchy — Prometheus, EmonCMS, MQTT, Home
/// Assistant.
///
/// <para>
/// "Measurement", not "energy": a PDU reports temperature, humidity and CO2 alongside power, and Home
/// Assistant discovery carries every one of them. Naming the contract for energy would have been wrong on
/// the day it was written, even though the energy hierarchy is the part that motivated it.
/// </para>
///
/// <para>
/// A destination decides what to do with an <see cref="ExportPass"/> and nothing else. It does not know how
/// often it is called, whether it is the cluster leader, which process it is in, or how its failures are
/// reported. Those were spread across <c>ServiceConfiguration</c>, <c>baseMQTTService</c> and
/// <c>StatusReporter</c>, which is why adding one meant editing thirteen files.
/// </para>
/// </summary>
public interface IMeasurementDestination
{
    /// <summary>
    /// Which flow nodes this destination carries (#342). Returning an empty filter carries every node.
    /// The filter chooses recipients; it never changes a value and never affects another destination.
    /// </summary>
    NodeTagFilter Tags(Config cfg) => new();

    /// <summary>
    /// Is this destination's output shared, so exactly one process in the cluster should produce it?
    ///
    /// <para>
    /// True for anything that publishes to a broker or posts to a server: N replicas doing it means N
    /// copies. False for a destination whose output is <i>per-process</i> — Prometheus serves its own
    /// <c>/metrics</c> on every pod, so every pod must refresh its own gauges or a scrape of a non-leader
    /// returns numbers frozen at whenever it last held the lease.
    /// </para>
    /// </summary>
    bool LeaderGated => true;

    /// <summary>
    /// Send this pass. Called on the cadence the host chooses, and on the leader only unless
    /// <see cref="LeaderGated"/> says otherwise.
    /// </summary>
    /// <remarks>
    /// Throwing is how a destination reports a bad pass: the host records it against this integration's id
    /// on the Status board and keeps going with the others. One failing destination has never been a reason
    /// to stop the rest, and swallowing the exception here is how a silent one goes unnoticed for months.
    /// </remarks>
    Task SendAsync(ExportPass pass, CancellationToken ct);
}

/// <summary>
/// An integration that publishes <b>configuration</b> to the far end — a description of what exists, so
/// the remote system knows how to interpret the measurements that follow.
///
/// <para>
/// This is a genuinely separate direction of travel from <see cref="IMeasurementDestination"/> and was
/// wrong to treat as a footnote on it. Home Assistant discovery publishes an entity document per device;
/// the Energy Dashboard sync writes the dashboard's own configuration through HA's WebSocket API; EmonCMS
/// provisions feeds and sets each input's processlist. None of those send a reading. They run on their own
/// slow cadence, they are what an operator triggers by hand from the GUI, and their failure mode is
/// different: a measurement that does not arrive is a gap, but configuration that does not arrive means
/// every measurement after it lands somewhere wrong or nowhere at all.
/// </para>
/// <para>
/// Sweeping is part of the same job. Configuration published once outlives the thing it described — a
/// renamed node, a deleted PDU — and the retained discovery document or the orphaned feed stays behind
/// claiming to be current. Whoever publishes is the only thing that knows what it would publish today, so
/// it owns the clean-up too.
/// </para>
/// </summary>
public interface IConfigurationPublisher
{
    /// <summary>Whether publishing is switched on — usually its own opt-in toggle, separate from the export.</summary>
    bool PublishingEnabled(Config cfg);

    /// <summary>
    /// How often to republish. Configuration is not a reading: it changes when the operator changes
    /// something, not every poll, and pushing it at the export cadence is how a broker ends up with
    /// thousands of identical retained messages.
    /// </summary>
    TimeSpan Interval(Config cfg) => TimeSpan.FromMinutes(5);

    /// <summary>
    /// Bring the far end's description of the world into line with this configuration, and report what
    /// changed. <paramref name="pass"/> supplies what currently exists to describe.
    /// </summary>
    Task<string> PublishAsync(ExportPass pass, CancellationToken ct);

    /// <summary>
    /// Remove what this integration published and would no longer publish today. Separate from
    /// <see cref="PublishAsync"/> because it is destructive, is usually the GUI's own button, and must be
    /// safe to decline: an implementation that cannot enumerate what it owns returns "nothing swept"
    /// rather than guessing.
    /// </summary>
    Task<string> SweepAsync(ExportPass pass, CancellationToken ct) => Task.FromResult("nothing to sweep");
}
