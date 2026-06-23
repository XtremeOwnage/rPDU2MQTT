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
public abstract class baseMQTTService : IHostedService, IDisposable
{
    private IHiveMQClient mqtt { get; init; }
    private PeriodicTimer? timer;
    private Task timerTask = Task.CompletedTask;
    private readonly CancellationTokenSource stoppingCts = new();
    protected Config cfg { get; }
    protected PDU pdu { get; }
    private readonly Core.ISnapshotCache snapshotCache;

    protected System.Text.Json.JsonSerializerOptions jsonOptions { get; init; }

    protected baseMQTTService(MQTTServiceDependencies dependencies) : this(dependencies, dependencies.Cfg.PDU.PollInterval) { }
    protected baseMQTTService(MQTTServiceDependencies dependencies, int Interval)
    {
        mqtt = dependencies.Mqtt;
        cfg = dependencies.Cfg;
        pdu = dependencies.PDU;
        snapshotCache = dependencies.SnapshotCache;

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
            Log.Information($"{GetType().Name} - performing single execution.");
            await tick(cancellationToken);
            return;
        }

        Log.Information($"{GetType().Name} is starting.");

        // Run the periodic loop in the background; it stops when stoppingCts is cancelled.
        timerTask = timerTaskExecution(stoppingCts.Token);

        //Kick off the first one manually.
        await tick(cancellationToken);

        // Log message to indicate the service has been started.
        Log.Information($"{GetType().Name} is running.");
    }

    private async Task timerTaskExecution(CancellationToken cancellationToken)
    {
        try
        {
            while (await timer!.WaitForNextTickAsync(cancellationToken))
                await tick(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // Expected when the service is stopping.
        }
    }

    private async Task tick(CancellationToken cancellationToken)
    {
        try
        {
            Log.Debug($"{GetType().Name} - start.");
            await Execute(cancellationToken);
            Log.Debug($"{GetType().Name} - finish.");
        }
        catch (Exception ex)
        {
            Log.Error(ex, $"Exception occured in {this.GetType().Name}'s processing loop.");
        }
    }

    public async Task StopAsync(CancellationToken stoppingToken)
    {
        Log.Information($"{GetType().Name} is stopping.");

        // Signal the periodic loop to stop, then wait for it to drain (bounded by the host's stop token).
        await stoppingCts.CancelAsync();
        await Task.WhenAny(timerTask, Task.Delay(Timeout.Infinite, stoppingToken));

        Log.Information($"{GetType().Name} has stopped.");
    }

    ~baseMQTTService()
    {
        Log.Debug($"{GetType().Name} has been finalized");
    }

    public void Dispose()
    {
        stoppingCts.Dispose();
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
        => PublishString(Topic, Message, retain: false, cancellationToken);

    protected Task PublishString(string Topic, string Message, bool retain, CancellationToken cancellationToken)
    {
        var msg = new MQTT5PublishMessage(Topic, QualityOfService.AtLeastOnceDelivery)
        {
            PayloadAsString = Message,
            Retain = retain,
        };
        return Publish(msg, cancellationToken);
    }

    protected Task PublishObjectasJSON<TObject>(string Topic, TObject Obj, CancellationToken cancellationToken)
    {
        var msg = new MQTT5PublishMessage(Topic, QualityOfService.AtLeastOnceDelivery);
        msg.PayloadAsString = System.Text.Json.JsonSerializer.Serialize<TObject>(Obj, this.jsonOptions);
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

        // Disconnects are reported by MqttEventHandler and recovered via auto-reconnect;
        // publish failures surface in tick(). No need to check connectivity per message.
        return mqtt.PublishAsync(msg, cancellationToken);
    }

    /// <summary>
    /// The most recent pipeline snapshot's data, or null if there is none or it has gone stale (the
    /// PduPoller stopped producing — e.g. the PDU is unreachable). Returning null lets consumers skip
    /// publishing so Home Assistant's expire_after can mark entities unavailable instead of us
    /// republishing the last-known values forever.
    /// </summary>
    protected Models.PDU.PduData? LatestFreshData()
    {
        var snapshot = snapshotCache.Latest;
        if (snapshot is null)
            return null;

        return Core.SnapshotFreshness.IsStale(snapshot.TimestampUtc, cfg.PDU.PollInterval, DateTime.UtcNow)
            ? null
            : snapshot.Data;
    }

    /// <summary>
    /// Put the job inside of here.
    /// </summary>
    /// <returns></returns>
    protected abstract Task Execute(CancellationToken cancellationToken);
}
