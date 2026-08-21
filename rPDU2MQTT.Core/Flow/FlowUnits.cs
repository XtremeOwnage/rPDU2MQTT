namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Per-metric unit vocabulary and conversion (#129). A live source can publish in whatever unit its device
/// speaks (Solar Assistant's kW, a meter's Wh); binding a <c>Unit</c> lets us normalise every reading to the
/// metric's canonical unit on ingest, so the flow roll-up and every export stay in one consistent unit
/// (W for power, kWh for energy, …) regardless of where the number came from.
///
/// It also records whether a metric is <b>additive</b>, which decides whether the flow may roll it up at
/// all — see <see cref="IsAdditive"/>.
/// </summary>
public static class FlowUnits
{
    // metric key (matches the PDU Measurement.Type / graph metric) -> canonical unit, {unit -> factor to
    // it}, and whether the quantity adds up the tree.
    private static readonly Dictionary<string, (string Canonical, Dictionary<string, double> Factors, bool Additive)> Table =
        new(StringComparer.OrdinalIgnoreCase)
        {
            // --- Extensive: quantities that flow, and therefore sum from the leaves upward. ---
            ["realpower"] = ("W", new(StringComparer.OrdinalIgnoreCase) { ["W"] = 1, ["kW"] = 1_000, ["MW"] = 1_000_000 }, true),
            ["apparentpower"] = ("VA", new(StringComparer.OrdinalIgnoreCase) { ["VA"] = 1, ["kVA"] = 1_000 }, true),
            ["energy"] = ("kWh", new(StringComparer.OrdinalIgnoreCase) { ["kWh"] = 1, ["Wh"] = 0.001, ["MWh"] = 1_000 }, true),
            // Energy since the current period (local day) began. Same quantity and unit as `energy`; it
            // exists separately because only these totals share an epoch and may therefore be compared
            // across nodes — see EnergyPeriod.
            [EnergyPeriod.Metric] = ("kWh", new(StringComparer.OrdinalIgnoreCase) { ["kWh"] = 1, ["Wh"] = 0.001, ["MWh"] = 1_000 }, true),
            ["current"] = ("A", new(StringComparer.OrdinalIgnoreCase) { ["A"] = 1, ["mA"] = 0.001 }, true),
            // --- Intensive: a condition at a point, not a quantity that flows. Never summed. ---
            ["voltage"] = ("V", new(StringComparer.OrdinalIgnoreCase) { ["mV"] = 0.001, ["V"] = 1, ["kV"] = 1_000 }, false),
            ["frequency"] = ("Hz", new(StringComparer.OrdinalIgnoreCase) { ["Hz"] = 1 }, false),
            ["powerfactor"] = ("", new(StringComparer.OrdinalIgnoreCase) { [""] = 1 }, false),
            // Battery state of charge — a percentage: read for display (the Energy tile), never summed
            // across nodes. Fraction inputs (0–1) scale to a percentage.
            ["soc"] = ("%", new(StringComparer.OrdinalIgnoreCase) { ["%"] = 1, ["fraction"] = 100 }, false),
            // Any other ratio a device reports: load %, fan speed %, humidity. Same rule as soc.
            ["percent"] = ("%", new(StringComparer.OrdinalIgnoreCase) { ["%"] = 1, ["fraction"] = 100 }, false),
            // Inlet / battery / ambient temperature. Fahrenheit is an offset scale, not a factor, so it is
            // deliberately absent: bind °C or K, or use Scale on the source.
            ["temperature"] = ("°C", new(StringComparer.OrdinalIgnoreCase) { ["°C"] = 1, ["C"] = 1, ["K"] = 1 }, false),
        };

    /// <summary>
    /// Every metric this build understands, in the order they are listed above.
    ///
    /// <para>
    /// The table is the authority on what a metric name may be, so anything offering a choice of metric
    /// reads it from here. Retyping the list — the GUI did, the config attributes did — is how a name gets
    /// added in one place and silently missing in another.
    /// </para>
    /// </summary>
    public static readonly string[] Metrics = Table.Keys.ToArray();

    /// <summary>The unit the flow/exports express <paramref name="metric"/> in (blank for the unitless power factor).</summary>
    public static string Canonical(string metric) => Table.TryGetValue(metric, out var t) ? t.Canonical : "";

    /// <summary>
    /// When a metric's readings started counting, which decides what may be drawn from them over a window.
    /// <list type="bullet">
    /// <item><c>instant</c> — a condition sampled at a moment (power, current, voltage). Never added up.</item>
    /// <item><c>period</c> — a total that re-bases each period, so one reading is that period's own figure
    /// and a chart of them is a chart of daily energy.</item>
    /// <item><c>lifetime</c> — a counter that never re-bases. A reading is everything since the meter was
    /// installed, so a chart of them is a staircase and the difference between two of them is the only
    /// quantity in there.</item>
    /// </list>
    /// </summary>
    public static string Epoch(string metric)
        => string.Equals(metric, EnergyPeriod.Metric, StringComparison.OrdinalIgnoreCase) ? "period"
         : string.Equals(Canonical(metric), "kWh", StringComparison.Ordinal) ? "lifetime"
         : "instant";

    /// <summary>The input units offered for <paramref name="metric"/>, canonical first-or-natural order.</summary>
    public static IReadOnlyList<string> UnitsFor(string metric)
        => Table.TryGetValue(metric, out var t) ? t.Factors.Keys.ToList() : Array.Empty<string>();

    /// <summary>
    /// Does this quantity add up the tree? Power, energy, apparent power and current are <i>extensive</i>:
    /// the outlets' watts really do sum to the PDU's. Voltage, frequency, power factor, state of charge,
    /// temperature and any other ratio are <i>intensive</i> — they describe a condition at a point, and
    /// adding them states a number that was never true anywhere. Three 120 V outlets do not make a 360 V
    /// PDU, which is exactly what the roll-up reported before this existed.
    /// <para>
    /// An unrecognised metric is treated as additive, preserving the behaviour for any custom name; add it
    /// to the table above to classify it.
    /// </para>
    /// </summary>
    public static bool IsAdditive(string metric) => !Table.TryGetValue(metric, out var t) || t.Additive;

    /// <summary>
    /// Factor to multiply a reading in <paramref name="unit"/> by to express it in <paramref name="metric"/>'s
    /// canonical unit. A blank/unknown unit is treated as already canonical (factor 1), so a binding with no
    /// declared unit behaves exactly as before this existed.
    /// </summary>
    public static double ToCanonicalFactor(string metric, string? unit)
    {
        if (string.IsNullOrWhiteSpace(unit)) return 1;
        return Table.TryGetValue(metric, out var t) && t.Factors.TryGetValue(unit.Trim(), out var f) ? f : 1;
    }
}
