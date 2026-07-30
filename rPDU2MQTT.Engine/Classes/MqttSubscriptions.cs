using System.Collections.Concurrent;
using HiveMQtt.Client;
using HiveMQtt.Client.Results;
using HiveMQtt.MQTT5.Types;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Re-establishing broker subscriptions after a reconnect.
/// <para>
/// The MQTT client reconnects with a fresh client id (a GUID is appended per connection), so the broker
/// keeps no session and drops every subscription on a reconnect. Nothing re-added them: each service
/// subscribes once at startup and assumes the subscription lives forever. The result is a process that works
/// after boot and then, after the first network blip days later, goes silently deaf — no outlet commands, no
/// energy-flow values — until it's restarted.
/// </para>
/// <para>
/// The first attempt at this replayed <c>client.Subscriptions</c> on reconnect, which never worked: HiveMQtt
/// <b>clears that list as part of reconnecting, before AfterConnect is raised</b>, so the replay always saw an
/// empty list and returned immediately. Measured against a real client (0.45.1): 2 subscriptions before the
/// drop, still 2 while disconnected, <b>0 by the time AfterConnect fires</b>, and 0 for the rest of the
/// process's life. The unit test missed it because it populated <c>Subscriptions</c> by hand — the one thing
/// the real client won't do for you.
/// </para>
/// <para>
/// So the desired set is remembered <i>here</i>, as each subscription is made, and replayed from that. Route
/// subscriptions through <see cref="SubscribeAsync"/> to get this; a direct <c>client.SubscribeAsync</c> is
/// not remembered and will not survive a reconnect.
/// </para>
/// </summary>
public static class MqttSubscriptions
{
    // Topic filter -> the QoS it was subscribed at. Ours, because the client's own list does not survive.
    private static readonly ConcurrentDictionary<string, QualityOfService> Desired = new(StringComparer.Ordinal);

    /// <summary>Subscribe, and remember it so a reconnect can restore it.</summary>
    public static async Task<SubscribeResult> SubscribeAsync(IHiveMQClient client, string topic, QualityOfService qos)
    {
        var result = await client.SubscribeAsync(topic, qos);
        // Remembered even when the broker denied it (a SUBACK failure code, not an exception): permissions
        // can be granted later, and the caller's own retry decides whether to keep asking.
        Desired[topic] = qos;
        return result;
    }

    /// <summary>Stop restoring a topic — call when deliberately unsubscribing, or it comes back on reconnect.</summary>
    public static void Forget(string topic) => Desired.TryRemove(topic, out _);

    /// <summary>Everything currently expected to be subscribed (diagnostics/tests).</summary>
    public static IReadOnlyDictionary<string, QualityOfService> Tracked => Desired;

    /// <summary>Test seam — the registry is process-wide, so a test must be able to start from empty.</summary>
    internal static void Reset() => Desired.Clear();

    /// <summary>
    /// Re-subscribe the client to every filter we still expect. Idempotent, and de-duplicated so repeated
    /// reconnects can't do unbounded work. A no-op on the very first connect (nothing has subscribed yet).
    /// </summary>
    public static async Task ResubscribeAllAsync(IHiveMQClient client)
    {
        // Our own registry first; union in anything the client still lists, to cover a subscription made
        // without going through SubscribeAsync above.
        var filters = new Dictionary<string, QualityOfService>(Desired, StringComparer.Ordinal);
        foreach (var sub in client.Subscriptions)
        {
            var topic = sub.TopicFilter?.Topic;
            if (!string.IsNullOrWhiteSpace(topic))
                filters[topic] = sub.TopicFilter!.QoS;
        }

        if (filters.Count == 0)
            return;

        Log.Information($"MQTT reconnected — re-establishing {filters.Count} subscription(s).");
        var failed = 0;
        foreach (var (topic, qos) in filters)
        {
            try
            {
                await client.SubscribeAsync(topic, qos);
            }
            catch (Exception ex)
            {
                failed++;
                Log.Warning($"Could not re-subscribe to '{topic}' after reconnect: {ex.Message}");
            }
        }

        // Going quiet about a partial restore is how this stayed invisible the first time.
        if (failed > 0)
            Log.Error($"{failed} of {filters.Count} subscription(s) could not be restored after the reconnect — the features behind them stay deaf until it succeeds.");
    }
}
