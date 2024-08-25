using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.HomeAssistant;
using rPDU2MQTT.Models.HomeAssistant.DiscoveryTypes;
using rPDU2MQTT.Models.PDU.DummyDevices;

namespace rPDU2MQTT.Extensions;

public static class IEntityWithState_Extensions
{
    /// <summary>
    /// Returns availablity settings for an entity which reports its state.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <returns></returns>
    public static string GetStateTopic<T>(this T Entity)
        where T : IEntityWithState, IMQTTKey
    {
        return MQTTHelper.JoinPaths(Entity.GetTopicPath(), Entity.State_Topic);
    }

    public static BinarySensorDiscovery CreateStateDiscovery<T>(this T item, DiscoveryDevice Device) where T : NamedEntity, IEntityWithState
    {
        var sensor = new BinarySensorDiscovery
        {
            //Identifying Details
            ID = item.Entity_Identifier + "_state",
            Name = item.Entity_Name + "_state",
            DisplayName = $"State",

            //Device Details
            Device = Device,

            //Sensor Specific Details
            EntityType = Models.HomeAssistant.Enums.EntityType.BinarySensor,
            EntityCategory = null,

            //State - Pulled from IEntityWithState
            StateTopic = item.GetStateTopic(),
            ValueTemplate = item.State_ValueTemplate,
            PayloadOn = item.State_On,
            PayloadOff = item.State_Off,

            //Availbility
            //Availability = outlet.GetAvailability()
        };

        return sensor;
    }
}
