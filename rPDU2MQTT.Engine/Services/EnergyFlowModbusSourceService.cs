using System.Net;
using FluentModbus;
using Microsoft.Extensions.Hosting;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Services;

/// <summary>
/// Feeds energy-flow nodes from Modbus TCP devices (#129) — inverters, meters, PLCs — by polling the
/// registers bound in <c>EnergyFlow.Nodes[].Sources</c> with Type 'modbus' and keeping the latest value per
/// (node, metric). Shares the <see cref="IFlowValueSource"/> seam with the MQTT ingest (via
/// <see cref="CompositeFlowValueSource"/>), so a Modbus-sourced node rolls up, exports and appears in Home
/// Assistant exactly like an MQTT- or PDU-sourced one.
///
/// Each connection is polled on its own interval; connections + bindings are re-read every tick, so editing
/// them in the GUI takes effect without a restart. A device is opened per poll (connect → read → close),
/// which is simplest and robust for the seconds-scale cadence energy monitoring needs.
/// </summary>
public sealed class EnergyFlowModbusSourceService : BackgroundService, IFlowValueSource
{
    private readonly Config cfg;
    private readonly FlowValueCache latest = new();
    private readonly Dictionary<string, DateTime> lastPolled = new(StringComparer.Ordinal);

    public EnergyFlowModbusSourceService(Config cfg) => this.cfg = cfg;

    public bool TryGetValue(string nodeId, string metric, out double value)
        => latest.TryGetValue(nodeId, metric, out value);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            // A 1s base tick; each connection fires on its own PollIntervalSeconds.
            using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
            do
            {
                try { Reconcile(DateTime.UtcNow); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { Log.Warning($"Energy-flow Modbus: {ex.Message}"); }
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException) { /* shutting down */ }
    }

    /// <summary>Poll each due connection, and drop cached readings whose binding has gone away.</summary>
    private void Reconcile(DateTime nowUtc)
    {
        var bindings = BuildBindings(cfg.EnergyFlow.Nodes);

        // Prune readings no longer produced by any current modbus binding (a removed/retyped source).
        var live = bindings.Values.SelectMany(v => v).Select(b => (b.NodeId, b.Source.Metric)).ToHashSet();
        foreach (var key in latest.Keys.Where(k => !live.Contains((k.Node, k.Metric))).ToList())
            latest.Remove(key.Node, key.Metric);

        foreach (var conn in cfg.Modbus.Connections)
        {
            if (!conn.Enabled || string.IsNullOrWhiteSpace(conn.Id) || string.IsNullOrWhiteSpace(conn.Host)) continue;
            if (!bindings.TryGetValue(conn.Id, out var forConn) || forConn.Count == 0) continue;

            var interval = TimeSpan.FromSeconds(Math.Max(1, conn.PollIntervalSeconds));
            if (lastPolled.TryGetValue(conn.Id, out var last) && nowUtc - last < interval) continue;
            lastPolled[conn.Id] = nowUtc;

            try { Poll(conn, forConn, nowUtc); }
            catch (Exception ex) { Log.Warning($"Energy-flow Modbus: {conn.Name ?? conn.Id} ({conn.Host}:{conn.Port}) — {ex.Message}"); }
        }
    }

    private void Poll(ModbusConnection conn, List<(string NodeId, EnergyFlowSource Source)> forConn, DateTime nowUtc)
    {
        var endpoint = new IPEndPoint(ResolveHost(conn.Host), conn.Port);
        using var client = new ModbusTcpClient { ReadTimeout = 3000, WriteTimeout = 3000 };
        client.Connect(endpoint, ModbusEndianness.BigEndian);

        foreach (var (nodeId, src) in forConn)
        {
            try
            {
                var count = ModbusDecode.RegisterCount(src.DataType);
                var regs = string.Equals(src.RegisterType, "input", StringComparison.OrdinalIgnoreCase)
                    ? client.ReadInputRegisters<ushort>(conn.UnitId, src.Register, count).ToArray()
                    : client.ReadHoldingRegisters<ushort>(conn.UnitId, src.Register, count).ToArray();

                var raw = ModbusDecode.Decode(regs, src.DataType, src.WordOrder);
                // Normalise the declared unit, then apply the manual Scale — the same pipeline as MQTT.
                var value = raw * FlowUnits.ToCanonicalFactor(src.Metric, src.Unit) * src.Scale;
                latest.Set(nodeId, src.Metric, value, src.StaleAfterSeconds, nowUtc);
            }
            catch (Exception ex)
            {
                Log.Debug($"Energy-flow Modbus: node '{nodeId}' register {src.Register} on {conn.Id} — {ex.Message}");
            }
        }
    }

    private static IPAddress ResolveHost(string host)
        => IPAddress.TryParse(host, out var ip)
            ? ip
            : Dns.GetHostAddresses(host).FirstOrDefault(a => a.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
              ?? Dns.GetHostAddresses(host).First();

    /// <summary>Group the nodes' Modbus-type bindings by connection id for the poller. Testable without a device.</summary>
    internal static Dictionary<string, List<(string NodeId, EnergyFlowSource Source)>> BuildBindings(IEnumerable<EnergyFlowNode> nodes)
    {
        var byConn = new Dictionary<string, List<(string, EnergyFlowSource)>>(StringComparer.Ordinal);
        foreach (var node in nodes)
        {
            if (string.IsNullOrWhiteSpace(node.Id)) continue;
            foreach (var src in node.AllSources())
            {
                if (!string.Equals(src.Type, "modbus", StringComparison.OrdinalIgnoreCase)) continue;
                if (string.IsNullOrWhiteSpace(src.Connection) || string.IsNullOrWhiteSpace(src.Metric)) continue;
                var conn = src.Connection.Trim();
                if (!byConn.TryGetValue(conn, out var list)) byConn[conn] = list = new();
                list.Add((node.Id.Trim(), src));
            }
        }
        return byConn;
    }
}
