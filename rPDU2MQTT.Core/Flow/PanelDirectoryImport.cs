using System.Text.RegularExpressions;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Core.Flow;

/// <summary>One line of a pasted panel directory, read as far as it could be (#455).</summary>
/// <param name="Channel">The monitor channel the line names, as a node id: "N30,1,5" reads as "n30_1_5".</param>
/// <param name="Note">Why the line was not read, when it was not.</param>
public sealed record DirectoryRow(
    string Line, string Number, int Slot, int Poles, int? Half, string Wire, int? Amps,
    string Channel, string Description, string State, string? Note)
{
    public bool Ok => Note is null;
}

/// <summary>
/// Reads a panel directory as people keep them (#455): breaker number, wire label, monitor channel and what the
/// breaker feeds, in whatever order the line happens to carry them, plus the "????" and "Unused" marks.
/// Reading only: what is written is decided by the page, after the operator has seen the preview.
/// </summary>
public static partial class PanelDirectoryImport
{
    [GeneratedRegex(@"^(?:[Bb])?(\d{1,3})(?:\.(\d))?$")]
    private static partial Regex SingleBreaker();

    /// <summary>A two-pole breaker as a directory writes it: the two slots it holds, "1,3" or "2,4".</summary>
    [GeneratedRegex(@"^(?:[Bb])?(\d{1,3})\s*[,/]\s*(?:[Bb])?(\d{1,3})$")]
    private static partial Regex DoubleBreaker();

    [GeneratedRegex(@"^[Ww](\d{1,3}[A-Za-z]?)$")]
    private static partial Regex WireLabel();

    [GeneratedRegex(@"^(\d{1,3})\s*[Aa]$")]
    private static partial Regex AmpsLabel();

    /// <summary>A monitor channel as a directory writes it: a unit and its inputs, "N30,1,5" or "N30 1 5".</summary>
    [GeneratedRegex(@"^([A-Za-z][A-Za-z0-9-]{0,15})[,\s_]+(\d{1,3})[,\s_]+(\d{1,3})$")]
    private static partial Regex ChannelThree();

    /// <summary>The same with one input: "N30,5".</summary>
    [GeneratedRegex(@"^([A-Za-z][A-Za-z0-9-]{0,15})[,\s_]+(\d{1,3})$")]
    private static partial Regex ChannelTwo();

    [GeneratedRegex(@"\?{3,}")]
    private static partial Regex Unidentified();

    /// <summary>A channel as the bridge names its nodes: lower case, joined by underscores.</summary>
    public static string ChannelId(string unit, params string[] inputs) =>
        string.Join('_', new[] { unit.ToLowerInvariant() }.Concat(inputs)).Replace('-', '_');

    /// <summary>Read a pasted directory, a line at a time. Lines that say nothing are left out; lines that cannot be read are kept with why.</summary>
    public static IReadOnlyList<DirectoryRow> Parse(string? text)
    {
        var rows = new List<DirectoryRow>();
        foreach (var raw in (text ?? "").Replace("\r\n", "\n").Replace('\r', '\n').Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#') || line.StartsWith("//", StringComparison.Ordinal)) continue;
            rows.Add(ParseLine(line));
        }
        return rows;
    }

