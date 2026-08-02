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
    /// Does the sign of <paramref name="powerOut"/>/<paramref name="powerIn"/> disagree with what the day's
    /// energy counters say the node has actually been doing?
    ///
    /// <para>
    /// True only when the disagreement is unambiguous: one direction of power is live and non-trivial, the
    /// energy counters clearly favour the other direction, and neither figure is small enough to be noise.
    /// A battery that is genuinely idle, or one that has done a bit of both today, is not evidence of
    /// anything and must not raise a warning that then gets ignored.
    /// </para>
    /// </summary>
    /// <param name="powerOut">Power the node is supplying right now (the <c>out</c> lane), in W.</param>
    /// <param name="powerIn">Power the node is drawing right now (the <c>in</c> lane), in W.</param>
    /// <param name="energyOutToday">Energy supplied so far this period, kWh.</param>
    /// <param name="energyInToday">Energy drawn so far this period, kWh.</param>
    public static bool LooksInverted(double powerOut, double powerIn, double energyOutToday, double energyInToday)
    {
        // Below this a reading is noise, not a direction: a few watts of standby, a few Wh of rounding.
        const double PowerFloor = 50;      // W
        const double EnergyFloor = 0.5;    // kWh
        // How lopsided the day has to be before it counts as evidence. A battery that cycled both ways today
        // says nothing about which way it is going right now.
        const double Ratio = 5;

        var flowingOut = powerOut > PowerFloor && powerIn <= PowerFloor;
        var flowingIn = powerIn > PowerFloor && powerOut <= PowerFloor;
        if (!flowingOut && !flowingIn) return false;

        var dayWasIn = energyInToday > EnergyFloor && energyInToday > energyOutToday * Ratio;
        var dayWasOut = energyOutToday > EnergyFloor && energyOutToday > energyInToday * Ratio;

        // Power says one way, the whole day's metered energy says the other.
        return (flowingOut && dayWasIn) || (flowingIn && dayWasOut);
    }

    /// <summary>The warning to log for a node whose convention looks inverted. Shaped as an instruction,
    /// because the operator can fix it in one field and otherwise has no way to know.</summary>
    public static string Explain(string nodeId, double powerOut, double powerIn, double energyOutToday, double energyInToday)
        => $"Node '{nodeId}': its split power source reads "
         + (powerOut > powerIn ? $"{powerOut:0} W flowing OUT (discharge/import)" : $"{powerIn:0} W flowing IN (charge/export)")
         + $", but today's metered energy says the opposite — {energyInToday:0.##} kWh in against {energyOutToday:0.##} kWh out. "
         + "The energy counters come from separate topics with no sign convention to get wrong, so the power "
         + "source's sign is most likely inverted for this device. Set Scale: -1 on it. Until then a charging "
         + "battery is counted as supplying the house rather than loading it, which roughly doubles its error "
         + "on any total that includes it.";
}
