namespace rPDU2MQTT.Core;

/// <summary>
/// This process's current cluster-leadership flag (v3), kept fresh by the leader-renewal service. Run-once
/// work (publishers/exporters) reads it to self-gate, so N identical instances don't duplicate output. Lives
/// in Core so the Engine services can read it without an Orleans dependency.
/// </summary>
public sealed class LeaderState
{
    private volatile bool isLeader;
    public bool IsLeader { get => isLeader; set => isLeader = value; }
}
