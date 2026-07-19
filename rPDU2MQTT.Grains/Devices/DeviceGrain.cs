using Microsoft.Extensions.Logging;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Devices;
using rPDU2MQTT.Grains.Abstractions.Flow;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Grains.Devices;

/// <summary>
/// One Modbus connection, owned cluster-wide (single activation, keyed by connection id). Every read goes
/// through this one grain, so a single-client gateway is never contended. Reads are throttled to the
/// connection's poll interval and pushed to the flow grain. The blocking device I/O runs off the grain turn
/// via <c>Task.Run</c>, and calls serialize on the single activation — no lock needed for the device itself.
/// </summary>
public sealed class DeviceGrain : Grain, IDeviceGrain
{
    private readonly Config config;
    private readonly ILogger<DeviceGrain> log;
    private MeasurementSnapshot? latest;
    private DateTime lastPollUtc = DateTime.MinValue;
    private long version;

    public DeviceGrain(Config config, ILogger<DeviceGrain> log)
    {
        this.config = config;
        this.log = log;
    }

    public Task<MeasurementSnapshot?> Latest() => Task.FromResult(latest);

    public async Task Poll()
    {
        var connId = this.GetPrimaryKeyString();
        var conn = config.Modbus.Connections.FirstOrDefault(c => c.Id == connId);
        if (conn is null || !conn.Enabled || string.IsNullOrWhiteSpace(conn.Host)) return;

        var interval = TimeSpan.FromSeconds(Math.Max(1, conn.PollIntervalSeconds));
        if (DateTime.UtcNow - lastPollUtc < interval) return;   // throttle: one read per interval, no matter how many callers
        lastPollUtc = DateTime.UtcNow;

        // Bindings whose source is a Modbus register on this connection.
        var bindings = new List<(string NodeId, EnergyFlowSource Source)>();
        foreach (var node in config.EnergyFlow.Nodes)
            foreach (var s in node.AllSources())
                if (string.Equals(s.Type, "modbus", StringComparison.OrdinalIgnoreCase) && string.Equals(s.Connection, connId, StringComparison.Ordinal))
                    bindings.Add((node.Id, s));
        if (bindings.Count == 0) return;

        var sources = bindings.Select(b => b.Source).ToList();
        var (ok, message, readings) = await Task.Run(() =>
            EnergyFlowModbusSourceService.Probe(conn.Host, conn.Port, conn.UnitId, conn.Framing, sources));

        var mapped = new List<MeasurementReading>();
        for (int i = 0; i < readings.Count && i < bindings.Count; i++)
        {
            var r = readings[i];
            if (r.Error is not null || r.Value is null) continue;
            if (!Metrics.TryParse(bindings[i].Source.Metric, out var metric)) continue;
            mapped.Add(new MeasurementReading(bindings[i].NodeId, metric, r.Value.Value, bindings[i].Source.StaleAfterSeconds));
        }

        if (mapped.Count == 0) { log.LogDebug("Device {Conn}: no readings ({Msg})", connId, message); return; }

        latest = new MeasurementSnapshot(connId, DateTimeOffset.UtcNow, ++version, mapped);
        await GrainFactory.GetGrain<IFlowGrain>(0).Ingest(latest);
    }
}
