using rPDU2MQTT.Grains.Abstractions.Status;

namespace rPDU2MQTT.Grains.Status;

// The Status board's components, one lightweight grain per kind. Each is only its verdict rule — the base
// owns reporting, silence, publishing and retirement — so "what does amber mean for EmonCMS?" is answered in
// one place, by the thing it's about, for the whole cluster.

/// <summary>The broker connection. Reported by every process; the card is about the broker, so last word wins.</summary>
public sealed class MqttStatusGrain : ComponentStatusGrainBase, IMqttStatusGrain
{
    protected override int Order => 10;
    protected override string DefaultTitle => "MQTT";

    protected override Verdict Evaluate(DateTime nowUtc)
        => !report.Enabled ? new(StatusLevel.Off, "Disabled", null)
         : report.Ok == true ? new(StatusLevel.Good, "Connected", report.Detail)
         : new(StatusLevel.Bad, "Disconnected", report.Detail);
}

/// <summary>
/// One PDU instance. Stale is decided against that instance's own poll interval, so a 5-minute poller isn't
/// judged by a 30-second one's standard.
/// </summary>
public sealed class PduStatusGrain : ComponentStatusGrainBase, IPduStatusGrain
{
    protected override int Order => 20;
    protected override string DefaultTitle => "PDU";
    protected override AgeStyle Age => AgeStyle.Ago;

    protected override Verdict Evaluate(DateTime nowUtc)
    {
        if (report.EventUtc is not { } polled)
            return new(StatusLevel.Warn, "No data yet", report.Detail ?? "Waiting for the first poll");

        return rPDU2MQTT.Core.SnapshotFreshness.IsStale(polled, report.IntervalSeconds, nowUtc)
            ? new(StatusLevel.Bad, "Stale", "Updated")
            : new(StatusLevel.Good, "Polling", "Updated");
    }
}

/// <summary>
/// The EmonCMS export. Only the process running the exporter has an outcome to report, so this grain refuses
/// to let an outcome-free report from any other process overwrite a known one — that scavenging used to live
/// in the GUI endpoint.
/// </summary>
public sealed class EmonCmsStatusGrain : ComponentStatusGrainBase, IEmonCmsStatusGrain
{
    protected override int Order => 30;
    protected override string DefaultTitle => "EmonCMS";

    public override Task Report(ComponentReport incoming)
    {
        // "I can't see an export outcome" is not evidence there wasn't one — keep the outcome we have.
        if (incoming.Ok is null && report.Ok is not null)
            incoming = incoming with { Ok = report.Ok, Detail = incoming.Detail ?? report.Detail, Count = report.Count, EventUtc = report.EventUtc };

        return base.Report(incoming);
    }

    protected override Verdict Evaluate(DateTime nowUtc)
    {
        if (!report.Enabled) return new(StatusLevel.Off, "Disabled", null);

        return report.Ok switch
        {
            true => new(StatusLevel.Good, "Exporting", report.Count > 0 ? $"{report.Detail} · {report.Count} values" : report.Detail),
            false => new(StatusLevel.Bad, "Error", report.Detail ?? "Last export failed"),
            _ => new(StatusLevel.Warn, "Waiting", $"{report.Detail} · no export attempted yet"),
        };
    }
}

/// <summary>Home Assistant MQTT discovery — configured or not.</summary>
public sealed class HomeAssistantStatusGrain : ComponentStatusGrainBase, IHomeAssistantStatusGrain
{
    protected override int Order => 40;
    protected override string DefaultTitle => "Home Assistant";

    protected override Verdict Evaluate(DateTime nowUtc)
        => report.Enabled
            ? new(StatusLevel.Good, "Discovery on", report.Detail)
            : new(StatusLevel.Off, "Discovery off", null);
}

/// <summary>The Prometheus exporter — configured or not.</summary>
public sealed class PrometheusStatusGrain : ComponentStatusGrainBase, IPrometheusStatusGrain
{
    protected override int Order => 50;
    protected override string DefaultTitle => "Prometheus";

    protected override Verdict Evaluate(DateTime nowUtc)
        => report.Enabled
            ? new(StatusLevel.Good, "Exporter on", report.Detail)
            : new(StatusLevel.Off, "Exporter off", null);
}

/// <summary>
/// One process in the fleet. It reports itself; the base turns its silence amber and eventually retires the
/// card — which is the whole "is that replica still there?" question, answered without a heartbeat topic.
/// </summary>
public sealed class NodeStatusGrain : ComponentStatusGrainBase, INodeStatusGrain
{
    protected override int Order => 90;
    protected override string DefaultTitle => "Node";
    protected override AgeStyle Age => AgeStyle.Uptime;

    protected override Verdict Evaluate(DateTime nowUtc)
        => new(StatusLevel.Good, report.State ?? "Alive", report.Detail);
}
