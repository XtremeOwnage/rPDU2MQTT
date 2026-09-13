using System.Text.RegularExpressions;

namespace rPDU2MQTT.Core.Flow;

/// <summary>One reading matched from a topic pattern.</summary>
/// <param name="Device">The device segment the pattern captured.</param>
/// <param name="Measure">The measure segment the pattern captured.</param>
/// <param name="Topic">The full topic.</param>
/// <param name="Metric">Our metric name, or null when the measure is not one we roll up.</param>
/// <param name="JsonField">Field to read from a JSON payload, or null when the payload is the bare value.</param>
/// <param name="Sample">The last payload seen, so the operator can confirm the unit before importing.</param>
/// <param name="Accumulation">How the counter accumulates — 'period' for one the device zeroes each day, else null.</param>
public readonly record struct PatternMatch(
    string Device, string Measure, string Topic, string? Metric, string? JsonField, string? Sample,
    string? Accumulation = null);

/// <summary>
/// Matches readings by topic shape, for publishers that do not announce Home Assistant discovery.
///
/// <para>
/// <see cref="MqttDiscoveryImport"/> is preferred where discovery exists, because it states the unit and
/// the device class. A raw topic states neither: <c>esphome/devices/fan/sensor/energy_d/state = 113.783</c>
/// gives no way to tell Wh from kWh. So a pattern match proposes the device, the measure and the metric,
/// and leaves the unit for the operator to set with the sampled value in front of them.
/// </para>
/// </summary>
public static class MqttTopicProfile
{
    /// <summary>A named topic shape, with <c>{device}</c> and <c>{measure}</c> marking the parts to capture.</summary>
    /// <param name="Id">Stable key used by the API and the GUI.</param>
    /// <param name="Label">What the picker calls it.</param>
    /// <param name="Filter">The subscription filter to browse.</param>
    /// <param name="Pattern">
    /// Slash-delimited, with <c>{device}</c>, <c>{measure}</c> and <c>+</c> wildcards. A placeholder is
    /// usually a whole segment; both may share one, as <c>{device}_{measure}</c>, where a publisher names
    /// its channel and its measure together.
    /// </param>
    /// <param name="JsonField">Field holding the value, when the payload is JSON.</param>
    /// <param name="Metrics">Measure -> our metric name. Measures absent from this map are not readings we roll up.</param>
    /// <param name="Tags">Tags every node imported through this profile carries.</param>
    public sealed record Profile(
        string Id, string Label, string Filter, string Pattern, string? JsonField,
        IReadOnlyDictionary<string, string> Metrics, IReadOnlyList<string>? Tags = null);

    private static readonly Dictionary<string, string> EsphomeMetrics = new(StringComparer.OrdinalIgnoreCase)
    {
        ["power"] = "realpower",
        ["apparent_power"] = "apparentpower",
        ["energy"] = "energy",
        // ESPHome zeroes these each day, so they are the day's own figure rather than a lifetime counter.
        ["energy_d"] = EnergyPeriod.Metric,
        ["daily_energy"] = EnergyPeriod.Metric,
        ["total_energy"] = "energy",
        ["current"] = "current",
        ["voltage"] = "voltage",
        ["frequency"] = "frequency",
        ["power_factor"] = "powerfactor",
    };

    // Z-Wave meter readings are numbered, not named: command class 50 (Meter), property 66049 = watts and
    // 65537 = kWh. The numbers are the published vocabulary, so they are what the map keys on.
    private static readonly Dictionary<string, string> ZwaveMetrics = new(StringComparer.OrdinalIgnoreCase)
    {
        ["66049"] = "realpower",
        ["65537"] = "energy",
        ["66561"] = "current",
        ["66817"] = "voltage",
    };

