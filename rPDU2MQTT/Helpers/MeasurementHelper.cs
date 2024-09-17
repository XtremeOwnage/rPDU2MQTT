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
            //"currentcrestfactor" => new SensorDTO(StateClass.Measurement, DeviceClass.Unknown),
            //"balance" => new SensorDTO(StateClass.Measurement, DeviceClass.Unknown),
            "apparentpower" => new SensorDTO(StateClass.Measurement, DeviceClass.ApparentPower),
            "realpower" => new SensorDTO(StateClass.Measurement, DeviceClass.Power),
            "energy" => new SensorDTO(StateClass.TotalIncreasing, DeviceClass.Energy),
            "powerfactor" => new SensorDTO(StateClass.Measurement, DeviceClass.PowerFactor),
            "current" => new SensorDTO(StateClass.Measurement, DeviceClass.Current),
            "voltage" => new SensorDTO(StateClass.Measurement, DeviceClass.Voltage),
            "accumulatedco2" => new SensorDTO(StateClass.TotalIncreasing, DeviceClass.CarbonDioxide),
            "instantaneousco2" => new SensorDTO(StateClass.Measurement, DeviceClass.CarbonDioxide),
            _ => unknownSensor()
        }; 

        SensorDTO unknownSensor()
        {
            Log.Error($"Unknown measurement type: {measurement.Entity_DisplayName}");
            return new SensorDTO(StateClass.Measurement, DeviceClass.Unknown);
        }
    }
}
