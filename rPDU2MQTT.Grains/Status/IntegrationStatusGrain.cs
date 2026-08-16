using rPDU2MQTT.Grains.Abstractions.Status;

namespace rPDU2MQTT.Grains.Status;

/// <summary>
/// The generic integration card. Its verdict is the one thing that can be said about any integration
/// without knowing what it talks to: switched off, misconfigured, exporting, or enabled and yet to report.
/// </summary>
public sealed class IntegrationStatusGrain : ComponentStatusGrainBase, IIntegrationStatusGrain
{
    // After the hand-written components, so a plugin never displaces MQTT or a PDU at the top of the board.
    protected override int Order => 60;
    protected override string DefaultTitle => "Integration";
    protected override AgeStyle Age => AgeStyle.Ago;

    protected override Verdict Evaluate(DateTime nowUtc)
    {
        if (!report.Enabled) return new(StatusLevel.Off, "Disabled", report.Detail);
        // Enabled but unusable is its own state and has to be visible: it will never attempt anything,
        // which would otherwise read as a healthy card that simply never counts up.
        if (report.Ok == false) return new(StatusLevel.Bad, "Failing", report.Detail);
        if (report.Ok == true) return new(StatusLevel.Good, "Exporting", report.Detail);
        return new(StatusLevel.Warn, "No data yet", report.Detail ?? "Enabled, nothing reported yet");
    }
}
