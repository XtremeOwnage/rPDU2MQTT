namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Cross-checks a <c>split</c> power source's sign convention against the node's own in/out energy counters.
///
/// <para>
/// A <c>split</c> source fans one signed number into two directions: positive is <em>out</em> (battery
/// discharge, grid import), the magnitude of negative is <em>in</em> (charge, export). Half the devices in
/// the world use the opposite convention, and getting it backwards is invisible — the diagram still balances,
/// the numbers are still plausible, and the only symptom is that a charging battery reads as discharging.
/// </para>
/// <para>
/// Seen on a live system: Solar Assistant publishes battery power positive while charging, so a battery
/// taking 1.65 kW <em>in</em> was drawn as 1.77 kW coming <em>out</em>. It cost twice its own magnitude on
/// the headline figure, because a charging battery is a load and was being added where it should have been
/// subtracted — home read 11.3 kW against an actual 7.0 kW.
/// </para>
/// <para>
/// The check exists because we already hold the answer. A node like that usually also binds explicit
/// <c>in</c> and <c>out</c> <em>energy</em> counters, on separate topics with no sign convention to get
/// wrong. When those counters say the battery has been charging all day and the power source says it is
/// discharging right now, they cannot both be right, and the energy counters are the ones that cannot be
/// misread. Reporting the contradiction is not the same as resolving it — the fix is <c>Scale: -1</c> on the
/// source, which is the operator's to apply — but nobody can apply a fix they have no way of noticing.
/// </para>
/// </summary>
public static class DirectionAudit
{
    /// <summary>
    /// Does the sign of <paramref name="powerOut"/>/<paramref name="powerIn"/> disagree with which of the
    /// node's energy counters has actually been rising?
    ///
    /// <para>
    /// The comparison is against a <b>recent window</b>, not against the day. A grid connection and a battery
    /// both reverse direction as a matter of course — importing overnight and exporting at noon, discharging
    /// in the evening and charging in the morning — so "the day was mostly import" says nothing about which
    /// way the power is going right now. An earlier version compared against the day's totals and duly
    /// warned about a grid that was exporting 150 W on an otherwise import-heavy afternoon, which was simply
    /// the truth. A warning that fires on normal behaviour is worse than no warning: it gets ignored, and
    /// then the real one gets ignored too.
    /// </para>
    /// <para>
    /// The counters are the honest witness because they are explicit — separate topics for in and out, no
    /// sign convention to get backwards. If the out counter is the one climbing while the power source
    /// insists energy is flowing in, those two cannot both be describing the same interval.
    /// </para>
    /// </summary>
    /// <param name="powerOut">Power the node is supplying right now (the <c>out</c> lane), in W.</param>
    /// <param name="powerIn">Power the node is drawing right now (the <c>in</c> lane), in W.</param>
    /// <param name="outRiseKWh">How much the out counter rose across the comparison window.</param>
    /// <param name="inRiseKWh">How much the in counter rose across the comparison window.</param>
    public static bool LooksInverted(double powerOut, double powerIn, double outRiseKWh, double inRiseKWh)
    {
        // Below this a power reading is standby noise, not a direction.
        const double PowerFloor = 50;      // W
        // Counters publish at coarse resolution (often 0.1 kWh), so a window has to have moved by more than
        // one tick before its direction means anything.
        const double RiseFloor = 0.15;     // kWh
        // How one-sided the window must be. Both counters moving means the node reversed inside it, which is
        // normal and tells us nothing.
        const double Ratio = 4;

        var flowingOut = powerOut > PowerFloor && powerIn <= PowerFloor;
        var flowingIn = powerIn > PowerFloor && powerOut <= PowerFloor;
        if (!flowingOut && !flowingIn) return false;

        var roseIn = inRiseKWh > RiseFloor && inRiseKWh > outRiseKWh * Ratio;
        var roseOut = outRiseKWh > RiseFloor && outRiseKWh > inRiseKWh * Ratio;

        // Power says one way; the counter that actually moved over the same window says the other.
        return (flowingOut && roseIn) || (flowingIn && roseOut);
    }

    /// <summary>The warning to log for a node whose convention looks inverted. Shaped as an instruction,
    /// because the operator can fix it in one field and otherwise has no way to know.</summary>
    public static string Explain(string nodeId, double powerOut, double powerIn, double outRiseKWh, double inRiseKWh)
        => $"Node '{nodeId}': its split power source reads "
         + (powerOut > powerIn ? $"{powerOut:0} W flowing OUT (discharge/import)" : $"{powerIn:0} W flowing IN (charge/export)")
         + $", but over the same window the counters moved the other way — {inRiseKWh:0.##} kWh in against "
         + $"{outRiseKWh:0.##} kWh out. The energy counters come from separate topics with no sign convention "
         + "to get wrong, so this source's sign is most likely inverted for this device. Set Scale: -1 on it. "
         + "Until then its contribution is counted on the wrong side of every total that includes it.";
}
