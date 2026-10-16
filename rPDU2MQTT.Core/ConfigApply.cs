using System.Text.Json;
using System.Text.Json.Nodes;
using rPDU2MQTT.Classes;

namespace rPDU2MQTT.Services.Gui;

/// <summary>
/// Which settings a save takes effect on immediately, and which wait for a restart.
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
        "HomeAssistant.Url",
        "HomeAssistant.Token",
        // Read on each provisioning pass.
        "EmonCMS.Feeds",
        // The image store is rebuilt when its settings object changes.
        "PlanStorage",
        // Only the floor plan page reads it, from the saved document.
        "Gui.DistanceUnits",
        // Only the Trends pages read these, from the saved document.
        "Gui.EnergyPrice",
        "Gui.Currency",
    ];

    /// <summary>Does a change to this setting take effect without a restart?</summary>
    public static bool AppliesLive(string path, IEnumerable<string>? alsoLive = null) =>
        AppliedLive.Concat(alsoLive ?? []).Any(p => path == p || path.StartsWith(p + ".", StringComparison.Ordinal));

    /// <summary>
    /// Every setting that differs between two configuration documents, as dotted paths.
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
    /// <param name="alsoLive">More live paths, such as plugin page settings.</param>
    public static IReadOnlyList<string> NeedingRestart(Config running, Config saved, IEnumerable<string>? alsoLive = null)
    {
        var before = JsonSerializer.SerializeToNode(running, ConfigSchema.ConfigJsonOptions);
        var after = JsonSerializer.SerializeToNode(saved, ConfigSchema.ConfigJsonOptions);
        var live = alsoLive?.ToList();
        return ChangedPaths(before, after).Where(p => !AppliesLive(p, live)).ToList();
    }

    /// <summary>Copies the given keys under <c>Plugins.{id}</c> from the saved document into the running one.</summary>
    public static void CopyPluginKeys(Config running, Config saved, string id, IEnumerable<string> keys)
    {
        var to = running.Plugins.TryGetValue(id, out var r) ? Core.Integrations.PluginConfigBinder.ToJson(r) as JsonObject ?? new() : new JsonObject();
        var from = saved.Plugins.TryGetValue(id, out var s) ? Core.Integrations.PluginConfigBinder.ToJson(s) as JsonObject : null;
        foreach (var key in keys)
        {
            var hit = from?.FirstOrDefault(kv => string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase));
            foreach (var old in to.Where(kv => string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase)).Select(kv => kv.Key).ToList()) to.Remove(old);
            if (hit?.Value is { } v) to[hit.Value.Key] = v.DeepClone();
        }
        running.Plugins[id] = to;
    }
}
