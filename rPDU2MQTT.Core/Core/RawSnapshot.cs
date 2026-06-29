using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Transport;

// Explicit, round-trippable wire contract for moving a single poll between role processes (#127).
//
// Why a dedicated DTO instead of serializing PduData directly: the PDU models are an *input* contract for
// the Vertiv API. Their consumer-facing fields (Entity_Name/Entity_DisplayName) are [JsonIgnore] values
// *derived* later by the naming/override transform, and even the dictionary keys ([JsonIgnore] Key) don't
// serialize. So this carries only the *raw source* a consumer needs to reconstruct a PduData and re-run
// the transform itself. (The transform isn't idempotent, so it must run once, consumer-side.)
//
// Scope: devices -> outlets -> measurements (the data the flow/Sankey and live views use). Device
// entities and OneView groups are deliberately not carried yet — a mechanical follow-up.

public sealed record RawSnapshot(string InstanceId, DateTime TimestampUtc, List<RawDevice> Devices);

public sealed record RawDevice(string? Key, string? Name, string? Label, string? State, string? Type, List<RawOutlet> Outlets);

public sealed record RawOutlet(int Key, string? Name, string? Label, string? State, List<RawMeasurement> Measurements);

public sealed record RawMeasurement(string? Key, string? Type, string? Value, string? Units, string? State);

/// <summary>Maps between the live <see cref="PduData"/> model and the <see cref="RawSnapshot"/> wire form.</summary>
public static class RawSnapshotMapper
{
    /// <summary>Producer side: project a freshly-polled (pre-transform) snapshot onto the wire contract.</summary>
    public static RawSnapshot ToWire(string instanceId, DateTime timestampUtc, PduData data) =>
        new(instanceId, timestampUtc, data.Devices.Select(ToWire).ToList());

    private static RawDevice ToWire(Device d) =>
        new(d.Key, d.Name, d.Label, d.State, d.Type, d.Outlets.Select(ToWire).ToList());

    private static RawOutlet ToWire(Outlet o) =>
        new(o.Key, o.Name, o.Label, o.State, o.Measurements.Select(ToWire).ToList());

    private static RawMeasurement ToWire(Measurement m) =>
        new(m.Key, m.Type, m.Value, m.Units, m.State);

    /// <summary>Consumer side: rebuild a raw <see cref="PduData"/> (keys restored) ready for the transform.</summary>
    public static PduData ToData(RawSnapshot snapshot)
    {
        var data = new PduData();
        foreach (var d in snapshot.Devices)
        {
            var device = new Device { Key = d.Key!, Name = d.Name!, Label = d.Label!, State = d.State!, Type = d.Type! };
            foreach (var o in d.Outlets)
            {
                var outlet = new Outlet { Key = o.Key, Name = o.Name!, Label = o.Label!, State = o.State! };
                foreach (var m in o.Measurements)
                    outlet.Measurements.Add(new Measurement { Key = m.Key!, Type = m.Type!, Value = m.Value!, Units = m.Units!, State = m.State! });
                device.Outlets.Add(outlet);
            }
            data.Devices.Add(device);
        }
        return data;
    }
}
