using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Services;

/// <summary>
/// Subscribes to outlet command topics and relays on/off commands to the PDU.
/// Only registered when PDU.ActionsEnabled is true.
/// </summary>
public class OutletCommandService : IHostedService
{
    private readonly HiveMQClient mqtt;
    private readonly Config cfg;
    private readonly PDU pdu;
    private readonly Core.LeaderState? leader;
    private readonly string[] commandFilters;

    public OutletCommandService(MQTTServiceDependencies deps)
    {
        // OnMessageReceived lives on the concrete client, not the interface.
        mqtt = deps.Mqtt as HiveMQClient
            ?? throw new InvalidOperationException("Expected a HiveMQClient instance for command handling.");
        cfg = deps.Cfg;
        pdu = deps.PDU;
        leader = deps.Leader;

        // <ParentTopic>/+/outlets/+/{set,reboot,resetStats} and the per-field config set
        // (<ParentTopic>/+/outlets/+/<field>/set).
        var outlets = MqttPath.Outlets.ToJsonString();
        commandFilters = new[]
        {
            MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, "+", outlets, "+", MqttPath.Set.ToJsonString()),
            MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, "+", outlets, "+", MqttPath.Reboot.ToJsonString()),
            MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, "+", outlets, "+", ResetStatsCommand),
            MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, "+", outlets, "+", "+", MqttPath.Set.ToJsonString()),
            // <ParentTopic>/Groups/<key>/control  (payload = on/off/reboot, fans out to members)
            MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, MqttPath.Groups.ToJsonString(), "+", GroupControlCommand),
        };
    }

    private const string GroupControlCommand = "control";

    // Command segment for the reset-statistics button, and the config fields settable via <field>/set.
    private const string ResetStatsCommand = "resetStats";
    private static readonly HashSet<string> DelayFields = new(StringComparer.OrdinalIgnoreCase) { "onDelay", "offDelay", "rebootDelay" };
    private static readonly HashSet<string> ConfigFields = new(StringComparer.OrdinalIgnoreCase) { "onDelay", "offDelay", "rebootDelay", "poaAction" };

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        mqtt.OnMessageReceived += OnMessageReceived;

        foreach (var filter in commandFilters)
        {
            var result = await mqtt.SubscribeAsync(filter, QualityOfService.AtLeastOnceDelivery);
            foreach (var sub in result.Subscriptions)
            {
                // SUBACK reason codes 0-2 are "granted QoS 0/1/2"; anything else is a failure/denial.
                if ((int)sub.SubscribeReasonCode <= 2)
                    Log.Information($"Outlet command handler subscribed to {sub.TopicFilter.Topic} ({sub.SubscribeReasonCode}).");
                else
                    Log.Error($"Outlet command subscription to {sub.TopicFilter.Topic} was NOT granted ({sub.SubscribeReasonCode}). Outlet control will not work - the MQTT account likely lacks subscribe permission on this topic.");
            }
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        mqtt.OnMessageReceived -= OnMessageReceived;
        return Task.CompletedTask;
    }

    private async void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        // v3: every instance may be subscribed, but only the leader acts — so one command = one action.
        if (leader is { IsLeader: false }) return;

        var topic = e.PublishMessage.Topic ?? string.Empty;
        try
        {
            var parts = topic.Split('/', StringSplitOptions.RemoveEmptyEntries);

            // Group control: <parent>/Groups/<key>/control, payload on/off/reboot -> fan out to members.
            var groupsIdx = Array.IndexOf(parts, MqttPath.Groups.ToJsonString());
            if (groupsIdx >= 0 && parts.Length == groupsIdx + 3 && parts[^1].Equals(GroupControlCommand, StringComparison.OrdinalIgnoreCase))
            {
                var groupAction = (e.PublishMessage.PayloadAsString ?? string.Empty).Trim().ToLowerInvariant();
                if (groupAction is "on" or "off" or "reboot")
                    await pdu.ControlGroupAsync(parts[groupsIdx + 1], groupAction, CancellationToken.None);
                return;
            }

            // Expected topic: <parent>/<deviceId>/outlets/<index>/set
            var outletsIdx = Array.IndexOf(parts, MqttPath.Outlets.ToJsonString());
            if (outletsIdx <= 0 || outletsIdx + 1 >= parts.Length)
                return;

            var deviceId = parts[outletsIdx - 1];
            if (!int.TryParse(parts[outletsIdx + 1], out var outletIndex))
                return;

            // Segments after the index select the action:
            //   [set]            -> on/off (payload)        [reboot] -> power-cycle
            //   [resetStats]     -> reset statistics        [<field>, set] -> write config field
            var rest = parts[(outletsIdx + 2)..];
            var payload = (e.PublishMessage.PayloadAsString ?? string.Empty).Trim();

            if (rest.Length == 2 && rest[1].Equals(MqttPath.Set.ToJsonString(), StringComparison.OrdinalIgnoreCase))
            {
                await HandleConfigSet(deviceId, outletIndex, rest[0], payload, topic);
                return;
            }

            if (rest.Length != 1)
                return;

            var command = rest[0];

            if (command.Equals(MqttPath.Reboot.ToJsonString(), StringComparison.OrdinalIgnoreCase))
            {
                await pdu.ControlOutletAsync(deviceId, outletIndex, "reboot", CancellationToken.None);
                return;
            }

            if (command.Equals(ResetStatsCommand, StringComparison.OrdinalIgnoreCase))
            {
                await pdu.ResetOutletStatsAsync(deviceId, outletIndex, CancellationToken.None);
                return;
            }

            // Otherwise it's the on/off switch command ([set]).
            var on = payload.Equals("on", StringComparison.OrdinalIgnoreCase);
            await pdu.SetOutletStateAsync(deviceId, outletIndex, on, CancellationToken.None);

            // Optimistically publish the new state so HA reflects it immediately instead of waiting
            // for the next poll. The regular poll will confirm/correct it shortly after.
            var stateTopic = topic[..^MqttPath.Set.ToJsonString().Length] + MqttPath.State.ToJsonString();
            await mqtt.PublishAsync(new MQTT5PublishMessage(stateTopic, QualityOfService.AtLeastOnceDelivery)
            {
                PayloadAsString = on ? "on" : "off",
            });
        }
        catch (Exception ex)
        {
            Log.Error(ex, $"Failed to handle outlet command on topic {topic}.");
        }
    }

    /// <summary>Write a single outlet config field (delay as a number, power-on action as a string).</summary>
    private async Task HandleConfigSet(string deviceId, int outletIndex, string field, string payload, string topic)
    {
        if (!ConfigFields.Contains(field))
            return;

        object value;
        if (DelayFields.Contains(field))
        {
            // HA number sends the value as text (e.g. "5" or "5.0"); the API expects an integer.
            if (!double.TryParse(payload, System.Globalization.CultureInfo.InvariantCulture, out var num))
                return;
            value = (long)Math.Round(num);
        }
        else
        {
            value = payload; // poaAction: the selected option
        }

        await pdu.SetOutletConfigAsync(deviceId, outletIndex, new Dictionary<string, object> { [field] = value }, CancellationToken.None);

        // Echo the new value back to the field's state topic so HA reflects it immediately.
        var stateTopic = topic[..topic.LastIndexOf('/')];
        await mqtt.PublishAsync(new MQTT5PublishMessage(stateTopic, QualityOfService.AtLeastOnceDelivery)
        {
            PayloadAsString = value.ToString() ?? string.Empty,
        });
    }
}
