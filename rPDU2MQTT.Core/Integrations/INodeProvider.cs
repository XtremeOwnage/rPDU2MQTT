using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// An integration that can say what nodes it knows about, so they can be adopted into the hierarchy
/// instead of typed out by hand.
///
/// <para>
/// This is the capability behind everything already labelled "import" or "browse": the broker topic index
/// offering <c>solar_assistant/inverter_1/pv_power</c> as a node to bind, a Modbus scan showing which
/// registers decode to something plausible, a device template, and — once it exists — Home Assistant
/// enumerating its entities. Each of those is the same question asked of a different system: <i>what have
/// you got that I could model?</i>
/// </para>
/// <para>
/// Discovery only. Offering a node is not creating one, and this must never write to the configuration:
/// what gets adopted, what it is called and where it hangs in the hierarchy are the operator's, and a
/// discovery that quietly added nodes would rewrite a hand-built diagram on every poll. The GUI presents
/// what comes back; the operator picks.
/// </para>
/// </summary>
public interface INodeProvider
{
    /// <summary>
    /// What this integration can offer right now, optionally narrowed by <paramref name="search"/>.
    /// </summary>
    /// <remarks>
    /// Expected to be cheap and interactive — it backs a picker someone is typing into. An integration
    /// whose discovery is expensive (subscribing to a broker's whole topic tree) should lease that work
    /// while someone is actually browsing rather than indexing in the background, as the topic index does.
    /// </remarks>
    Task<IReadOnlyList<DiscoveredNode>> DiscoverAsync(Config cfg, string? search, CancellationToken ct);
}

/// <summary>
/// A node an integration is offering, and enough about it to decide whether to adopt it.
/// </summary>
/// <param name="Key">
/// How this integration addresses the thing — an MQTT topic, a Modbus register, an HA entity id. Stable
/// enough to bind to; it becomes the source's address, not the node's id.
/// </param>
/// <param name="Label">What to call it in the picker, as the far end names it.</param>
/// <param name="Metric">
/// What it appears to measure (<c>realpower</c>, <c>energy</c>, …), or null when that cannot be told from
/// what was discovered. Null means "ask the operator", never a guess presented as fact.
/// </param>
/// <param name="Unit">The unit the far end publishes in, when it says so.</param>
/// <param name="Sample">The most recent value seen, for the operator to sanity-check against reality.</param>
/// <param name="Kind">
/// The node kind this looks like (<c>solar</c>, <c>battery</c>, <c>grid</c>), when the integration can tell.
/// </param>
/// <param name="SuggestedId">
/// A node id this could reasonably be given. A suggestion the operator edits, not an id that is assigned.
/// </param>
public sealed record DiscoveredNode(
    string Key,
    string Label,
    string? Metric = null,
    string? Unit = null,
    double? Sample = null,
    string? Kind = null,
    string? SuggestedId = null);
