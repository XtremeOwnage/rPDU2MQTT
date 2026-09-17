namespace rPDU2MQTT.Services;

/// <summary>
/// Unit strings as Home Assistant spells them (#483). Knowing how a vendor names things is the vendor
/// integration's business, so this sits with the discovery service rather than in Core.
///
/// <para>
/// A device reports its units in whatever spelling its firmware uses — a Vertiv rPDU reports voltage as
/// <c>Vrms</c>. Home Assistant validates the unit against the entity's device class and refuses the whole
/// discovery config when it does not recognise it, so every outlet lost its voltage sensor to
/// <c>The unit of measurement `Vrms` is not valid together with device class `voltage`</c>. Only what goes
/// to Home Assistant is translated; MQTT payloads and the other exports keep the device's own wording.
/// </para>
/// </summary>
public static class HomeAssistantUnits
{
    /// <summary>Device spellings Home Assistant will not take, and the ones it will.</summary>
    private static readonly Dictionary<string, string> Rewritten = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Vrms"] = "V",
        ["mVrms"] = "mV",
        ["kVrms"] = "kV",
        ["Arms"] = "A",
        ["mArms"] = "mA",
    };

    /// <summary>
    /// The unit to publish in a discovery config. A unit with no rewrite is published as the device wrote it:
    /// an unknown unit is better than a wrong one, and Home Assistant only refuses the ones it knows are wrong
    /// for a device class.
    /// </summary>
    public static string? ForDiscovery(string? units)
    {
        if (string.IsNullOrWhiteSpace(units)) return units;
        return Rewritten.TryGetValue(units.Trim(), out var accepted) ? accepted : units;
    }
}
