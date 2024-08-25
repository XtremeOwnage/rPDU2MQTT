using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.HomeAssistant.Enums;

public enum EntityType
{
    [JsonPropertyName("sensor")]
    Sensor,

    [JsonPropertyName("binary_sensor")]
    BinarySensor,

    [JsonPropertyName("switch")]
    Switch,

    [JsonPropertyName("light")]
    Light,

    [JsonPropertyName("climate")]
    Climate,

    [JsonPropertyName("cover")]
    Cover,

    [JsonPropertyName("device_tracker")]
    DeviceTracker,

    [JsonPropertyName("lock")]
    Lock,

    [JsonPropertyName("media_player")]
    MediaPlayer,

    [JsonPropertyName("vacuum")]
    Vacuum,

    [JsonPropertyName("camera")]
    Camera,

    [JsonPropertyName("alarm_control_panel")]
    AlarmControlPanel,

    [JsonPropertyName("input_boolean")]
    InputBoolean,

    [JsonPropertyName("input_number")]
    InputNumber,

    [JsonPropertyName("input_select")]
    InputSelect,

    [JsonPropertyName("input_text")]
    InputText,

    [JsonPropertyName("scene")]
    Scene,

    [JsonPropertyName("script")]
    Script,

    [JsonPropertyName("automation")]
    Automation,

    [JsonPropertyName("button")]
    Button,

    [JsonPropertyName("fan")]
    Fan,

    [JsonPropertyName("humidifier")]
    Humidifier,
}
