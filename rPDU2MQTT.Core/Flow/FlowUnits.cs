namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Per-metric unit vocabulary and conversion (#129). A live source can publish in whatever unit its device
/// speaks (Solar Assistant's kW, a meter's Wh); binding a <c>Unit</c> lets us normalise every reading to the
/// metric's canonical unit on ingest, so the flow roll-up and every export stay in one consistent unit
/// (W for power, kWh for energy, …) regardless of where the number came from.
/// </summary>
public static class FlowUnits
{
    // metric key (matches the PDU Measurement.Type / graph metric) -> canonical unit + {unit -> factor to it}.
    private static readonly Dictionary<string, (string Canonical, Dictionary<string, double> Factors)> Table =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["realpower"] = ("W", new(StringComparer.OrdinalIgnoreCase) { ["W"] = 1, ["kW"] = 1_000, ["MW"] = 1_000_000 }),
            ["apparentpower"] = ("VA", new(StringComparer.OrdinalIgnoreCase) { ["VA"] = 1, ["kVA"] = 1_000 }),
            ["energy"] = ("kWh", new(StringComparer.OrdinalIgnoreCase) { ["kWh"] = 1, ["Wh"] = 0.001, ["MWh"] = 1_000 }),
            ["current"] = ("A", new(StringComparer.OrdinalIgnoreCase) { ["A"] = 1, ["mA"] = 0.001 }),
            ["voltage"] = ("V", new(StringComparer.OrdinalIgnoreCase) { ["mV"] = 0.001, ["V"] = 1, ["kV"] = 1_000 }),
            ["frequency"] = ("Hz", new(StringComparer.OrdinalIgnoreCase) { ["Hz"] = 1 }),
            ["powerfactor"] = ("", new(StringComparer.OrdinalIgnoreCase) { [""] = 1 }),
        };

    /// <summary>The unit the flow/exports express <paramref name="metric"/> in (blank for the unitless power factor).</summary>
    public static string Canonical(string metric) => Table.TryGetValue(metric, out var t) ? t.Canonical : "";

    /// <summary>The input units offered for <paramref name="metric"/>, canonical first-or-natural order.</summary>
    public static IReadOnlyList<string> UnitsFor(string metric)
        => Table.TryGetValue(metric, out var t) ? t.Factors.Keys.ToList() : Array.Empty<string>();

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
