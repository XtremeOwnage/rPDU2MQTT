using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;

namespace rPDU2MQTT.Integrations.Mqtt;

/// <summary>
/// The PDU's object model on the broker: names, states, alarms, measurements and outlet config — the
/// bridge's original job, now stated as a destination like everything else.
///
/// <para>
/// It publishes from <see cref="ExportPass.Snapshots"/> rather than the merged view, because a reading has
/// to carry the moment its OWN device was polled. The merged snapshot has one timestamp for everything,
/// and Home Assistant's <c>expire_after</c> is judged against exactly that value — so a slow PDU sharing a
/// pass with a fast one would have looked fresh right up until both went stale together.
/// </para>
/// </summary>
public sealed class MqttPduIntegration : IIntegration, IMeasurementDestination, IStatusProvider
{
    private readonly Config cfg;
    private readonly Services.MqttPduPublisher publisher;

    public MqttPduIntegration(Config cfg, Services.MqttPduPublisher publisher)
    {
        this.cfg = cfg;
        this.publisher = publisher;
    }

    public string Id => "mqtt";
    public string DisplayName => "MQTT";
    public IntegrationGroup Group => IntegrationGroup.Integrations;

    /// <summary>
    /// Always on. This is not an optional destination — it is what the bridge is for, and the switch that
    /// would turn it off is <c>Debug.PublishMessages</c>, which the publisher itself honours.
    /// </summary>
    public bool Enabled(Config c) => true;

    public IntegrationHealth Status(Config c)
        => new(HealthLevel.Good, "Publishing", $"{c.MQTT.Connection?.Host}:{c.MQTT.Connection?.Port} under '{c.MQTT.ParentTopic}'");

    public async Task SendAsync(ExportPass pass, CancellationToken ct)
    {
        foreach (var snapshot in pass.Snapshots)
            await publisher.PublishAsync(snapshot, ct);
    }
}
