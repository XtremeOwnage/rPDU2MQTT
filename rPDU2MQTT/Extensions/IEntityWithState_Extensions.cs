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
}
