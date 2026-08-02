namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Which period a moment belongs to, for <see cref="EnergyState.PeriodKWh"/>.
///
/// <para>
/// The period is a <b>local</b> day. That matters: "today" is what an operator reads off the Energy
/// Dashboard and what a utility bills against, and neither of them rolls over at UTC midnight. The zone is
/// resolved once and passed in, so the whole roll-up shares one boundary — nodes rolling at different
/// instants would reintroduce exactly the incomparability the period exists to remove.
/// </para>
/// </summary>
public static class EnergyPeriod
{
    /// <summary>
    /// The metric name the period total is published and graphed under. A metric of its own rather than a
    /// redefinition of <c>energy</c>, so the lifetime counters that Home Assistant and EmonCMS have already
    /// recorded history against keep meaning exactly what they meant.
    /// </summary>
    public const string Metric = "energytoday";

    /// <summary>Local time in <paramref name="zone"/> for an instant, whatever Kind the instant carries.</summary>
    public static DateTime Local(DateTime utc, TimeZoneInfo zone)
    {
        // A stored DateTime round-trips through JSON as Unspecified; treat it as the UTC it is, because
        // ConvertTimeFromUtc rejects a value already marked Local and would throw on a machine in a
        // non-UTC zone — a crash in the sampler rather than a wrong date.
        var instant = utc.Kind == DateTimeKind.Utc ? utc : DateTime.SpecifyKind(utc, DateTimeKind.Utc);
        return TimeZoneInfo.ConvertTimeFromUtc(instant, zone);
    }

    /// <summary>
    /// The key for the period <paramref name="utc"/> falls in.
    ///
    /// <para>
    /// <paramref name="startHour"/> moves the boundary off midnight — a utility whose day runs 06:00 to
    /// 06:00, a shift pattern, or simply a preference not to have the chart reset while someone is looking
    /// at it. Shifting the local clock back by that many hours and then taking the date does the whole job:
    /// 05:00 with a start hour of 6 lands on the previous day's key, which is what "the day that began at
    /// 06:00 yesterday" means.
    /// </para>
    /// </summary>
    public static string KeyFor(DateTime utc, TimeZoneInfo zone, int startHour = 0)
        => Local(utc, zone).AddHours(-Clamp(startHour)).ToString("yyyy-MM-dd");

    /// <summary>When the current period ends, as an instant. What the GUI shows as "next rollover".</summary>
    public static DateTime NextRollover(DateTime utc, TimeZoneInfo zone, int startHour = 0)
    {
        var hour = Clamp(startHour);
        var local = Local(utc, zone);
        // The next boundary is the start hour on the next day whose shifted date differs from this one's.
        var next = local.Date.AddHours(hour);
        if (next <= local) next = next.AddDays(1);
        return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(next, DateTimeKind.Unspecified), zone);
    }

    /// <summary>A start hour outside 0–23 is a typo, not an instruction; midnight is the honest reading.</summary>
    private static int Clamp(int startHour) => startHour is >= 0 and <= 23 ? startHour : 0;

    /// <summary>
    /// Every zone this host can resolve, so the GUI offers a list instead of a text box whose typos surface
    /// only as a log line months later. Host-dependent by nature — a container without tzdata has almost
    /// none, and showing that honestly is more useful than a hard-coded list that then fails to resolve.
    /// </summary>
    public static IReadOnlyList<string> AvailableZones()
    {
        try
        {
            return TimeZoneInfo.GetSystemTimeZones().Select(z => z.Id).OrderBy(z => z, StringComparer.Ordinal).ToList();
        }
        catch (Exception)
        {
            return Array.Empty<string>();
        }
    }

    /// <summary>
    /// The zone named by <paramref name="id"/> (IANA, e.g. "America/Chicago"), or the host's local zone when
    /// blank. An unknown id falls back to local and says so: rolling over at the wrong hour is a far smaller
    /// problem than refusing to start, but it is not something to discover silently months later.
    /// </summary>
    public static TimeZoneInfo Resolve(string? id, Action<string>? warn = null)
    {
        if (string.IsNullOrWhiteSpace(id)) return TimeZoneInfo.Local;
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(id.Trim());
        }
        catch (Exception ex) when (ex is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            warn?.Invoke($"Unknown energy period time zone '{id}' ({ex.Message}); using the host's local zone "
                       + $"({TimeZoneInfo.Local.Id}) instead. Daily totals will roll over on that zone's midnight.");
            return TimeZoneInfo.Local;
        }
    }
}
