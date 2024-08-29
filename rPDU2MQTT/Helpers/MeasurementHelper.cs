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
            "apparentpower" => new SensorDTO(StateClass.Measurement, DeviceClass.ApparentPower),
            "realpower" => new SensorDTO(StateClass.Measurement, DeviceClass.Power),
            "energy" => new SensorDTO(StateClass.TotalIncreasing, DeviceClass.Energy),
            "powerfactor" => new SensorDTO(StateClass.Measurement, DeviceClass.PowerFactor),
            "current" => new SensorDTO(StateClass.Measurement, DeviceClass.Current),
            "voltage" => new SensorDTO(StateClass.Measurement, DeviceClass.Voltage),
            _ => null
        };
    }
}
