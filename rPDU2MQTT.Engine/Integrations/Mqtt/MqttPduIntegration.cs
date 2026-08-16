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
    private readonly HiveMQtt.Client.IHiveMQClient? mqtt;

    public MqttPduIntegration(Config cfg, Services.MqttPduPublisher publisher, HiveMQtt.Client.IHiveMQClient? mqtt = null)
    {
        this.cfg = cfg;
        this.publisher = publisher;
        this.mqtt = mqtt;
    }

    public string Id => "mqtt";
    public string DisplayName => "MQTT";
    public IntegrationGroup Group => IntegrationGroup.Integrations;

    /// <summary>
    /// Always on. This is not an optional destination — it is what the bridge is for, and the switch that
    /// would turn it off is <c>Debug.PublishMessages</c>, which the publisher itself honours.
    /// </summary>
    public bool Enabled(Config c) => true;

    /// <summary>
    /// The broker connection itself, not the configured address. "Publishing" while disconnected is the
    /// card that sends someone looking at the wrong thing — everything downstream of a dead broker is
    /// silent, and this is the one place that can say why.
    /// </summary>
    public IntegrationHealth Status(Config c)
    {
        var where = $"{c.MQTT.Connection?.Host}:{c.MQTT.Connection?.Port}";
        if (mqtt is null) return new(HealthLevel.Warn, "No client", where);
        return mqtt.IsConnected()
            ? new(HealthLevel.Good, "Connected", $"{where} under '{c.MQTT.ParentTopic}'")
            : new(HealthLevel.Bad, "Disconnected", where);
    }

    public Task<(bool Ok, string Detail)> ProbeAsync(Config c, CancellationToken ct)
    {
        var health = Status(c);
        return Task.FromResult((health.Level == HealthLevel.Good, health.Detail ?? health.Summary));
    }

    public async Task SendAsync(ExportPass pass, CancellationToken ct)
    {
        foreach (var snapshot in pass.Snapshots)
            await publisher.PublishAsync(snapshot, ct);
    }
}
