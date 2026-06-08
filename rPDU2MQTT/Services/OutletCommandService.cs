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
    private readonly string commandFilter;

    public OutletCommandService(MQTTServiceDependencies deps)
    {
        // OnMessageReceived lives on the concrete client, not the interface.
        mqtt = deps.Mqtt as HiveMQClient
            ?? throw new InvalidOperationException("Expected a HiveMQClient instance for command handling.");
        cfg = deps.Cfg;
        pdu = deps.PDU;

        // <ParentTopic>/+/outlets/+/set
        commandFilter = MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, "+", MqttPath.Outlets.ToJsonString(), "+", MqttPath.Set.ToJsonString());
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        mqtt.OnMessageReceived += OnMessageReceived;

        var result = await mqtt.SubscribeAsync(commandFilter, QualityOfService.AtLeastOnceDelivery);
        foreach (var sub in result.Subscriptions)
        {
            // SUBACK reason codes 0-2 are "granted QoS 0/1/2"; anything else is a failure/denial.
            if ((int)sub.SubscribeReasonCode <= 2)
                Log.Information($"Outlet command handler subscribed to {sub.TopicFilter.Topic} ({sub.SubscribeReasonCode}).");
            else
                Log.Error($"Outlet command subscription to {sub.TopicFilter.Topic} was NOT granted ({sub.SubscribeReasonCode}). Outlet control will not work - the MQTT account likely lacks subscribe permission on this topic.");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        mqtt.OnMessageReceived -= OnMessageReceived;
        return Task.CompletedTask;
    }

    private async void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        var topic = e.PublishMessage.Topic ?? string.Empty;
        try
        {
            // Expected topic: <parent>/<deviceId>/outlets/<index>/set
            var parts = topic.Split('/', StringSplitOptions.RemoveEmptyEntries);
            var outletsIdx = Array.IndexOf(parts, MqttPath.Outlets.ToJsonString());
            if (outletsIdx <= 0 || outletsIdx + 1 >= parts.Length)
                return;

            var deviceId = parts[outletsIdx - 1];
            if (!int.TryParse(parts[outletsIdx + 1], out var outletIndex))
                return;

            var payload = (e.PublishMessage.PayloadAsString ?? string.Empty).Trim();
            var on = payload.Equals("on", StringComparison.OrdinalIgnoreCase);

            await pdu.SetOutletStateAsync(deviceId, outletIndex, on, CancellationToken.None);
        }
        catch (Exception ex)
        {
            Log.Error(ex, $"Failed to handle outlet command on topic {topic}.");
        }
    }
}
