using HiveMQtt.Client;
using HiveMQtt.MQTT5.Types;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services;

/// <summary>
/// Re-points the live MQTT client at a new broker/credentials without restarting the process (#192).
/// <para>
/// The client singleton is kept and its <see cref="IHiveMQClient.Options"/> swapped in place, rather than
/// replaced: every service holds a reference to this instance and has wired its own event handlers to it,
/// so replacing the object would silently orphan all of them.
/// </para>
/// <para>
/// A reconnect drops the broker-side session, so subscriptions are captured before disconnecting and
/// replayed afterwards — otherwise control/diagnostic topics would go deaf after a broker change.
/// </para>
/// </summary>
public sealed class MqttReconfigurator
{
    private readonly IHiveMQClient client;
    private readonly Config config;
    private readonly SemaphoreSlim gate = new(1, 1);
    private string fingerprint;

    public MqttReconfigurator(IHiveMQClient client, Config config)
    {
        this.client = client;
        this.config = config;
        fingerprint = MqttOptionsFactory.Fingerprint(config);
    }

    /// <summary>True when <paramref name="reloaded"/> changes the broker connection in any way.</summary>
    public bool NeedsRepoint(Config reloaded) => MqttOptionsFactory.Fingerprint(reloaded) != fingerprint;

    /// <summary>
    /// Apply the reloaded MQTT settings to the live client. Assumes the caller has already copied them onto
    /// the shared <see cref="Config"/>. No-op when nothing the client cares about changed.
    /// </summary>
    public async Task<bool> ApplyAsync(CancellationToken cancellationToken = default)
    {
        var target = MqttOptionsFactory.Fingerprint(config);
        if (target == fingerprint)
            return false;

        await gate.WaitAsync(cancellationToken);
        try
        {
            // Re-check inside the gate: a concurrent caller may have already applied this change.
            if (MqttOptionsFactory.Fingerprint(config) == fingerprint)
                return false;

            var options = MqttOptionsFactory.Build(config);
            var previous = client.Subscriptions.Select(s => s.TopicFilter).ToList();

            Log.Information($"MQTT settings changed; re-pointing the client at {options.Host}:{options.Port} without a restart.");

            if (client.IsConnected())
                await client.DisconnectAsync();

            client.Options = options;
            await client.ConnectAsync();

            // Resubscribe to whatever the services had subscribed to before the reconnect.
            foreach (var filter in previous)
            {
                try
                {
                    await client.SubscribeAsync(filter.Topic, filter.QoS);
                }
                catch (Exception ex)
                {
                    Log.Warning($"Could not resubscribe to '{filter.Topic}' after re-pointing MQTT: {ex.Message}");
                }
            }

            fingerprint = target;
            Log.Information($"MQTT client re-pointed at {options.Host}:{options.Port} ({previous.Count} subscription(s) restored).");
            return true;
        }
        finally
        {
            gate.Release();
        }
    }
}
