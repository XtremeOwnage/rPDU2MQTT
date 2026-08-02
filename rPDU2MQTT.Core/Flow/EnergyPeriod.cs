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

    /// <summary>The key for the local day <paramref name="utc"/> falls in.</summary>
    public static string KeyFor(DateTime utc, TimeZoneInfo zone)
    {
        // A stored DateTime round-trips through JSON as Unspecified; treat it as the UTC it is, because
        // ConvertTimeFromUtc rejects a value already marked Local and would throw on a machine in a
        // non-UTC zone — a crash in the sampler rather than a wrong date.
        var instant = utc.Kind == DateTimeKind.Utc ? utc : DateTime.SpecifyKind(utc, DateTimeKind.Utc);
        return TimeZoneInfo.ConvertTimeFromUtc(instant, zone).ToString("yyyy-MM-dd");
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
