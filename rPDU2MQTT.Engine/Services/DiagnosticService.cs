using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;

namespace rPDU2MQTT.Services;

/// <summary>
/// Handles the diagnostic action buttons published for the bridge: "Rediscover" (republish HA
/// discovery) and "Restart" (stop the app so the container restarts).
/// </summary>
public class DiagnosticService : IHostedService
{
    private readonly HiveMQClient mqtt;
    private readonly Config cfg;
    private readonly DiscoveryCoordinator coordinator;
    private readonly IHostApplicationLifetime lifetime;
    private readonly Core.LeaderState? leader;
    private readonly string rediscoverTopic;
    private readonly string restartTopic;

    public DiagnosticService(MQTTServiceDependencies deps, DiscoveryCoordinator coordinator, IHostApplicationLifetime lifetime)
    {
        // OnMessageReceived lives on the concrete client, not the interface.
        mqtt = deps.Mqtt as HiveMQClient
            ?? throw new InvalidOperationException("Expected a HiveMQClient instance for diagnostic commands.");
        cfg = deps.Cfg;
        this.coordinator = coordinator;
        this.lifetime = lifetime;
        leader = deps.Leader;

        rediscoverTopic = MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, MQTTHelper.RediscoverSuffix);
        restartTopic = MQTTHelper.JoinPaths(cfg.MQTT.ParentTopic, MQTTHelper.RestartSuffix);
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        mqtt.OnMessageReceived += OnMessageReceived;
        await mqtt.SubscribeAsync(rediscoverTopic, QualityOfService.AtLeastOnceDelivery);
        await mqtt.SubscribeAsync(restartTopic, QualityOfService.AtLeastOnceDelivery);
        Log.Information($"Diagnostic actions subscribed ({rediscoverTopic}, {restartTopic}).");
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        mqtt.OnMessageReceived -= OnMessageReceived;
        return Task.CompletedTask;
    }

    private async void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        // v3: only the leader acts on diagnostic commands (rediscover once cluster-wide).
        if (leader is { IsLeader: false }) return;

        var topic = e.PublishMessage.Topic ?? string.Empty;
        try
        {
            if (topic.Equals(rediscoverTopic, StringComparison.OrdinalIgnoreCase))
            {
                Log.Information("Rediscovery requested via diagnostic action.");
                await coordinator.RequestRediscoverAsync(CancellationToken.None);
            }
            else if (topic.Equals(restartTopic, StringComparison.OrdinalIgnoreCase))
            {
                Log.Information("Restart requested via diagnostic action; stopping application.");
                lifetime.StopApplication();
            }
        }
        catch (Exception ex)
        {
            Log.Error(ex, $"Failed to handle diagnostic command on topic {topic}.");
        }
    }
}
