using Microsoft.Extensions.Logging;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services;

/// <summary>
/// Publishes a PDU's object model to MQTT — names, states, alarms, measurements, outlet config.
///
/// <para>
/// The helpers are the ones that lived on <c>basePublishingService</c>, lifted off the hosting base class
/// and onto the publish seam. They were only ever entangled with the poll timer, the leader gate and the
/// snapshot cache by inheritance; none of that is anything to do with turning a device into topics.
/// </para>
/// </summary>
public sealed class MqttPduPublisher
{
    private readonly Config cfg;
    private readonly IMessagePublisher publisher;
    private readonly PDU pdu;

    // When the data being published was read. Set per snapshot, so a device is stamped with its OWN poll
    // time rather than the moment the pass happened to be assembled.
    private DateTime? stamp;

    /// <summary>The options the aggregate payloads were always serialised with.</summary>
    private static readonly System.Text.Json.JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        IncludeFields = true,
        PropertyNameCaseInsensitive = true,
        Converters = { new Models.Converters.TimeSpanToSecondsConverter(), new Models.Converters.EnumToPropertyNameConverter() },
    };

    public MqttPduPublisher(Config cfg, IMessagePublisher publisher, PDU pdu)
    {
        this.cfg = cfg;
        this.publisher = publisher;
        this.pdu = pdu;
    }

    /// <summary>Publish everything in one snapshot, stamped with when that snapshot was read.</summary>
    public async Task PublishAsync(Core.PduSnapshot snapshot, CancellationToken cancellationToken)
    {
        stamp = snapshot.TimestampUtc;

        foreach (var device in snapshot.Data.Devices)
        {
            await PublishState(device, cancellationToken);
            await PublishAlarm(device, device.Alarm, cancellationToken);

            foreach (var entity in device.Entity)
            {
                await PublishName(entity, cancellationToken);
                await PublishUniqueIdentifier(entity, cancellationToken);
                await PublishMeasurements(entity.Measurements, cancellationToken);
            }
            foreach (var outlet in device.Outlets)
            {
                // While a control command is still pending, report the commanded state instead of the
                // stale polled one so HA doesn't flap back during the PDU's apply delay.
                var state = pdu.ResolveOutletState(device.Key, outlet.Key, outlet.State);

                await PublishName(outlet, cancellationToken);
                await PublishUniqueIdentifier(outlet, cancellationToken);
                await PublishState(outlet, state, cancellationToken);
                await PublishAlarm(outlet, outlet.Alarm, cancellationToken);
                await PublishMeasurements(outlet.Measurements, cancellationToken);

                if (cfg.Primary.ActionsEnabled)
                    await PublishOutletConfig(device.Key, outlet, cancellationToken);
            }
        }

        foreach (var group in snapshot.Data.Groups)
        {
            await PublishName(group, cancellationToken);
            await PublishUniqueIdentifier(group, cancellationToken);
            foreach (var outlet in group.Entity.Outlets.Concat(group.Entity.PduTotal))
                await PublishOneViewGroupMeasurements(outlet.Measurements, cancellationToken);
        }
    }

    private async Task PublishMeasurements(List<Measurement> Measurements, CancellationToken cancellationToken)
    {
        foreach (var measurement in Measurements)
        {
            var topic = measurement.GetTopicPath();
            // #205: in Payload mode the reading is published as {"value": …, "timestamp": …}; otherwise it
            // stays the bare value it has always been.
            await publisher.PublishAsync(topic, Core.MessageTimestamps.Payload(measurement.Value, stamp, cfg.MQTT.MessageTimestamp), false, cancellationToken, stamp);

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
    private async Task PublishOneViewGroupMeasurements(List<GroupMeasurement> Measurements, CancellationToken cancellationToken)
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
            await publisher.PublishAsync(topic, System.Text.Json.JsonSerializer.Serialize<IAggregateMeasurement>(measurement, JsonOptions), false, cancellationToken, stamp);


        }
    }

    /// <summary>
    /// Publish an outlet's writable config values (delays, power-on action) to the state topics
    /// backing the Home Assistant number/select entities.
    /// </summary>
    private async Task PublishOutletConfig(string deviceId, Outlet outlet, CancellationToken cancellationToken)
    {
        var basePath = outlet.GetTopicPath();
        var idx = outlet.Key;
        string resolve(string field, string actual) => pdu.ResolveOutletConfig(deviceId, idx, field, actual);

        await publisher.PublishAsync(MQTTHelper.JoinPaths(basePath, "onDelay"), resolve("onDelay", outlet.OnDelay.ToString()), false, cancellationToken, stamp);
        await publisher.PublishAsync(MQTTHelper.JoinPaths(basePath, "offDelay"), resolve("offDelay", outlet.OffDelay.ToString()), false, cancellationToken, stamp);
        await publisher.PublishAsync(MQTTHelper.JoinPaths(basePath, "rebootDelay"), resolve("rebootDelay", outlet.RebootDelay.ToString()), false, cancellationToken, stamp);
        await publisher.PublishAsync(MQTTHelper.JoinPaths(basePath, "poaAction"), resolve("poaAction", outlet.PoaAction ?? string.Empty), false, cancellationToken, stamp);
    }

    /// <summary>
    /// Publish entities state.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    private Task PublishState<T>(T Entity, CancellationToken cancellationToken)
        where T : IMQTTKey, IEntityWithState
        => PublishState(Entity, Entity.State, cancellationToken);

    /// <summary>Publish an explicit state value for an entity (e.g. a latched/optimistic state).</summary>
    private async Task PublishState<T>(T Entity, string state, CancellationToken cancellationToken)
        where T : IMQTTKey, IEntityWithState
    {
        var topic = MQTTHelper.JoinPaths(Entity.GetTopicPath(), Entity.State_Topic);
        await publisher.PublishAsync(topic, state, false, cancellationToken, stamp);
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
    private async Task PublishAlarm<T>(T Entity, Alarm? alarm, CancellationToken cancellationToken)
        where T : IMQTTKey
    {
        var path = Entity.GetTopicPath();
        await publisher.PublishAsync(MQTTHelper.JoinPaths(path, MqttPath.Alarm.ToJsonString()), Core.AlarmPayload.State(alarm), false, cancellationToken, stamp);
        await publisher.PublishAsync(MQTTHelper.JoinPaths(path, MqttPath.AlarmAttributes.ToJsonString()), Core.AlarmPayload.Attributes(alarm), false, cancellationToken, stamp);
    }

    /// <summary>
    /// Publish entities Unique Identifier.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    private Task PublishUniqueIdentifier<T>(T Entity, CancellationToken cancellationToken)
        where T : IMQTTKey
        => PublishMetadataIfChanged(MQTTHelper.JoinPaths(Entity.GetTopicPath(), MqttPath.UniqueIdentifier), Entity.Entity_Identifier, cancellationToken);

    /// <summary>
    /// Publish entities Name as DisplayName.
    /// </summary>
    /// <typeparam name="T"></typeparam>
    /// <param name="Entity"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    private Task PublishName<T>(T Entity, CancellationToken cancellationToken)
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
        return publisher.PublishAsync(topic, value, retain: true, cancellationToken, stamp);
    }
}
