using rPDU2MQTT.Models.HomeAssistant.Enums;

namespace rPDU2MQTT.Models.HomeAssistant.Interfaces
{
    public interface IBaseDiscovery
    {
        EntityType EntityType { get; }
        DiscoveryDevice Device { get; init; }
        string DisplayName { get; set; }
        string Name { get; set; }
        string StateTopic { get; set; }
        string ID { get; set; }
        EntityCategory? EntityCategory { get; }
    }
}