using Microsoft.Extensions.Configuration.UserSecrets;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services.baseTypes;

public abstract class basePublishingService : baseMQTTService
{
    protected basePublishingService(MQTTServiceDependencies dependencies) : base(dependencies, dependencies.Cfg.PDU.PollInterval) { }
    protected basePublishingService(MQTTServiceDependencies dependencies, int Interval) : base(dependencies, Interval) { }

    /// <summary>
    /// Publish a series of measurements under <paramref name="Topic"/>
    /// </summary>
    /// <param name="Topic"></param>
    /// <param name="Measurements"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task PublishMeasurements(List<Measurement> Measurements, CancellationToken cancellationToken)
    {
        foreach (var measurement in Measurements)
        {
            var topic = measurement.GetTopicPath();
            await PublishString(topic, measurement.Value, cancellationToken);
        }
    }

    /// <summary>
    /// Publish a series of measurements under <paramref name="Topic"/>
    /// </summary>
    /// <param name="Topic"></param>
    /// <param name="Measurements"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected async Task PublishOneViewGroupMeasurements(List<GroupMeasurement> Measurements, CancellationToken cancellationToken)
    {
        Dictionary<MqttPath, Func<GroupMeasurement, string>> getMeasurements = new()
        {
            {MqttPath.Average, o => o.AvgValue },
            {MqttPath.Sum, o => o.SumValue },
            {MqttPath.Minimum, o => o.MinValue },
            {MqttPath.Maximum, o => o.MaxValue },
         };
        foreach (var measurement in Measurements)
        {
            var topic = measurement.GetTopicPath();
            await PublishObjectasJSON< IAggregateMeasurement>(topic, measurement, cancellationToken);


        }
    }

    /// <summary>
    /// Publish entities state.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected Task PublishState<T>(T Entity, CancellationToken cancellationToken)
        where T : IMQTTKey, IEntityWithState
        => PublishState(Entity, Entity.State, cancellationToken);

    /// <summary>Publish an explicit state value for an entity (e.g. a latched/optimistic state).</summary>
    protected async Task PublishState<T>(T Entity, string state, CancellationToken cancellationToken)
        where T : IMQTTKey, IEntityWithState
    {
        var topic = MQTTHelper.JoinPaths(Entity.GetTopicPath(), Entity.State_Topic);
        await PublishString(topic, state, cancellationToken);
    }

    /// <summary>
    /// Publish an entity's alarm state ("none" when there is no active alarm).
    /// </summary>
    protected async Task PublishAlarm<T>(T Entity, Alarm? alarm, CancellationToken cancellationToken)
        where T : IMQTTKey
    {
        var topic = MQTTHelper.JoinPaths(Entity.GetTopicPath(), MqttPath.Alarm.ToJsonString());
        await PublishString(topic, alarm?.State ?? "none", cancellationToken);
    }

    /// <summary>
    /// Publish entities Unique Identifier.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected Task PublishUniqueIdentifier<T>(T Entity, CancellationToken cancellationToken)
        where T : IMQTTKey
        => PublishMetadataIfChanged(MQTTHelper.JoinPaths(Entity.GetTopicPath(), MqttPath.UniqueIdentifier), Entity.Entity_Identifier, cancellationToken);

    /// <summary>
    /// Publish entities Name as DisplayName.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected Task PublishName<T>(T Entity, CancellationToken cancellationToken)
        where T : IMQTTKey, IEntityName
        => PublishMetadataIfChanged(MQTTHelper.JoinPaths(Entity.GetTopicPath(), MqttPath.Name), Entity.Entity_DisplayName, cancellationToken);

    // Name/identifier are static metadata; publish them retained and only when they actually change
    // instead of republishing on every poll.
    private readonly Dictionary<string, string> lastMetadata = new();

    private Task PublishMetadataIfChanged(string topic, string value, CancellationToken cancellationToken)
    {
        if (lastMetadata.TryGetValue(topic, out var previous) && previous == value)
            return Task.CompletedTask;

        lastMetadata[topic] = value;
        return PublishString(topic, value, retain: true, cancellationToken);
    }
}