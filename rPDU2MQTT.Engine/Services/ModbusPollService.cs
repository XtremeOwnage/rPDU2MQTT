using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Abstractions.Pipeline;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Core.Modbus;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services;

/// <summary>
/// Reads every configured Modbus device and emits its readings into the flow value sink.
///
/// <para>
/// Config is re-read each pass (so enabling a connection in the GUI takes effect without a restart),
/// connections are grouped by physical address, and each device is polled on its own cadence. The grouping
/// is the part that matters: two config connections to the same <c>host:port:unitId</c> are one device,
/// because a single-client RS485 gateway can only answer one reader at a time.
/// </para>
/// </summary>
public sealed class ModbusPollService : BackgroundService
{
    private readonly Config config;
    private readonly ISnapshotSink<MeasurementSnapshot>? sink;
    private readonly ModbusDevices devices;
    private readonly ISingleOwnerLease lease;
    private readonly ILogger<ModbusPollService>? log;

    private readonly Dictionary<string, DateTime> lastPoll = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, long> versions = new(StringComparer.OrdinalIgnoreCase);

    public ModbusPollService(Config config, ModbusDevices devices,
        ISnapshotSink<MeasurementSnapshot>? sink = null, ISingleOwnerLease? lease = null,
        ILogger<ModbusPollService>? log = null)
    {
        this.config = config;
        this.devices = devices;
        this.sink = sink;
        this.lease = lease ?? new SoleOwnerLease();
        this.log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        do
        {
            try { await PollAsync(stoppingToken); }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { Serilog.Log.Debug($"Modbus poller: {ex.Message}"); }
        }
        while (await Ticks.Next(timer, stoppingToken));
    }

    /// <summary>One pass over every configured device. Public so a test can drive it without a host.</summary>
    public async Task PollAsync(CancellationToken ct)
    {
        foreach (var (key, host, port, unitId, device) in Devices())
        {
            var interval = TimeSpan.FromSeconds(Math.Max(1, device.PollIntervalSeconds));
            if (lastPoll.TryGetValue(key, out var last) && DateTime.UtcNow - last < interval) continue;
            lastPoll[key] = DateTime.UtcNow;

            await lease.RunIfOwnerAsync($"modbus:{key}", token => ReadAsync(key, host, port, unitId, device, token), ct);
        }
    }

    /// <summary>The physical devices to poll, each with the bindings every connection to it contributes.</summary>
    public IEnumerable<(string Key, string Host, int Port, int UnitId, ModbusDeviceConfig Device)> Devices()
    {
        var byDevice = config.Modbus.Connections
            .Where(c => c.Enabled && !string.IsNullOrWhiteSpace(c.Host) && !string.IsNullOrWhiteSpace(c.Id))
            .GroupBy(c => (c.Host, c.Port, c.UnitId));

        foreach (var group in byDevice)
        {
            var connIds = group.Select(c => c.Id).ToHashSet(StringComparer.Ordinal);
            var first = group.First();

            var bindings = new List<ModbusBinding>();
            foreach (var node in config.EnergyFlow.Nodes)
                foreach (var s in node.AllSources())
                    if (string.Equals(s.Type, "modbus", StringComparison.OrdinalIgnoreCase) && s.Connection is { } conn && connIds.Contains(conn))
                        bindings.Add(new ModbusBinding
                        {
                            NodeId = node.Id,
                            Metric = s.Metric,
                            Register = s.Register,
                            RegisterType = s.RegisterType,
                            DataType = s.DataType,
                            WordOrder = s.WordOrder,
                            Unit = s.Unit,
                            Scale = s.Scale,
                            StaleAfterSeconds = s.StaleAfterSeconds,
                        });

            if (bindings.Count == 0) continue;   // nothing bound to this device → nothing to read

            yield return (ModbusDevices.KeyFor(first.Host, first.Port, first.UnitId), first.Host, first.Port, first.UnitId,
                new ModbusDeviceConfig
                {
                    Framing = first.Framing,
                    TimeoutMs = first.TimeoutMs,
                    PollIntervalSeconds = first.PollIntervalSeconds,
                    Bindings = bindings,
                });
        }
    }

    private async Task ReadAsync(string key, string host, int port, int unitId, ModbusDeviceConfig device, CancellationToken ct)
    {
        var health = new ModbusHealth
        {
            Key = key,
            Bindings = device.Bindings.Count,
            PollIntervalSeconds = device.PollIntervalSeconds,
            LastAttemptUtc = DateTime.UtcNow,
            LastOkUtc = devices.For(key)?.LastOkUtc,
            LastValueCount = devices.For(key)?.LastValueCount ?? 0,
        };

        var sources = device.Bindings.Select(b => new EnergyFlowSource
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

        // Blocking device I/O, off the loop's thread.
        var (ok, message, readings) = await Task.Run(
            () => EnergyFlowModbusSourceService.Probe(host, port, unitId, device.Framing, device.TimeoutMs, sources), ct);

        // Couldn't even open the socket — the gateway/device is unreachable at host:port.
        if (!ok)
        {
            devices.Report(health with { LastError = message });
            log?.LogWarning("Modbus {Key}: {Msg}", key, message);
            return;
        }

        var mapped = new List<MeasurementReading>();
        var failures = new List<string>();
        for (int i = 0; i < readings.Count && i < device.Bindings.Count; i++)
        {
            var r = readings[i];
            var b = device.Bindings[i];
            if (r.Error is not null || r.Value is null)
            {
                failures.Add($"{b.RegisterType} reg {b.Register} ({b.DataType}) → {r.Error ?? "no value"}");
                continue;
            }
            if (!Metrics.TryParse(b.Metric, out var metric)) { failures.Add($"reg {b.Register}: unknown metric '{b.Metric}'"); continue; }
            mapped.Add(new MeasurementReading(b.NodeId, metric, r.Value.Value, b.StaleAfterSeconds));
        }

        // Surface partial/total read failures at Warning so they're actually visible (this is the whole point
        // of "it doesn't work"): the device answered the socket but not the register reads.
        if (failures.Count > 0)
            log?.LogWarning("Modbus {Key} ({Msg}): {Fail}/{Total} register(s) failed — {Details}",
                key, message, failures.Count, readings.Count, string.Join("; ", failures));

        if (mapped.Count == 0)
        {
            // Socket opened but every register read failed — the device answered but gave us nothing usable.
            devices.Report(health with
            {
                LastError = failures.Count > 0 ? $"{failures.Count} register(s) failed: {failures[0]}" : "no values read",
            });
            return;
        }

        log?.LogInformation("Modbus {Key}: read {Count} value(s) ({Msg}).", key, mapped.Count, message);
        versions.TryGetValue(key, out var version);
        versions[key] = ++version;
        // A partial read still counts as reachable, but keep the failure note so the GUI can show "3 of 5 read".
        devices.Report(health with
        {
            LastOkUtc = DateTime.UtcNow,
            LastValueCount = mapped.Count,
            LastError = failures.Count > 0 ? $"{failures.Count} of {readings.Count} register(s) failed" : null,
        });

        if (sink is not null)
            await sink.EmitAsync(new MeasurementSnapshot(key, DateTimeOffset.UtcNow, version, mapped), ct);
    }
}
