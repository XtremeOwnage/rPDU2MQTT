using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.Config.Schemas;

namespace rPDU2MQTT.Classes;

/// <summary>
/// Builds a <see cref="PDU"/> (with its own HttpClient + <see cref="PduApiHandler"/>) for a single
/// configured instance. Each instance gets an HttpClient bound to its connection/credentials; the
/// shared global <see cref="Config"/> (Overrides, ParentTopic) is passed through.
/// </summary>
public sealed class PduInstanceFactory
{
    private readonly Config config;

    public PduInstanceFactory(Config config) => this.config = config;

    public PDU Create(PduConfig instanceConfig) => Create(instanceConfig, config);

    /// <summary>Build an instance using a specific global config for overrides (e.g. an unsaved GUI form).</summary>
    public PDU Create(PduConfig instanceConfig, Config configForOverrides)
    {
        ThrowError.TestRequiredConfigurationSection(instanceConfig.Connection, "Pdus[].Connection");
        ThrowError.TestRequiredConfigurationSection(instanceConfig.Connection.Host, "Pdus[].Connection.Host");

        var http = BuildHttpClient(instanceConfig.Connection);
        var api = new PduApiHandler(http, instanceConfig);
        return new PDU(instanceConfig, configForOverrides, api);
    }

    /// <summary>
    /// Re-point an existing PDU at a new configuration, instead of building a replacement (#192). Used for
    /// the primary instance, whose object identity is pinned by DI. Built through the same path as
    /// <see cref="Create(PduConfig)"/>, so a re-pointed instance is configured identically to a fresh one.
    /// </summary>
    public void Repoint(PDU pdu, PduConfig instanceConfig)
    {
        ThrowError.TestRequiredConfigurationSection(instanceConfig.Connection, "Pdus[].Connection");
        ThrowError.TestRequiredConfigurationSection(instanceConfig.Connection.Host, "Pdus[].Connection.Host");

        pdu.Repoint(instanceConfig, BuildHttpClient(instanceConfig.Connection));
    }

    private static HttpClient BuildHttpClient(Connection conn)
    {
        var uri = new UriBuilder { Host = conn.Host, Port = conn.Port ?? 80 };
        uri.Scheme = !string.IsNullOrEmpty(conn.Scheme)
            ? conn.Scheme
            : uri.Port switch { 80 => "http", 443 => "https", _ => uri.Scheme };

        var handler = new HttpClientHandler();
        if (conn.ValidateCertificate == false)
        {
            handler.ClientCertificateOptions = ClientCertificateOption.Manual;
            handler.ServerCertificateCustomValidationCallback = (_, _, _, _) => true;
        }

        return new HttpClient(handler)
        {
            BaseAddress = uri.Uri,
            Timeout = TimeSpan.FromSeconds(conn.TimeoutSecs ?? 15),
        };
    }
}
