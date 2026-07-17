using HiveMQtt.Client;
using System.Diagnostics;
using System.Timers;
using Timer = System.Timers.Timer;

namespace rPDU2MQTT.Classes;

public class MqttEventHandler
{
    private readonly HiveMQClient client;
    private readonly Timer _timer;
    public MqttEventHandler(HiveMQClient client)
    {
        this.client = client;
        client.AfterConnect += Client_AfterConnect;
        client.OnDisconnectSent += Client_OnDisconnectSent;
        client.OnDisconnectReceived += Client_OnDisconnectReceived;

        _timer = new Timer(TimeSpan.FromSeconds(10));
        _timer.Elapsed += HealthTimer;
        _timer.AutoReset = true; // Ensures the event fires repeatedly at the interval
        _timer.Enabled = true;   // Starts the timer
    }

    private void Client_OnDisconnectReceived(object? sender, HiveMQtt.Client.Events.OnDisconnectReceivedEventArgs e)
    {
        Log.Error("Received disconnect from broker.");
    }

    private void Client_OnDisconnectSent(object? sender, HiveMQtt.Client.Events.OnDisconnectSentEventArgs e)
    {
        Log.Information("Sending disconnect to broker");
    }

    private void HealthTimer(object? sender, ElapsedEventArgs e)
    {
        Log.Verbose("Timer.Tick()");
        sendStatusOnline();

    }

    private void Client_AfterConnect(object? sender, HiveMQtt.Client.Events.AfterConnectEventArgs e)
    {
        Log.Information("MQTT Client Connected");
        sendStatusOnline();
    }


    private void sendStatusOnline()
    {
        // Fire-and-forget from the timer/connect callbacks, but observe failures.
        _ = PublishStatusAsync();
    }

    private async Task PublishStatusAsync()
    {
        // The availability topic only exists when MQTT.LastWill is on; with it off there is nothing to
        // publish to, so skip rather than throwing on every tick. Read once — the client can be re-pointed
        // at a new broker (with different options) underneath us (#192).
        var topic = client.Options?.LastWillAndTestament?.Topic;
        if (string.IsNullOrEmpty(topic))
            return;

        try
        {
            await client.PublishAsync(topic, "online", HiveMQtt.MQTT5.Types.QualityOfService.AtLeastOnceDelivery);
        }
        catch (Exception ex)
        {
            Log.Error(ex, "Failed to publish online status.");
        }
    }
}
