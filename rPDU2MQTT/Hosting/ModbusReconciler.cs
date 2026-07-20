using Microsoft.Extensions.Hosting;
using Orleans;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Grains.Abstractions.Modbus;

namespace rPDU2MQTT.Hosting;

/// <summary>
/// Reconciles Modbus devices to grains (v3). On a timer it reads the config once, groups connections by
/// physical device (host:port:unitId), gathers each device's register bindings, and pushes that config to the
/// device's <see cref="IModbusGrain"/> — spinning up a persistent grain per device and refreshing it when the
/// config changes. The grains self-poll; this does the config work, not each grain on every poll. A device
/// dropped from config stops getting Configure calls and the grain self-deactivates.
/// </summary>
public sealed class ModbusReconciler : BackgroundService
{
    private readonly IGrainFactory grains;
    private readonly Config config;

    public ModbusReconciler(IGrainFactory grains, Config config)
    {
        this.grains = grains;
        this.config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(3), stoppingToken); } catch (OperationCanceledException) { return; }

        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        do
        {
            try { await ReconcileAsync(); }
            catch (Exception ex) { Serilog.Log.Debug($"Modbus reconciler: {ex.Message}"); }
        }
        while (await SafeWait(timer, stoppingToken));
    }

    private async Task ReconcileAsync()
    {
        // One grain per physical device — two config connections to the same host:port:unitId share it.
        var byDevice = config.Modbus.Connections
            .Where(c => c.Enabled && !string.IsNullOrWhiteSpace(c.Host) && !string.IsNullOrWhiteSpace(c.Id))
            .GroupBy(c => (Host: c.Host, c.Port, c.UnitId));

        foreach (var device in byDevice)
        {
            var connIds = device.Select(c => c.Id).ToHashSet(StringComparer.Ordinal);
            var first = device.First();

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

            if (bindings.Count == 0) continue;   // nothing bound to this device → no grain

            var cfg = new ModbusDeviceConfig
            {
                Framing = first.Framing,
                TimeoutMs = first.TimeoutMs,
                PollIntervalSeconds = first.PollIntervalSeconds,
                Bindings = bindings,
            };
            await grains.GetGrain<IModbusGrain>(IModbusGrain.KeyFor(first.Host, first.Port, first.UnitId)).Configure(cfg);
        }
    }

    private static async Task<bool> SafeWait(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }
}
