using System.Text.RegularExpressions;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Tags for the nodes nobody configured: the PDUs and outlets derived from what the bridge polls.
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
