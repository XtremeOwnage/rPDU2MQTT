using Microsoft.Extensions.Logging;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Flow;
using rPDU2MQTT.Grains.Abstractions.Modbus;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Grains.Modbus;

/// <summary>
/// One physical Modbus device (key <c>host|port|unitId</c>). The reconciler hands it its config via
/// <see cref="Configure"/>; the grain then polls on its own timer using that held config — no per-poll config
/// scan. Single activation + single-threaded, so the device connection is never contended. Blocking device
/// I/O runs off the grain turn via <c>Task.Run</c>.
/// </summary>
public sealed class ModbusGrain : Grain, IModbusGrain
{
    private readonly ILogger<ModbusGrain> log;
    private string host = "";
    private int port;
    private int unitId;
    private string key = "";
    private ModbusDeviceConfig? config;
    private IGrainTimer? timer;
    private MeasurementSnapshot? latest;
    private long version;
    private DateTime lastConfiguredUtc;

    public ModbusGrain(ILogger<ModbusGrain> log) => this.log = log;

    public override Task OnActivateAsync(CancellationToken cancellationToken)
    {
        key = this.GetPrimaryKeyString();
        var parts = key.Split('|');
        if (parts.Length == 3) { host = parts[0]; int.TryParse(parts[1], out port); int.TryParse(parts[2], out unitId); }
        return base.OnActivateAsync(cancellationToken);
    }

    public Task<MeasurementSnapshot?> Latest() => Task.FromResult(latest);

    public Task Configure(ModbusDeviceConfig cfg)
    {
        var intervalChanged = config is null || config.PollIntervalSeconds != cfg.PollIntervalSeconds;
        config = cfg;                        // bindings/framing/timeout are picked up on the next poll
        lastConfiguredUtc = DateTime.UtcNow; // the reconciler's heartbeat; a removed device stops getting these
        if (timer is null || intervalChanged) // only (re)register the timer when the cadence changes — never reset it otherwise
        {
            timer?.Dispose();
            var interval = TimeSpan.FromSeconds(Math.Max(1, cfg.PollIntervalSeconds));
            // KeepAlive keeps the grain active so it keeps polling between reconciler passes.
            timer = this.RegisterGrainTimer(PollAsync, new GrainTimerCreationOptions(interval, interval) { KeepAlive = true });
        }
        return Task.CompletedTask;
    }

    private async Task PollAsync(CancellationToken ct)
    {
        if (config is null || string.IsNullOrEmpty(host)) return;

        // Removed from config (the reconciler stopped Configuring us): stop polling and let the grain go.
        if (DateTime.UtcNow - lastConfiguredUtc > TimeSpan.FromSeconds(60))
        {
            timer?.Dispose();
            timer = null;
            DeactivateOnIdle();
            return;
        }

        if (config.Bindings.Count == 0) return;

        var sources = config.Bindings.Select(b => new EnergyFlowSource
        {
            Type = "modbus",
            Metric = b.Metric,
            Register = b.Register,
            RegisterType = b.RegisterType,
            DataType = b.DataType,
            WordOrder = b.WordOrder,
            Unit = b.Unit,
            Scale = b.Scale,
            StaleAfterSeconds = b.StaleAfterSeconds,
        }).ToList();

        var (_, message, readings) = await Task.Run(() =>
            EnergyFlowModbusSourceService.Probe(host, port, unitId, config.Framing, config.TimeoutMs, sources), ct);

        var mapped = new List<MeasurementReading>();
        for (int i = 0; i < readings.Count && i < config.Bindings.Count; i++)
        {
            var r = readings[i];
            if (r.Error is not null || r.Value is null) continue;
            if (!Metrics.TryParse(config.Bindings[i].Metric, out var metric)) continue;
            mapped.Add(new MeasurementReading(config.Bindings[i].NodeId, metric, r.Value.Value, config.Bindings[i].StaleAfterSeconds));
        }

        if (mapped.Count == 0) { log.LogDebug("Modbus {Key}: no readings ({Msg})", key, message); return; }

        latest = new MeasurementSnapshot(key, DateTimeOffset.UtcNow, ++version, mapped);
        await GrainFactory.GetGrain<IFlowGrain>(0).Ingest(latest);
    }
}