    /// <summary>One line: the parts it carries, in whatever order, and what it feeds.</summary>
    public static DirectoryRow ParseLine(string line)
    {
        var blank = new DirectoryRow(line, "", 0, 1, null, "", null, "", "", BreakerState.Unknown, null);
        var parts = line.Split(':', StringSplitOptions.TrimEntries).Where(p => p.Length > 0).ToList();
        if (parts.Count == 0) return blank with { Note = "Nothing on the line." };

        // Everything before the last colon is the labels; what follows is what the breaker feeds. A line with no
        // colon is all labels — the breaker nobody has written a description for.
        var head = parts[0];

        var tokens = head.Split(',', StringSplitOptions.TrimEntries).Where(t => t.Length > 0).ToList();
        if (tokens.Count == 0) return blank with { Note = "No breaker number on the line." };

        // The breaker number: one slot ("B06", "26.1") or the two a double-pole holds ("1,3").
        string number; int slot, poles = 1; int? half = null; var used = 1;
        if (tokens.Count >= 2 && DoubleBreaker().Match($"{tokens[0]},{tokens[1]}") is { Success: true } two)
        {
            number = $"{tokens[0]},{tokens[1]}";
            slot = int.Parse(two.Groups[1].Value);
            poles = Math.Abs(int.Parse(two.Groups[2].Value) - slot) == 2 ? 2 : 1;
            used = 2;
        }
        else if (SingleBreaker().Match(tokens[0]) is { Success: true } one)
        {
            number = tokens[0];
            slot = int.Parse(one.Groups[1].Value);
            if (one.Groups[2].Success) half = int.Parse(one.Groups[2].Value);
        }
        else return blank with { Note = $"“{tokens[0]}” does not read as a breaker number." };

        var wire = ""; int? amps = null; var channel = "";
        var rest = new List<string>();
        // Whatever a run of tokens carries besides the number: a wire, a rating, or a channel written across
        // two or three of them. What is left over is words.
        void ReadLabels(List<string> tokens, int from)
        {
            for (var i = from; i < tokens.Count; i++)
            {
                var t = tokens[i];
                if (WireLabel().IsMatch(t) && wire.Length == 0) { wire = t.ToUpperInvariant(); continue; }
                if (AmpsLabel().Match(t) is { Success: true } a && amps is null) { amps = int.Parse(a.Groups[1].Value); continue; }
                if (channel.Length == 0 && i + 2 < tokens.Count && ChannelThree().Match($"{t},{tokens[i + 1]},{tokens[i + 2]}") is { Success: true } three)
                {
                    channel = ChannelId(three.Groups[1].Value, three.Groups[2].Value, three.Groups[3].Value);
                    i += 2;
                    continue;
                }
                if (channel.Length == 0 && i + 1 < tokens.Count && ChannelTwo().Match($"{t},{tokens[i + 1]}") is { Success: true } twoPart)
                {
                    channel = ChannelId(twoPart.Groups[1].Value, twoPart.Groups[2].Value);
                    i += 1;
                    continue;
                }
                rest.Add(t);
            }
        }
        ReadLabels(tokens, used);

        // A part after a colon that is nothing but labels — "B24: W20: Master Bedroom Outlets" — is read as labels.
        var after = parts.Skip(1).ToList();
        while (after.Count > 1)
        {
            var bits = after[0].Split(',', StringSplitOptions.TrimEntries).Where(x => x.Length > 0).ToList();
            var before = rest.Count;
            var hadWire = wire.Length > 0; var hadChannel = channel.Length > 0; var hadAmps = amps is not null;
            ReadLabels(bits, 0);
            var readSomething = (wire.Length > 0 && !hadWire) || (channel.Length > 0 && !hadChannel) || (amps is not null && !hadAmps);
            if (!readSomething || rest.Count != before) { rest.RemoveRange(before, rest.Count - before); break; }
            after.RemoveAt(0);
        }
        var tail = string.Join(": ", after);

        // What it feeds, and anything the labels left over — a description written before the colon.
        var description = string.Join(", ", rest.Append(tail).Where(x => !string.IsNullOrWhiteSpace(x))).Trim();

        // A channel written among the words: "B25: Office, N30,1,2".
        if (channel.Length == 0 && description.Length > 0)
        {
            var words = description.Split(',', StringSplitOptions.TrimEntries).Where(x => x.Length > 0).ToList();
            for (var i = 0; i + 2 < words.Count + 1 && channel.Length == 0; i++)
            {
                if (i + 2 < words.Count && ChannelThree().IsMatch($"{words[i]},{words[i + 1]},{words[i + 2]}"))
                {
                    var m = ChannelThree().Match($"{words[i]},{words[i + 1]},{words[i + 2]}");
                    channel = ChannelId(m.Groups[1].Value, m.Groups[2].Value, m.Groups[3].Value);
                    words.RemoveRange(i, 3);
                }
                else if (i + 1 < words.Count && ChannelThree().IsMatch(words[i] + "," + words[i + 1]) is false && ChannelTwo().IsMatch($"{words[i]},{words[i + 1]}") && words[i].Any(char.IsLetter))
                {
                    var m = ChannelTwo().Match($"{words[i]},{words[i + 1]}");
                    channel = ChannelId(m.Groups[1].Value, m.Groups[2].Value);
                    words.RemoveRange(i, 2);
                }
            }
            description = string.Join(", ", words);
        }

        // The directory's own marks: "????" for a circuit nobody has identified, "Unused" for an empty one.
        var state = BreakerState.Identified;
        if (Unidentified().IsMatch(description)) { state = BreakerState.Unknown; description = Unidentified().Replace(description, "").Trim(' ', ',', '.'); }
        else if (description.Trim().Equals("unused", StringComparison.OrdinalIgnoreCase) || description.Trim().Equals("spare", StringComparison.OrdinalIgnoreCase))
        { state = BreakerState.Unused; description = ""; }
        else if (description.Length == 0) state = BreakerState.Unknown;

        return new DirectoryRow(line, number, slot, poles, half, wire, amps, channel, description, state, null);
    }

    /// <summary>What importing a row would do to a panel: fill a new slot, or update the breaker already there.</summary>
    public static string Effect(PanelConfig panel, DirectoryRow row)
    {
        if (!row.Ok) return "skipped";
        var existing = panel.Breakers.FirstOrDefault(b => string.Equals(b.Number, row.Number, StringComparison.OrdinalIgnoreCase));
        if (existing is not null) return "update";
        var clash = panel.Breakers.FirstOrDefault(b => b.Occupies().Contains(row.Slot) && (b.Half is null || row.Half is null || b.Half == row.Half));
        return clash is null ? "add" : "clash";
    }
}
