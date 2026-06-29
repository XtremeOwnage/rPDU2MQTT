using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Transport;

// Round-trippable wire contract for moving a single poll between role processes (#127).
//
// The PDU models can't be re-serialized faithfully (their Key and the computed Entity_* names are
// [JsonIgnore], and the top-level device list isn't keyed), so this carries the fields a consumer needs
// as plain, explicit properties. The worker transforms once (as it already does for its own sinks) and
// this carries the *finished* result — raw source (name/label) for editors plus the computed identity
// (Entity_Name/DisplayName/Make/Model) for display — so a consumer renders without re-running the
// (non-idempotent) transform.
//
// Scope: devices -> outlets/entities -> measurements. OneView groups are a follow-up.

public sealed record RawSnapshot(string InstanceId, DateTime TimestampUtc, List<RawDevice> Devices);

public sealed record RawDevice(
    string? Key, string? Name, string? Label, string? EntityName, string? DisplayName,
    string? Make, string? Model, string? State, string? Type,
    List<RawOutlet> Outlets, List<RawEntity> Entities);

public sealed record RawOutlet(
    int Key, string? Name, string? Label, string? EntityName, string? DisplayName,
    string? Make, string? Model, string? State, List<RawMeasurement> Measurements);

public sealed record RawEntity(
    string? Key, string? Name, string? Label, string? EntityName, string? DisplayName,
    List<RawMeasurement> Measurements);

public sealed record RawMeasurement(
    string? Key, string? Type, string? EntityName, string? DisplayName, string? Value, string? Units, string? State);

/// <summary>Maps between the live <see cref="PduData"/> model and the <see cref="RawSnapshot"/> wire form.</summary>
public static class RawSnapshotMapper
{
    /// <summary>Producer side: project a transformed snapshot onto the wire contract.</summary>
    public static RawSnapshot ToWire(string instanceId, DateTime timestampUtc, PduData data) =>
        new(instanceId, timestampUtc, data.Devices.Select(ToWire).ToList());

    private static RawDevice ToWire(Device d) => new(
        d.Key, d.Name, d.Label, d.Entity_Name, d.Entity_DisplayName, d.Entity_Make, d.Entity_Model, d.State, d.Type,
        d.Outlets.Select(ToWire).ToList(), d.Entity.Select(ToWire).ToList());

    private static RawOutlet ToWire(Outlet o) => new(
        o.Key, o.Name, o.Label, o.Entity_Name, o.Entity_DisplayName, o.Entity_Make, o.Entity_Model, o.State,
        o.Measurements.Select(ToWire).ToList());

    private static RawEntity ToWire(Entity e) => new(
        e.Key, e.Name, e.Label, e.Entity_Name, e.Entity_DisplayName, e.Measurements.Select(ToWire).ToList());

    private static RawMeasurement ToWire(Measurement m) => new(
        m.Key, m.Type, m.Entity_Name, m.Entity_DisplayName, m.Value, m.Units, m.State);

    /// <summary>Consumer side: rebuild a ready-to-render <see cref="PduData"/> (keys + computed names restored).</summary>
    public static PduData ToData(RawSnapshot snapshot)
    {
        var data = new PduData();
        foreach (var d in snapshot.Devices)
        {
            var device = new Device
            {
                Key = d.Key!, Name = d.Name!, Label = d.Label!, State = d.State!, Type = d.Type!,
                Entity_Name = d.EntityName!, Entity_DisplayName = d.DisplayName!, Entity_Make = d.Make, Entity_Model = d.Model,
            };
            foreach (var o in d.Outlets)
                device.Outlets.Add(ToOutlet(o));
            foreach (var e in d.Entities)
                device.Entity.Add(ToEntity(e));
            data.Devices.Add(device);
        }
        return data;
    }

    private static Outlet ToOutlet(RawOutlet o)
    {
        var outlet = new Outlet
        {
            Key = o.Key, Name = o.Name!, Label = o.Label!, State = o.State!,
            Entity_Name = o.EntityName!, Entity_DisplayName = o.DisplayName!, Entity_Make = o.Make, Entity_Model = o.Model,
        };
        foreach (var m in o.Measurements)
            outlet.Measurements.Add(ToMeasurement(m));
        return outlet;
    }

    private static Entity ToEntity(RawEntity e)
    {
        var entity = new Entity
        {
            Key = e.Key!, Name = e.Name!, Label = e.Label!,
            Entity_Name = e.EntityName!, Entity_DisplayName = e.DisplayName!,
        };
        foreach (var m in e.Measurements)
            entity.Measurements.Add(ToMeasurement(m));
        return entity;
    }

    private static Measurement ToMeasurement(RawMeasurement m) => new()
    {
        Key = m.Key!, Type = m.Type!, Value = m.Value!, Units = m.Units!, State = m.State!,
        Entity_Name = m.EntityName!, Entity_DisplayName = m.DisplayName!,
    };
}
