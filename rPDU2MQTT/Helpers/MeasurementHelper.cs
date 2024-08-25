using rPDU2MQTT.Models.HomeAssistant.Enums;
using rPDU2MQTT.Models.HomeAssistant.ObjectDTOs;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Helpers;

public static class MeasurementHelper
{
    /// <summary>
    /// Parse measurement into Home Assistant.
    /// </summary>
    /// <param name="measurement"></param>
    /// <returns>Bool which indicates if this is a valid, supported measurement.</returns>
    public static SensorDTO? TryParseValue(this Measurement measurement)
    {
        return measurement.Type.ToLower() switch
        {
            "currentcrestfactor" => null,
            "balance" => null,
            "apparentpower" => new SensorDTO(StateClass.Measurement, DeviceClass.ApparentPower, "apparentPower"),
            "realpower" => new SensorDTO(StateClass.Measurement, DeviceClass.Power, "power"),
            "energy" => new SensorDTO(StateClass.TotalIncreasing, DeviceClass.Energy, "energy"),
            "powerfactor" => new SensorDTO(StateClass.Measurement, DeviceClass.PowerFactor, "powerFactor"),
            "current" => new SensorDTO(StateClass.Measurement, DeviceClass.Current, "current"),
            "voltage" => new SensorDTO(StateClass.Measurement, DeviceClass.Voltage, "voltage"),
            _ => null
        };
    }
}
