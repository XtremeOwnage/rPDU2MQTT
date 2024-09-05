using HiveMQtt.Client;
using HiveMQtt.MQTT5.Types;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Converters;
using System.Text.Json;

namespace rPDU2MQTT.Services.baseTypes;

/// <summary>
/// Represents a base hosted service, which interacts with MQTT.
/// </summary>
public abstract class baseMQTTTService : IHostedService, IDisposable
{
    private IHiveMQClient mqtt { get; init; }
    private PeriodicTimer? timer;
    private Task timerTask = Task.CompletedTask;
    protected Config cfg { get; }
    protected PDU pdu { get; }

    protected System.Text.Json.JsonSerializerOptions jsonOptions { get; init; }

    protected baseMQTTTService(MQTTServiceDependancies dependancies) : this(dependancies, dependancies.Cfg.PDU.PollInterval) { }
    protected baseMQTTTService(MQTTServiceDependancies dependancies, int Interval)
    {
        mqtt = dependancies.Mqtt;
        cfg = dependancies.Cfg;
        pdu = dependancies.PDU;

        // If the interval is 0, don't create a timer.
        if (Interval <= 0)
            timer = null;
        else
            timer = new PeriodicTimer(TimeSpan.FromSeconds(Interval));

        jsonOptions = new System.Text.Json.JsonSerializerOptions
        {
            WriteIndented = true,
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            IncludeFields = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            //UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Skip,
            PropertyNameCaseInsensitive = true,
            PreferredObjectCreationHandling = System.Text.Json.Serialization.JsonObjectCreationHandling.Replace,
        };
        jsonOptions.Converters.Add(new TimeSpanToSecondsConverter());

        jsonOptions.Converters.Add(new EnumToPropertyNameConverter());
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (timer is null)
        {
            Log.Information($"{GetType().Name} - performing single discovery.");
            await Execute(cancellationToken);
            return;

        }

        Log.Information($"{GetType().Name} is starting.");

        timerTask = Task.Run(() => timerTaskExecution(cancellationToken).Wait());

        //Kick off the first one manually.
        await Execute(cancellationToken);

        // Log message to indicate the service has been started.
        Log.Information($"{GetType().Name} is running.");
    }

    private async Task timerTaskExecution(CancellationToken cancellationToken)
    {
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            await Execute(cancellationToken);
        }
    }

    public Task StopAsync(CancellationToken stoppingToken)
    {
        Log.Information($"{GetType().Name} is stopping.");

        //Do Something?

        Log.Information($"{GetType().Name} has stopped.");

        return Task.CompletedTask;
    }

    ~baseMQTTTService()
    {
        Log.Debug($"{GetType().Name} has been finalized");
    }

    public void Dispose()
    {
        timer?.Dispose();
    }

    /// <summary>
    /// Publish the specified message to the specified topic.
    /// </summary>
    /// <param name="Topic">Full topic path. Parent topic is added automatically.</param>
    /// <param name="Message"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected Task PublishString(string Topic, string Message, CancellationToken cancellationToken)
    {
        var msg = new MQTT5PublishMessage(Topic, QualityOfService.AtMostOnceDelivery);
        msg.PayloadAsString = Message;
        return Publish(msg, cancellationToken);
    }

    /// <summary>
    /// Publishes the specified message.
    /// </summary>
    /// <param name="msg"></param>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    protected Task Publish(MQTT5PublishMessage msg, CancellationToken cancellationToken)
    {
        if (cfg.Debug.PublishMessages == false)
            return Task.CompletedTask;

        if (!mqtt.IsConnected())
            Log.Error("MQTT Broker is not connected!!!!!");

        return mqtt.PublishAsync(msg, cancellationToken);
    }

    /// <summary>
    /// Put the job inside of here.
    /// </summary>
    /// <returns></returns>
    protected abstract Task Execute(CancellationToken cancellationToken);
}
