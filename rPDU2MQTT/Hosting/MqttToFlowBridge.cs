using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Abstractions.Flow;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Flow;
using rPDU2MQTT.Services;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Bridges the in-process MQTT flow ingest onto the flow grain (v3). The MQTT source keeps subscribing
/// locally — broker fan-out is free, so unlike a single-client Modbus device there's no reason to make it a
/// single-activation grain — but its values are pushed to the flow grain so every process reads them the
/// same way as Modbus (via the grain sync), and the flow grain is the one authority. Runs on the worker.
/// </summary>
public sealed class MqttToFlowBridge : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly Config config;
    private readonly EnergyFlowMqttSourceService mqtt;
    private long version;

    public MqttToFlowBridge(IGrainFactory grains, Config config, EnergyFlowMqttSourceService mqtt)
    {
        this.grains = grains;
        this.config = config;
        this.mqtt = mqtt;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        do
        {
            try
            {
                var readings = new List<MeasurementReading>();
                foreach (var node in config.EnergyFlow.Nodes)
                    foreach (var s in node.AllSources())
                        if (string.Equals(s.Type, "mqtt", StringComparison.OrdinalIgnoreCase)
                            && Metrics.TryParse(s.Metric, out var metric)
                            && mqtt.TryGetValue(node.Id, s.Metric, out var value))
                            readings.Add(new MeasurementReading(node.Id, metric, value, s.StaleAfterSeconds));

                if (readings.Count > 0)
                    await grains.GetGrain<IFlowGrain>(0).Ingest(new MeasurementSnapshot("mqtt", DateTimeOffset.UtcNow, ++version, readings));
            }
            catch (Exception ex) { Serilog.Log.Debug($"MQTT→flow bridge: {ex.Message}"); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
