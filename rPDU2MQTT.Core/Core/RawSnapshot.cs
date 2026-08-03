using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;

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

    /// <summary>
    /// Re-establish the MQTT topic wiring on a rebuilt <see cref="PduData"/>.
    ///
    /// <para>
    /// <c>Record_Key</c> and <c>Record_Parent</c> are <c>[JsonIgnore]</c>, so they do not cross the wire, and
    /// nothing downstream can reconstruct them from the payload alone. <c>GetTopicPath()</c> walks that
    /// parent chain upward; with it missing the path collapses to nothing and a measurement publishes to the
    /// bare topic <c>state</c> at the broker root. That is not a topic anyone subscribes to, so on a live
    /// system every Home Assistant sensor read "Unavailable" while discovery — which builds its ids by a
    /// different route — looked perfectly healthy.
    /// </para>
    /// <para>
    /// The wiring below mirrors what the poller does when it first builds the graph, and must keep mirroring
    /// it: <c>SetParentAndIdentifier</c> also recomputes <c>Entity_Identifier</c>, which is the Home
    /// Assistant unique_id. Diverging here would not fail loudly — it would silently mint a second device for
    /// every outlet and leave the originals orphaned, which is a mess that outlives the fix.
    /// </para>
    /// </summary>
    /// <param name="data">The rebuilt graph, straight out of <see cref="ToData"/>.</param>
    /// <param name="parentTopic">The MQTT parent topic — the root of every path (<c>MQTT.ParentTopic</c>).</param>
    /// <param name="rootIdentifier">The root's <c>Entity_Identifier</c>, which every child id is built from.</param>
    public static void Rewire(PduData data, string parentTopic, string rootIdentifier)
    {
        // PduData is a container, not a topic node — the poller's root is the OneView document, which does
        // not survive the wire either. A stand-in carrying the same key and identifier reproduces the same
        // paths and the same ids, which is all the chain below reads from it.
        var root = new DummyEntity
        {
            Record_Key = parentTopic ?? "",
            Record_Parent = null,
            Entity_Identifier = rootIdentifier ?? "",
        };

        data.Devices.SetParentAndIdentifier(root, o => o.Key);
        foreach (var device in data.Devices)
        {
            device.Entity.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Entity), o => o.Key);
            device.Outlets.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Outlets), o => o.Key.ToString());

            foreach (var entity in device.Entity)
                entity.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(entity, MqttPath.Measurements), o => o.Type);
            foreach (var outlet in device.Outlets)
                outlet.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(outlet, MqttPath.Measurements), o => o.Type);
        }
    }

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
