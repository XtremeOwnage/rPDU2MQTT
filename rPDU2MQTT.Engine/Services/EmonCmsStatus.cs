using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Services;

/// <summary>
/// The outcome of the most recent EmonCMS export, for the GUI's health indicator and the heartbeat.
///
/// <para>
/// A view over the shared <see cref="IntegrationStatus"/> rather than a store of its own. Two holders for
/// one idea is how a card and an endpoint end up disagreeing about whether the last export worked — one
/// gets updated and the other does not, and neither looks wrong on its own. The name and shape are kept
/// because the Status grain, the heartbeat and the GUI all read them.
/// </para>
/// </summary>
public sealed class EmonCmsStatus
{
    /// <summary>The id everything generic keys EmonCMS by — the integration's own.</summary>
    private const string Id = "emoncms";

    private readonly IntegrationStatus status;

    public EmonCmsStatus(IntegrationStatus status) => this.status = status;

    private IntegrationStatus.Entry? Entry => status.For(Id);

    public DateTime? LastAttemptUtc => Entry?.LastAttemptUtc;
    public DateTime? LastSuccessUtc => Entry?.LastSuccessUtc;
    public bool? LastOk => Entry?.LastOk;
    public string? LastError => Entry?.LastError;
    public int LastCount => Entry?.Count ?? 0;

    public void RecordSuccess(int count) => status.RecordSuccess(Id, count);

    public void RecordFailure(string error) => status.RecordFailure(Id, error);

    /// <summary>
    /// True once this process has actually tried an export — i.e. it is the one running the exporter.
    /// </summary>
    /// <remarks>
    /// The distinction matters on a fleet: "I have not attempted an export" is not evidence there was no
    /// export, and the status grain uses exactly this to refuse letting an outcome-free report from a
    /// non-exporting process overwrite a known one.
    /// </remarks>
    public bool HasAttempted => Entry?.LastAttemptUtc is not null;

    /// <summary>A snapshot for serialization (the diagnostics endpoint) and for the heartbeat.</summary>
    public Core.EmonCmsHealth Snapshot()
    {
        var e = Entry;
        return new Core.EmonCmsHealth(e?.LastOk, e?.LastAttemptUtc, e?.LastSuccessUtc, e?.LastError, e?.Count ?? 0);
    }
}