    public static readonly IReadOnlyList<Profile> BuiltIn =
    [
        new("esphome", "ESPHome", "esphome/#", "esphome/devices/{device}/sensor/{measure}/state", null, EsphomeMetrics),
        // One ESPHome node reporting many channels names each one in the sensor segment, e.g.
        // 'esphome/devices/n30/sensor/n30_2_1_current/state' — channel n30_2_1, measuring current.
        new("esphome_channels", "ESPHome (multi-channel)", "esphome/#", "esphome/devices/+/sensor/{device}_{measure}/state", null, EsphomeMetrics),
        new("zwavejs", "Z-Wave JS", "zwave/#", "zwave/+/{device}/50/+/value/{measure}", "value", ZwaveMetrics),
    ];

    public static Profile? ById(string? id) =>
        BuiltIn.FirstOrDefault(p => string.Equals(p.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// A built-in profile, or one defined in <c>MQTT.ImportProfiles</c>. Configured profiles are addressed
    /// as <c>custom:&lt;name&gt;</c>, keeping them in a separate id space from the built-ins.
    /// </summary>
    public static Profile? Resolve(string? id, IEnumerable<Models.Config.MqttImportProfile>? configured)
    {
        if (ById(id) is { } builtIn) return builtIn;

        const string prefix = "custom:";
        if (id is null || !id.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;

        var name = id[prefix.Length..];
        var p = configured?.FirstOrDefault(c => string.Equals(c.Name, name, StringComparison.OrdinalIgnoreCase));
        if (p is null || string.IsNullOrWhiteSpace(p.Pattern)) return null;

        // A blank filter falls back to the pattern's root rather than '#', which some broker ACLs refuse.
        var filter = string.IsNullOrWhiteSpace(p.Filter)
            ? p.Pattern.Split('/')[0] + "/#"
            : p.Filter.Trim();

        return new Profile(id, string.IsNullOrWhiteSpace(p.Name) ? "Custom" : p.Name, filter, p.Pattern.Trim(),
                           string.IsNullOrWhiteSpace(p.JsonField) ? null : p.JsonField.Trim(),
                           new Dictionary<string, string>(p.Metrics ?? new(), StringComparer.OrdinalIgnoreCase),
                           (p.Tags ?? new()).Where(t => !string.IsNullOrWhiteSpace(t)).Select(t => t.Trim()).ToList());
    }

    /// <summary>
    /// Match one topic against a pattern. Segment counts must agree exactly — a pattern is a shape, and a
    /// prefix match would capture a sibling topic whose extra segments change what the value means.
    /// </summary>
    public static PatternMatch? Match(string pattern, string topic, string? jsonField,
                                      IReadOnlyDictionary<string, string>? metrics, string? sample = null)
    {
        if (string.IsNullOrWhiteSpace(pattern) || string.IsNullOrWhiteSpace(topic)) return null;

        var pp = pattern.Split('/');
        var tp = topic.Split('/');
        if (pp.Length != tp.Length) return null;

        string device = "", measure = "";
        for (var i = 0; i < pp.Length; i++)
        {
            var seg = pp[i];
            if (seg == "{device}") { device = tp[i]; continue; }
            if (seg == "{measure}") { measure = tp[i]; continue; }
            if (seg == "+") continue;
            if (seg.Contains('{'))
            {
                if (!Capture(seg, tp[i], metrics, ref device, ref measure)) return null;
                continue;
            }
            if (!string.Equals(seg, tp[i], StringComparison.OrdinalIgnoreCase)) return null;
        }
        if (device.Length == 0 || measure.Length == 0) return null;

        string? metric = null;
        metrics?.TryGetValue(measure, out metric);
        // A profile names the daily metric to say "this counter resets each day"; a binding carries that as
        // energy with a period counter, which is what the daily metric is derived from.
        string? accumulation = null;
        if (string.Equals(metric, EnergyPeriod.Metric, StringComparison.OrdinalIgnoreCase))
            (metric, accumulation) = ("energy", "period");
        return new PatternMatch(device, measure, topic, metric, jsonField, sample, accumulation);
    }

    /// A segment holding literals and up to two placeholders, e.g. <c>{device}_{measure}</c>.
    private static readonly Regex SegmentShape = new(
        @"^(?<pre>[^{}]*)\{(?<first>device|measure)\}(?:(?<mid>[^{}]*)\{(?<second>device|measure)\})?(?<post>[^{}]*)$",
        RegexOptions.Compiled);

    /// <summary>
    /// One segment that carries more than a bare placeholder.
    ///
    /// <para>
    /// A publisher that numbers its channels puts the device and the measure in one segment:
    /// <c>esphome/devices/n30/sensor/n30_2_1_current/state</c> is channel <c>n30_2_1</c> reporting current,
    /// written <c>{device}_{measure}</c>. Where that splits is ambiguous — <c>n30_2_1_apparent_power</c> is
    /// not channel <c>n30_2_1_apparent</c> measuring <c>power</c> — so the profile's own metric map decides:
    /// the split whose measure it names wins. With nothing to go on, the measure is the last part for
    /// <c>{device}_{measure}</c> and the first for <c>{measure}_{device}</c>.
    /// </para>
    /// </summary>
    private static bool Capture(string pattern, string segment, IReadOnlyDictionary<string, string>? metrics,
                               ref string device, ref string measure)
    {
        var shape = SegmentShape.Match(pattern);
        if (!shape.Success) return false;

        var pre = shape.Groups["pre"].Value;
        var post = shape.Groups["post"].Value;
        if (!segment.StartsWith(pre, StringComparison.OrdinalIgnoreCase)) return false;
        if (!segment.EndsWith(post, StringComparison.OrdinalIgnoreCase)) return false;
        var inner = segment[pre.Length..(segment.Length - post.Length)];
        if (inner.Length == 0) return false;

        var first = shape.Groups["first"].Value;
        if (!shape.Groups["second"].Success)
        {
            Assign(first, inner, ref device, ref measure);
            return true;
        }

        // Two placeholders need something between them to split on; '{device}{measure}' says nothing.
        var mid = shape.Groups["mid"].Value;
        if (mid.Length == 0) return false;
        var second = shape.Groups["second"].Value;
        var measureFirst = first == "measure";

        var splits = new List<(string First, string Second)>();
        for (var at = inner.IndexOf(mid, StringComparison.OrdinalIgnoreCase); at >= 0;
             at = inner.IndexOf(mid, at + 1, StringComparison.OrdinalIgnoreCase))
        {
            var left = inner[..at];
            var right = inner[(at + mid.Length)..];
            if (left.Length > 0 && right.Length > 0) splits.Add((left, right));
        }
        if (splits.Count == 0) return false;

        var chosen = splits.FirstOrDefault(s => metrics?.ContainsKey(measureFirst ? s.First : s.Second) == true);
        if (chosen == default) chosen = measureFirst ? splits[0] : splits[^1];

        Assign(first, chosen.First, ref device, ref measure);
        Assign(second, chosen.Second, ref device, ref measure);
        return true;
    }

    private static void Assign(string placeholder, string value, ref string device, ref string measure)
    {
        if (placeholder == "device") device = value;
        else measure = value;
    }

    /// <summary>
    /// Every reading a profile finds in <paramref name="topics"/>, ordered by device then measure.
    /// </summary>
    /// <param name="mappedOnly">Keep only measures the profile maps to a metric (drops uptime, wifi signal, and the like).</param>
    public static IReadOnlyList<PatternMatch> Scan(
        Profile profile, IEnumerable<(string Topic, string? Payload)> topics, bool mappedOnly = true)
    {
        var found = new List<PatternMatch>();
        foreach (var (topic, payload) in topics)
        {
            if (Match(profile.Pattern, topic, profile.JsonField, profile.Metrics, payload) is not { } m) continue;
            if (mappedOnly && m.Metric is null) continue;
            found.Add(m);
        }
        return found
            .OrderBy(m => m.Device, StringComparer.OrdinalIgnoreCase)
            .ThenBy(m => m.Measure, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
