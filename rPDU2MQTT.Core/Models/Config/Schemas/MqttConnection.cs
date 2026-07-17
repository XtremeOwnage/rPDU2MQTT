using System.ComponentModel;
using System.Text.Json.Serialization;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config.Schemas;

/// <summary>
/// Connection details for an MQTT broker. Identical to <see cref="Connection"/> except that the
/// scheme is drawn from the MQTT vocabulary (mqtt/mqtts/ws/wss) rather than http/https (#189).
/// </summary>
public class MqttConnection : Connection
{
    [YamlMember(Alias = "Scheme", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Display(Name = "Connection Scheme", Description = "How to reach the broker: mqtt (plain TCP), mqtts (TLS), ws (WebSocket) or wss (WebSocket over TLS). Leave unset to infer from the port.")]
    [Description("Broker connection scheme.")]
    [AllowedValues("mqtt", "mqtts", "ws", "wss")]
    public override string? Scheme { get; set; }

    /// <summary>
    /// The scheme actually in effect. When unset, infer it from the port so configs written before this
    /// field existed keep working — and a broker on 8883 still gets TLS rather than silently connecting
    /// in plaintext. Anything unrecognized falls back to plain mqtt, matching the previous behaviour.
    /// </summary>
    [JsonIgnore]
    [YamlIgnore]
    public string EffectiveScheme => Scheme?.ToLowerInvariant() ?? Port switch
    {
        8883 => "mqtts",
        8000 => "ws",
        8884 => "wss",
        _ => "mqtt",
    };

    /// <summary>True when the effective scheme carries the connection over TLS.</summary>
    [JsonIgnore]
    [YamlIgnore]
    public bool UsesTls => EffectiveScheme is "mqtts" or "wss";

    /// <summary>True when the effective scheme tunnels MQTT over WebSockets.</summary>
    [JsonIgnore]
    [YamlIgnore]
    public bool UsesWebSockets => EffectiveScheme is "ws" or "wss";

    /// <summary>
    /// The port to connect on. When unset, fall back to the well-known default for the effective scheme
    /// so a host-plus-scheme config connects without also having to spell out the port.
    /// </summary>
    [JsonIgnore]
    [YamlIgnore]
    public int ResolvedPort => Port ?? EffectiveScheme switch
    {
        "mqtts" => 8883,
        "ws" => 8000,
        "wss" => 8884,
        _ => 1883,
    };
}
