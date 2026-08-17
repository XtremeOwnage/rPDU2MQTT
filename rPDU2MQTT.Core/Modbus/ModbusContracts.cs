using System.Collections.Concurrent;

namespace rPDU2MQTT.Core.Modbus;

/// <summary>One register binding on a device: which node/metric it feeds and how to read/decode it.</summary>
public sealed record ModbusBinding
{
    public string NodeId { get; init; } = "";
    public string Metric { get; init; } = "realpower";
    public int Register { get; init; }
    public string RegisterType { get; init; } = "holding";
    public string DataType { get; init; } = "uint16";
    public string WordOrder { get; init; } = "big";
    public string? Unit { get; init; }
    public double Scale { get; init; } = 1.0;
    public int StaleAfterSeconds { get; init; } = 900;
}

/// <summary>
/// A Modbus device's poll health, so the GUI can show whether a source (e.g. an inverter) is actually being
/// read — the gap that made "everything's green but no data" impossible to diagnose. All times are UTC.
/// </summary>
public sealed record ModbusHealth
{
    public string Key { get; init; } = "";        // host|port|unitId
    public int Bindings { get; init; }
    public DateTime? LastAttemptUtc { get; init; }
    public DateTime? LastOkUtc { get; init; }      // last poll that mapped ≥1 value
    public int LastValueCount { get; init; }       // values read on the last OK poll
    public string? LastError { get; init; }        // socket/read failure summary, or null when healthy
    public int PollIntervalSeconds { get; init; }
}

/// <summary>A device's whole configuration, derived from config by the poller (host/port/unitId are the key).</summary>
public sealed record ModbusDeviceConfig
{
    public string Framing { get; init; } = "auto";
    public int TimeoutMs { get; init; } = 1500;
    public int PollIntervalSeconds { get; init; } = 10;
    public List<ModbusBinding> Bindings { get; init; } = new();
}

/// <summary>
/// What each physical Modbus device last did, keyed by its address. Two config connections pointing at the
/// same <c>host:port:unitId</c> are one device and share one entry — which is the point, because a
/// single-client RS485 gateway can only answer one reader at a time.
/// </summary>
public sealed class ModbusDevices
{
    private readonly ConcurrentDictionary<string, ModbusHealth> byKey = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The key for a device address.</summary>
    public static string KeyFor(string host, int port, int unitId) => $"{host}|{port}|{unitId}";

    public ModbusHealth? For(string key) => byKey.TryGetValue(key, out var h) ? h : null;

    public ModbusHealth? For(string host, int port, int unitId) => For(KeyFor(host, port, unitId));

    public IReadOnlyCollection<ModbusHealth> All => byKey.Values.ToList();

    public void Report(ModbusHealth health) => byKey[health.Key] = health;
}
