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
        TaskManager.AddTask(() => client.PublishAsync(client.Options!.LastWillAndTestament!.Topic, "online", HiveMQtt.MQTT5.Types.QualityOfService.AtLeastOnceDelivery));
    }
}
