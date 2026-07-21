namespace rPDU2MQTT.Abstractions.Flow;

/// <summary>
/// The measurement vocabulary the flow rolls up, one roll-up per metric. Typed rather than stringly so a
/// binding can't carry a typo. The canonical wire/string form (used by config and the PDU pipeline) is
/// available via <see cref="Metrics.CanonicalName"/> — adapters map at the edge; the contract stays typed.
/// </summary>
public enum Metric
{
    RealPower,
    ApparentPower,
    Energy,
    Current,
    Voltage,
    Frequency,
    PowerFactor,
}

/// <summary>Maps <see cref="Metric"/> to/from the canonical lowercase names used across config and exports.</summary>
public static class Metrics
{
    public static string CanonicalName(this Metric metric) => metric switch
    {
        Metric.RealPower => "realpower",
        Metric.ApparentPower => "apparentpower",
        Metric.Energy => "energy",
        Metric.Current => "current",
        Metric.Voltage => "voltage",
        Metric.Frequency => "frequency",
        Metric.PowerFactor => "powerfactor",
        _ => metric.ToString().ToLowerInvariant(),
    };

    public static bool TryParse(string? name, out Metric metric)
    {
        switch ((name ?? "").Trim().ToLowerInvariant())
        {
            case "realpower": metric = Metric.RealPower; return true;
            case "apparentpower": metric = Metric.ApparentPower; return true;
            case "energy": metric = Metric.Energy; return true;
            case "current": metric = Metric.Current; return true;
            case "voltage": metric = Metric.Voltage; return true;
            case "frequency": metric = Metric.Frequency; return true;
            case "powerfactor": metric = Metric.PowerFactor; return true;
            default: metric = default; return false;
        }
    }
}
