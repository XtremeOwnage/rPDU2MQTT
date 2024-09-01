using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services.baseTypes;

public abstract class basePublishingService : baseMQTTTService
{
    protected basePublishingService(MQTTServiceDependancies dependancies) : base(dependancies, dependancies.Cfg.PDU.PollInterval) { }
    protected basePublishingService(MQTTServiceDependancies dependancies, int Interval) : base(dependancies, Interval) { }

    /// <summary>
    /// Publish a series of measurements under <paramref name="Topic"/>
    /// </summary>
    /// <param name="Topic"></param>
    /// <param name="Measurements"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task PublishMeasurements(Dictionary<string, Measurement> Measurements, CancellationToken cancellationToken)
    {
        foreach (var measurement in Measurements.Values)
        {
            var topic = measurement.GetTopicPath();
            await PublishString(topic, measurement.Value, cancellationToken);
        }
    }

    /// <summary>
    /// Publish entities state.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task PublishState<T>(T Entity, CancellationToken cancellationToken)
        where T : IMQTTKey, IEntityWithState
    {
        var topic = MQTTHelper.JoinPaths(Entity.GetTopicPath(), Entity.State_Topic);
        await PublishString(topic, Entity.State, cancellationToken);

    }

    /// <summary>
    /// Publish entities Unique Identifier.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task PublishUniqueIdentifier<T>(T Entity, CancellationToken cancellationToken)
        where T : IMQTTKey
    {
        var topic = MQTTHelper.JoinPaths(Entity.GetTopicPath(), MqttPath.UniqueIdentifier);
        await PublishString(topic, Entity.Entity_Identifier, cancellationToken);

    }

    /// <summary>
    /// Publish entities Name as DisplayName.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task PublishName<T>(T Entity, CancellationToken cancellationToken)
        where T : IMQTTKey, IEntityName
    {
        var topic = MQTTHelper.JoinPaths(Entity.GetTopicPath(), MqttPath.Name);
        await PublishString(topic, Entity.Entity_DisplayName, cancellationToken);

    }
}