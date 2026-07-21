using System.Text.Json;
using HiveMQtt.Client;
using HiveMQtt.Client.Events;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;

namespace rPDU2MQTT.Services;

/// <summary>
/// Lets the GUI restart this process (and, in a split deployment, sibling tiers) over the bus: every
/// process subscribes to <see cref="RestartCommand.TopicFor"/> and stops itself when a request targets
/// "all" or one of its roles — the orchestrator then restarts it. Loaded in every role so any process can
/// be told to restart; in Kubernetes the GUI prefers a rollout restart, so this covers the other
/// deployment shapes (compose, split-by-process, single node).
/// </summary>
public sealed class RestartCommandService : IHostedService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly HiveMQClient mqtt;
    private readonly Config cfg;
    private readonly IHostApplicationLifetime lifetime;
    private readonly rPDU2MQTT.Core.IProcessRestarter? restarter;
    private readonly string[] roles;
    private readonly DateTime startedUtc = DateTime.UtcNow;

    public RestartCommandService(IHiveMQClient mqtt, Config cfg, HostRole roles, IHostApplicationLifetime lifetime, rPDU2MQTT.Core.IProcessRestarter? restarter = null)
    {
        this.mqtt = (HiveMQClient)mqtt;
        this.cfg = cfg;
        this.lifetime = lifetime;
        this.restarter = restarter;
        this.roles = new[] { HostRole.Worker, HostRole.Api, HostRole.Ui }
            .Where(r => roles.HasFlag(r)).Select(r => r.ToString().ToLowerInvariant()).ToArray();
    }

    private string Topic => RestartCommand.TopicFor(cfg.MQTT.ParentTopic);

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        mqtt.OnMessageReceived += OnMessageReceived;
        try { await mqtt.SubscribeAsync(Topic, QualityOfService.AtLeastOnceDelivery); }
        catch (Exception ex) { Log.Warning($"Restart-command: could not subscribe to {Topic}: {ex.Message}"); }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        mqtt.OnMessageReceived -= OnMessageReceived;
        return Task.CompletedTask;
    }

    private void OnMessageReceived(object? sender, OnMessageReceivedEventArgs e)
    {
        if (!string.Equals(e.PublishMessage.Topic, Topic, StringComparison.Ordinal)) return;

        RestartCommand? cmd;
        try { cmd = JsonSerializer.Deserialize<RestartCommand>(e.PublishMessage.PayloadAsString ?? "", Json); }
        catch { return; }
        if (cmd is null || string.IsNullOrWhiteSpace(cmd.Target)) return;

        // Ignore anything issued before we came up — guards against a redelivered/stale command restarting a
        // freshly-started process in a loop (the topic is non-retained, so this is belt-and-braces).
        if (cmd.AtUtc < startedUtc.AddSeconds(-5)) return;
        if (!cmd.MatchesRoles(roles)) return;

        // #192: how we come back is the restarter's business — under Kubernetes it replaces the pod rather
        // than exiting 0, which would show as "Completed" and return on the kubelet's backoff.
        var why = $"bus request, target '{cmd.Target}' [{string.Join('+', roles)}]";
        if (restarter is not null)
            _ = Task.Run(async () => { await Task.Delay(500); await restarter.RestartAsync(why); });
        else
        {
            Log.Warning($"Restart requested over the bus ({why}); stopping this process.");
            rPDU2MQTT.Core.SelfRestart.Mark(why);
            _ = Task.Run(async () => { await Task.Delay(500); lifetime.StopApplication(); });
        }
    }
}
