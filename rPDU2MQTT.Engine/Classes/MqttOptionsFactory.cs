using System.Security;
using HiveMQtt.Client;
using HiveMQtt.Client.Options;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Builds the HiveMQ client options from <see cref="Config"/>. Shared by startup and by the live
/// re-point in <see cref="Services.MqttReconfigurator"/>, so a broker setting can never be honoured on
/// one path but not the other (#192).
/// </summary>
public static class MqttOptionsFactory
{
    /// <summary>
    /// The MQTT settings that define the connection itself. Compared to decide whether a reloaded config
    /// needs the client re-pointed; anything not here is either irrelevant to the client or applied
    /// elsewhere.
    /// </summary>
    public static string Fingerprint(Config cfg)
    {
        var c = cfg.MQTT.Connection;
        // ClientId is deliberately excluded: it gets a fresh GUID suffix per build, so including it would
        // make every comparison differ. A configured ClientID change is caught by the ClientID field.
        return string.Join('|',
            c.Host, c.ResolvedPort, c.EffectiveScheme, c.UsesTls, c.UsesWebSockets, c.ValidateCertificate,
            cfg.MQTT.ClientID, cfg.MQTT.KeepAlive, cfg.MQTT.LastWill, cfg.MQTT.ParentTopic,
            cfg.MQTT.Credentials?.Username, cfg.MQTT.Credentials?.Password);
    }

    /// <summary>Build the client options for the given config.</summary>
    public static HiveMQClientOptions Build(Config cfg)
    {
        ThrowError.TestRequiredConfigurationSection(cfg.MQTT, "MQTT");
        ThrowError.TestRequiredConfigurationSection(cfg.MQTT.Connection, "MQTT.Connection");
        ThrowError.TestRequiredConfigurationSection(cfg.MQTT.Connection.Host, "MQTT.Connection.Host");

        var conn = cfg.MQTT.Connection;
        var builder = new HiveMQClientOptionsBuilder()
            .WithBroker(conn.Host)
            .WithPort(conn.ResolvedPort)
            .WithClientId((cfg.MQTT.ClientID ?? "rpdu2mqtt") + Guid.NewGuid().ToString())
            .WithAutomaticReconnect(true)
            .WithKeepAlive(cfg.MQTT.KeepAlive);

        // Honour the configured scheme: mqtts/wss get TLS, ws/wss tunnel over WebSockets (#189).
        builder.WithUseTls(conn.UsesTls);
        if (conn.UsesWebSockets)
            builder.WithWebSocketServer($"{conn.EffectiveScheme}://{conn.Host}:{conn.ResolvedPort}/mqtt");

        // ValidateCertificate=false is the escape hatch for a broker with a self-signed cert.
        if (conn.UsesTls && conn.ValidateCertificate == false)
            builder.WithAllowInvalidBrokerCertificates(true);

        // Optional Last-Will so HA marks entities unavailable immediately on disconnect.
        if (cfg.MQTT.LastWill)
            builder.WithLastWillAndTestament(new LastWillAndTestament(
                MQTTHelper.StatusTopic(cfg.MQTT.ParentTopic), payload: "offline", HiveMQtt.MQTT5.Types.QualityOfService.AtLeastOnceDelivery, true));

        if (cfg.MQTT.Credentials?.Username is not null)
            builder.WithUserName(cfg.MQTT.Credentials.Username);

        if (cfg.MQTT.Credentials?.Password is not null)
            builder.WithPassword(ToSecureString(cfg.MQTT.Credentials.Password));

        return builder.Build();
    }

    private static SecureString ToSecureString(string value)
    {
        var secure = new SecureString();
        foreach (var c in value)
            secure.AppendChar(c);
        secure.MakeReadOnly();
        return secure;
    }
}
