using rPDU2MQTT.Abstractions.Flow;

namespace rPDU2MQTT.Grains.Abstractions.Modbus;

/// <summary>One register binding on a device: which node/metric it feeds and how to read/decode it.</summary>
[GenerateSerializer]
public sealed record ModbusBinding
{
    [Id(0)] public string NodeId { get; init; } = "";
    [Id(1)] public string Metric { get; init; } = "realpower";
    [Id(2)] public int Register { get; init; }
    [Id(3)] public string RegisterType { get; init; } = "holding";
    [Id(4)] public string DataType { get; init; } = "uint16";
    [Id(5)] public string WordOrder { get; init; } = "big";
    [Id(6)] public string? Unit { get; init; }
    [Id(7)] public double Scale { get; init; } = 1.0;
    [Id(8)] public int StaleAfterSeconds { get; init; } = 900;
}

/// <summary>A device's whole configuration, pushed to the grain by the reconciler (host/port/unitId are the key).</summary>
[GenerateSerializer]
public sealed record ModbusDeviceConfig
{
    [Id(0)] public string Framing { get; init; } = "auto";
    [Id(1)] public int TimeoutMs { get; init; } = 1500;
    [Id(2)] public int PollIntervalSeconds { get; init; } = 10;
    [Id(3)] public List<ModbusBinding> Bindings { get; init; } = new();
}

/// <summary>
/// One physical Modbus device — a single-activation grain keyed by <c>host|port|unitId</c> (see
/// <see cref="KeyFor"/>). Because the key is the device address, two config connections pointing at the same
/// device resolve to the <b>same</b> grain — the one owner of that device connection, cluster-wide. The
/// reconciler hands it its <see cref="ModbusDeviceConfig"/> once (and refreshes it on config change); the
/// grain then <b>self-polls on its own timer</b> using that held config — it does not re-derive anything per
/// poll. This is the structural fix for a single-client RS485 gateway.
/// </summary>
public interface IModbusGrain : IGrainWithStringKey
{
    /// <summary>Set/refresh this device's config and (re)start its poll timer. Also keeps the grain alive.</summary>
    Task Configure(ModbusDeviceConfig config);

    /// <summary>The most recent successful reading set from this device, or null if none yet.</summary>
    Task<MeasurementSnapshot?> Latest();

    /// <summary>The grain key for a device address.</summary>
    static string KeyFor(string host, int port, int unitId) => $"{host}|{port}|{unitId}";
}
