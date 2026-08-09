using System.Text.Json;
using System.Text.Json.Nodes;
using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Services.Gui;

/// <summary>
/// Which settings a save takes effect on immediately, and which wait for a restart.
///
/// <para>
/// Saving writes the whole document to the configuration source, but only part of it can be applied to a
/// process that is already running: the rest was read at startup and is held by services that never look
/// again. Until this existed, the difference was invisible — the GUI showed the saved value, the bridge
/// went on behaving the old way, and a test button reported a feature as off seconds after it was switched
/// on. The disagreement is real; the only question is whether anyone is told about it.
/// </para>
/// <para>
/// The list below is what the save handler actually copies into the running configuration, and nothing
/// else. It is deliberately a list of what *is* live rather than of what is not: adding a setting to it is
/// a claim that the running process re-reads it, and that claim belongs beside the code that makes it true.
/// </para>
/// </summary>
public static class ConfigApply
{
    /// <summary>
    /// Configuration paths the save handler applies to the running process. A path covers everything under
    /// it. Names are the ones the saved document uses (so <c>HomeAssistant</c>, not <c>HASS</c>).
    /// </summary>
    public static readonly string[] AppliedLive =
    [
        // The hierarchy is read fresh on every /api/flow request.
        "EnergyFlow",
        // Instances are reconciled after the save — a new PDU starts polling, a removed one stops.
        "Pdus",
        // FlowHistoryRouter reads the provider and its settings per call.
        "History",
        // Read on each periodic sync and by the manual sync/clear buttons.
        "HomeAssistant.EnergyDashboard",
        // Read on each provisioning pass.
        "EmonCMS.Feeds",
    ];

    /// <summary>Does a change to this setting take effect without a restart?</summary>
    public static bool AppliesLive(string path) =>
        AppliedLive.Any(p => path == p || path.StartsWith(p + ".", StringComparison.Ordinal));

    /// <summary>
    /// Every setting that differs between two configuration documents, as dotted paths.
    ///
    /// <para>
    /// Objects are walked; arrays and scalars are compared whole. An element-by-element diff of the node
    /// list would say no more than "EnergyFlow.Nodes changed", which is the answer either way.
    /// </para>
    /// </summary>
    public static IReadOnlyList<string> ChangedPaths(JsonNode? before, JsonNode? after)
    {
        var changed = new List<string>();
        Walk(before, after, "", changed);
        return changed;
    }

    private static void Walk(JsonNode? a, JsonNode? b, string path, List<string> into)
    {
        if (a is JsonObject oa && b is JsonObject ob)
        {
            foreach (var key in oa.Select(kv => kv.Key).Concat(ob.Select(kv => kv.Key)).Distinct(StringComparer.Ordinal))
                Walk(oa[key], ob[key], path.Length == 0 ? key : $"{path}.{key}", into);
            return;
        }
        if (!JsonNode.DeepEquals(a, b)) into.Add(path);
    }

    /// <summary>
    /// The settings in <paramref name="saved"/> that the process cannot pick up, given what it is currently
    /// running. Recomputed from scratch on every save, so changing a setting back to what the process is
    /// actually running clears it rather than leaving a restart hanging over nothing.
    /// </summary>
    public static IReadOnlyList<string> NeedingRestart(Config running, Config saved)
    {
        var before = JsonSerializer.SerializeToNode(running, ConfigSchema.ConfigJsonOptions);
        var after = JsonSerializer.SerializeToNode(saved, ConfigSchema.ConfigJsonOptions);
        return ChangedPaths(before, after).Where(p => !AppliesLive(p)).ToList();
    }
}
