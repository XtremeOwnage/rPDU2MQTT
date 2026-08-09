using System.Text.RegularExpressions;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Tags for the nodes nobody configured: the PDUs and outlets derived from what the bridge polls.
///
/// <para>
/// A custom node carries its own tags. An outlet has nowhere to put them — it exists because the PDU
/// reports it, and there can be hundreds — so filtering a view or gating an export by "rack 1" or
/// "critical" was possible for the nodes you had typed out and impossible for everything else.
/// </para>
/// <para>
/// Matching is on the node id with <c>*</c> as the only wildcard, which is what makes one rule cover a
/// whole PDU and another a single outlet. Nothing is inherited implicitly: <c>outlet:rack_pdu_1:*</c> tags
/// those outlets because it says so, not because a tag on the PDU quietly flowed downhill.
/// </para>
/// </summary>
public static class AutoTags
{
    /// <summary>The tags every rule gives <paramref name="nodeId"/>, in the order the rules are written.</summary>
    public static IReadOnlyList<string> For(IEnumerable<AutoTagRule>? rules, string nodeId)
    {
        if (rules is null) return [];
        var found = new List<string>();
        foreach (var rule in rules)
        {
            if (string.IsNullOrWhiteSpace(rule.Match) || !Matches(rule.Match, nodeId)) continue;
            foreach (var tag in rule.Tags ?? [])
            {
                var t = tag?.Trim() ?? "";
                if (t.Length > 0 && !found.Contains(t, StringComparer.OrdinalIgnoreCase)) found.Add(t);
            }
        }
        return found;
    }

    /// <summary>
    /// Does a pattern cover this id? Every character but <c>*</c> is literal — an outlet id is full of
    /// <c>:</c> and a PDU name may hold a <c>.</c>, and either taken as a regex would match far more than
    /// it appears to.
    /// </summary>
    public static bool Matches(string pattern, string nodeId)
    {
        var rx = "^" + string.Join(".*", pattern.Split('*').Select(Regex.Escape)) + "$";
        return Regex.IsMatch(nodeId ?? "", rx, RegexOptions.IgnoreCase);
    }
}
