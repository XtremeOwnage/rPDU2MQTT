using rPDU2MQTT.Models.HomeAssistant.Enums;

namespace rPDU2MQTT.Models.HomeAssistant.ObjectDTOs;
//ToDo - Rename this type.

public record EntityDTO(string EntitySuffix);

public record SensorDTO(StateClass StateClass, DeviceClass SensorClass, string EntitySuffix);
