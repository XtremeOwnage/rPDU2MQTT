using HiveMQtt.Client;
using HiveMQtt.MQTT5.Types;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Re-establishing broker subscriptions after a reconnect.
/// <para>
/// The MQTT client reconnects with a fresh client id (a GUID is appended per connection), so the broker
/// keeps no session and drops every subscription on a reconnect. Nothing re-added them: each service
/// subscribes once at startup and assumes the subscription lives forever. The result is a process that works
/// after boot and then, after the first network blip days later, goes silently deaf — no outlet commands, no
/// energy-flow values — until it's restarted. This restores them the moment the client reconnects.
/// </para>
/// </summary>
public static class MqttSubscriptions
{
    /// <summary>
    /// Re-subscribe the client to every filter it still tracks. Idempotent, and de-duplicated so repeated
    /// reconnects can't do unbounded work. A no-op on the very first connect (nothing has subscribed yet).
    /// </summary>
    public static async Task ResubscribeAllAsync(IHiveMQClient client)
    {
        var filters = client.Subscriptions
            .Select(s => (s.TopicFilter.Topic, s.TopicFilter.QoS))
            .Where(f => !string.IsNullOrWhiteSpace(f.Topic))
            .Distinct()
            .ToList();
        if (filters.Count == 0)
            return;

        Log.Information($"MQTT reconnected — re-establishing {filters.Count} subscription(s).");
        foreach (var (topic, qos) in filters)
        {
            try
            {
                await client.SubscribeAsync(topic, qos);
            }
            catch (Exception ex)
            {
                Log.Warning($"Could not re-subscribe to '{topic}' after reconnect: {ex.Message}");
            }
        }
    }
}
