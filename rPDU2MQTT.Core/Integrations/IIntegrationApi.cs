using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Core.Integrations;

/// <summary>
/// What an integration can be asked to <i>do</i>, beyond exporting: provision EmonCMS feeds, scan a Modbus
/// register block, list broker topics, sweep Home Assistant's orphaned discovery documents.
///
/// <para>
/// Roughly half the GUI's endpoints are these — <c>/api/emoncms/provision-feeds</c>,
/// <c>/api/modbus/scan</c>, <c>/api/mqtt/topics</c>, <c>/api/ha/orphans/clear</c> — and each one is
/// hand-written into <c>GuiService</c> and hand-wired to a button in <c>actions.ts</c>. Declaring them here
/// means the host can expose every integration's actions on one route shape, and the GUI can render buttons
/// for them without knowing what any particular integration offers.
/// </para>
/// <para>
/// Deliberately transport-free: no <c>HttpContext</c>, no ASP.NET types, no route strings. Core carries no
/// web framework and must not start, and the same declaration can then be surfaced as a REST route, a GUI
/// button and an MQTT command topic without the integration knowing which of those called it. This is the
/// same rule that keeps the pipeline contracts in <c>Abstractions</c> framework-free.
/// </para>
/// </summary>
public interface IIntegrationApi
{
    /// <summary>The actions this integration offers, in the order the GUI should present them.</summary>
    IReadOnlyList<IntegrationAction> Actions { get; }
}

/// <summary>
/// What an action changes, which decides who may call it and how the GUI presents it.
/// </summary>
public enum ActionEffect
{
    /// <summary>Answers a question and changes nothing — safe for the read-only API and safe to repeat.</summary>
    Read,
    /// <summary>Changes something at the far end. Needs a confirmation in the GUI and a writable API.</summary>
    Write,
    /// <summary>Removes something at the far end. Confirmed, and never offered casually.</summary>
    Destructive,
}

/// <summary>One thing an integration can be asked to do.</summary>
/// <param name="Name">
/// Stable, lowercase, unique within the integration ("provision-feeds", "scan"). Combined with the
/// integration's id this is the whole address: <c>prometheus/probe</c>, <c>emoncms/provision-feeds</c>.
/// </param>
/// <param name="Title">What the GUI's button says ("Provision feeds").</param>
/// <param name="Description">What it will do, shown beside the button — and before a confirmation.</param>
/// <param name="Effect">Whether it reads, writes, or removes.</param>
/// <param name="Handler">
/// Does the work. <c>args</c> holds the caller's parameters — query string, request body fields, or the
/// GUI's form values, already flattened to strings. Returns anything serialisable; null means "no body".
/// </param>
public sealed record IntegrationAction(
    string Name,
    string Title,
    string Description,
    ActionEffect Effect,
    Func<IntegrationActionContext, CancellationToken, Task<object?>> Handler);

/// <summary>
/// What an action is given when it runs: the live configuration and the caller's arguments.
/// </summary>
/// <remarks>
/// A record rather than a bare dictionary so an action can later be handed more (the current snapshot, the
/// export pass) without every existing handler changing shape.
/// </remarks>
/// <param name="Config">The live configuration, so an action reads current values rather than startup ones.</param>
/// <param name="Args">Caller-supplied arguments, flattened to strings. Missing keys are absent, not empty.</param>
public sealed record IntegrationActionContext(Config Config, IReadOnlyDictionary<string, string?> Args)
{
    /// <summary>An argument, or null when the caller did not supply it.</summary>
    public string? Arg(string name) => Args.TryGetValue(name, out var v) ? v : null;

    /// <summary>An integer argument, or <paramref name="fallback"/> when absent or unparseable.</summary>
    public int Int(string name, int fallback = 0)
        => int.TryParse(Arg(name), out var v) ? v : fallback;

    /// <summary>A boolean argument. Accepts "true"/"1"/"yes"; anything else is false.</summary>
    public bool Flag(string name)
        => Arg(name) is { } v && (v.Equals("true", StringComparison.OrdinalIgnoreCase) || v is "1" || v.Equals("yes", StringComparison.OrdinalIgnoreCase));
}
