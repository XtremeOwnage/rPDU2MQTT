using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.Config;

public class Overrides
{
    /// <summary>
    /// Allows overriding the generated entity ID for the PDU.
    /// </summary>
    public string? PduID { get; set; } = null;

    /// <summary>
    /// Allows overriding the generated entity name for the PDU.
    /// </summary>
    public string? PduName { get; set; } = null;
}

/// <summary>
/// Defines overrides for measurements.
/// </summary>
public class MeasurementOverrides : TypeOverride { }

/// <summary>
/// Defines overrides for outlets.
/// </summary>
public class OutletOverrides : TypeOverride { }
