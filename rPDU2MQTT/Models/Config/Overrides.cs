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

    /// <summary>
    /// Allows overriding the generated "name" for each outlet.
    /// </summary>
    /// <remarks>
    /// This maps to <see cref="Models.HomeAssistant.baseClasses.baseEntity.Name"/>, ie, "object_id"
    /// </remarks>
    public Dictionary<int, string> OutletID { get; set; } = new();

    /// <summary>
    /// Allows overriding the "Display Name" for each outlet.
    /// </summary>
    /// <remarks>
    /// This maps to <see cref="Models.HomeAssistant.baseClasses.baseEntity.DisplayName"/>, ie, "name"
    /// </remarks>
    public Dictionary<int, string> OutletName { get; set; } = new();

    /// <summary>
    /// Allows overriding the generated Entity ID for measurements.
    /// </summary>
    public Dictionary<string, string> MeasurementID { get; set; } = new();

    /// <summary>
    /// Allows overriding the generated Entity Name for measurements.
    /// </summary>
    public Dictionary<string, string> MeasurementName { get; set; } = new();
}
