namespace rPDU2MQTT.Core;

/// <summary>
/// Which workload(s) a process runs (#127). The components live in one solution and one executable; the
/// active role(s) decide which hosted services start. Default is <see cref="All"/> — a single node that
/// does everything — but the same binary can run a single role per process to scale out (e.g. several
/// <see cref="Worker"/>s behind one <see cref="Ui"/>). Lives in Core so every layer (host, engine, web)
/// can read the active roles; the resolver that parses it from configuration stays in the host.
/// </summary>
[Flags]
public enum HostRole
{
    None = 0,
    /// <summary>Automation / data processing: PDU pollers, MQTT publish, exporters, discovery, control.</summary>
    Worker = 1,
    /// <summary>Middle tier: the read-only REST API.</summary>
    Api = 2,
    /// <summary>The configuration GUI.</summary>
    Ui = 4,
    All = Worker | Api | Ui,
}
