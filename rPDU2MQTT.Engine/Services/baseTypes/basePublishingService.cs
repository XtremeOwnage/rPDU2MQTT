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
    protected basePublishingService(MQTTServiceDependencies dependencies) : base(dependencies, dependencies.Cfg.Primary.PollInterval) { }
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
            // #205: in Payload mode the reading is published as {"value": …, "timestamp": …}; otherwise it
            // stays the bare value it has always been.
            await PublishString(topic, Core.MessageTimestamps.Payload(measurement.Value, DataTimestampUtc, cfg.MQTT.MessageTimestamp), cancellationToken);

            // The per-measurement alarm (#99). These are the thresholds the PDU actually lets you configure
            // — high/low current on a circuit or phase, and the outlet's informational fields — and they
            // were parsed off the wire and then thrown away.
            //
            // Only where the PDU reports one: publishing "none" for every measurement on every pass would
            // double the topic count of the whole bridge to say nothing, and would invent an alarm-capable
            // reading where the hardware has none.
            if (Core.AlarmPayload.Reported(measurement.Alarm))
                await PublishAlarm(measurement, measurement.Alarm, cancellationToken);
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
    /// Publish an outlet's writable config values (delays, power-on action) to the state topics
    /// backing the Home Assistant number/select entities.
    /// </summary>
    protected async Task PublishOutletConfig(string deviceId, Outlet outlet, CancellationToken cancellationToken)
    {
        var basePath = outlet.GetTopicPath();
        var idx = outlet.Key;
        string resolve(string field, string actual) => pdu.ResolveOutletConfig(deviceId, idx, field, actual);

        await PublishString(MQTTHelper.JoinPaths(basePath, "onDelay"), resolve("onDelay", outlet.OnDelay.ToString()), cancellationToken);
        await PublishString(MQTTHelper.JoinPaths(basePath, "offDelay"), resolve("offDelay", outlet.OffDelay.ToString()), cancellationToken);
        await PublishString(MQTTHelper.JoinPaths(basePath, "rebootDelay"), resolve("rebootDelay", outlet.RebootDelay.ToString()), cancellationToken);
        await PublishString(MQTTHelper.JoinPaths(basePath, "poaAction"), resolve("poaAction", outlet.PoaAction ?? string.Empty), cancellationToken);
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
    /// Publish an entity's alarm state ("none" when there is no active alarm), plus a small JSON object of
    /// detail beside it.
    /// </summary>
    /// <remarks>
    /// The severity — the PDU's own distinction between an alarm and a warning — used to be parsed and then
    /// dropped on the floor. It goes to a sibling topic rather than into the state payload: the plain state
    /// is what existing installs already subscribe to, and turning it into JSON would break all of them.
    /// It is published on every pass alongside the state, so the two can never disagree.
    /// </remarks>
    protected async Task PublishAlarm<T>(T Entity, Alarm? alarm, CancellationToken cancellationToken)
        where T : IMQTTKey
    {
        var path = Entity.GetTopicPath();
        await PublishString(MQTTHelper.JoinPaths(path, MqttPath.Alarm.ToJsonString()), Core.AlarmPayload.State(alarm), cancellationToken);
        await PublishString(MQTTHelper.JoinPaths(path, MqttPath.AlarmAttributes.ToJsonString()), Core.AlarmPayload.Attributes(alarm), cancellationToken);
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