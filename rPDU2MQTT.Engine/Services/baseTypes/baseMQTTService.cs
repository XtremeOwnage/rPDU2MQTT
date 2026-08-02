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
    private readonly Core.LeaderState? leader;

    /// <summary>
    /// v3: run-once-cluster-wide work. When true (the default), <see cref="Execute"/> only runs on the leader
    /// instance, so a homogeneous fleet doesn't publish/export duplicates. Override to false for per-instance
    /// work that every process must do (e.g. serving its own metrics endpoint).
    /// </summary>
    protected virtual bool LeaderGated => true;

    // Said once per idle spell, so a permanent skip is visible without a line every tick.
    private bool warnedNotLeader;

    /// <summary>
    /// When the data currently being published was read from the device (#205). A publishing loop sets this
    /// per snapshot; null means "no better answer than now" (e.g. a state echo after a control action).
    /// </summary>
    protected DateTime? DataTimestampUtc { get; set; }

    protected System.Text.Json.JsonSerializerOptions jsonOptions { get; init; }

    protected baseMQTTService(MQTTServiceDependencies dependencies) : this(dependencies, dependencies.Cfg.Primary.PollInterval) { }
    protected baseMQTTService(MQTTServiceDependencies dependencies, int Interval)
    {
        mqtt = dependencies.Mqtt;
        cfg = dependencies.Cfg;
        pdu = dependencies.PDU;
        snapshotCache = dependencies.SnapshotCache;
        leader = dependencies.Leader;

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
            // A non-positive interval means this service runs ONCE and then never again. For a publisher or
            // an exporter that is indistinguishable from being broken — the broker keeps serving whatever was
            // retained on that single pass, so the data looks present and is simply frozen. Say so as a
            // warning, not an info line lost in the startup noise.
            Log.Warning($"{GetType().Name} has no repeat interval, so it runs once and then stops. Anything it "
                      + "publishes will stay at its startup values; consumers will keep reading the retained "
                      + "message as if it were current. Set a positive PollInterval to make it repeat.");
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
            // v3: only the leader runs the run-once work; other instances no-op this tick (null leader = tests).
            if (LeaderGated && leader is { IsLeader: false })
            {
                // Debug, not Verbose. A service that quietly does nothing forever is indistinguishable from a
                // broken one, and Verbose is off in every deployment anyone actually runs — so the one clue
                // that publishing had stopped was invisible exactly when it was needed.
                Log.Debug($"{GetType().Name} - skipped (not cluster leader).");
                if (!warnedNotLeader)
                {
                    warnedNotLeader = true;
                    Log.Information($"{GetType().Name} is idle: this instance does not hold cluster leadership. "
                                  + "Retained values on the broker are from the last instance that did, and are not being refreshed.");
                }
                return;
            }
            warnedNotLeader = false;

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

        // #205: carry the moment the data was read. As a user property this is invisible to consumers that
        // don't look for it, so it costs nothing to have on by default — and it's the poll time, not the
        // publish time, which is what makes a stale republish distinguishable from a fresh reading.
        if (cfg.MQTT.MessageTimestamp == Models.Config.MessageTimestampMode.UserProperty)
            msg.UserProperties[Core.MessageTimestamps.PropertyName] =
                Core.MessageTimestamps.Format(DataTimestampUtc ?? DateTime.UtcNow);

        // Disconnects are reported by MqttEventHandler and recovered via auto-reconnect;
        // publish failures surface in tick(). No need to check connectivity per message.
        return mqtt.PublishAsync(msg, cancellationToken);
    }

    /// <summary>
    /// The latest data from every source whose snapshot is still fresh. Stale sources (a poller that
    /// stopped producing — e.g. an unreachable PDU) are skipped, so Home Assistant's expire_after can
    /// mark their entities unavailable instead of us republishing last-known values forever.
    /// </summary>
    protected IReadOnlyList<Models.PDU.PduData> FreshSnapshots()
        => FreshSnapshotsWithId().Select(s => s.Data).ToList();

    /// <summary>As <see cref="FreshSnapshots"/>, but keeps each snapshot's instance id (for per-instance
    /// labelling/routing).</summary>
    protected IReadOnlyList<Core.PduSnapshot> FreshSnapshotsWithId()
    {
        var now = DateTime.UtcNow;
        return snapshotCache.All
            .Where(s => !Core.SnapshotFreshness.IsStale(s.TimestampUtc, cfg.Primary.PollInterval, now))
            .ToList();
    }

    /// <summary>
    /// Put the job inside of here.
    /// </summary>
    /// <returns></returns>
    protected abstract Task Execute(CancellationToken cancellationToken);
}
