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

    /// <summary>The unit the flow/exports express <paramref name="metric"/> in (blank for the unitless power factor).</summary>
    public static string Canonical(string metric) => Table.TryGetValue(metric, out var t) ? t.Canonical : "";

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
