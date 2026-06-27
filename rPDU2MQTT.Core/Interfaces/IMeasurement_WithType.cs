namespace rPDU2MQTT.Interfaces;

/// <summary>
/// Represents a measurement, with a type.
/// </summary>
public interface IMeasurement_WithType
{
    /// <summary>
    /// What type of measurement is this?
    /// </summary>
    public string Type { get; set; }
}
