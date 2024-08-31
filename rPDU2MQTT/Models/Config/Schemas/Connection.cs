using System.ComponentModel;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config.Schemas;

/// <summary>
/// This defines the schema used for connecting to another service.
/// </summary>
public class Connection
{
    [YamlMember(Alias = "Host", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Required(ErrorMessage = "Host is required.")]
    [Display(Description = "Hostname or IP to connect to.")]
    [Description("IP, or DNS Name")]
    public string? Host { get; set; }

    [YamlMember(Alias = "Port", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Range(0, 65535, ErrorMessage = "Port must be between 0 and 65535.")]
    [Display(Description = "The port to connect to.")]
    [Description("Default Port")]
    public int? Port { get; set; }

    [YamlMember(Alias = "Timeout", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Range(1, 3600, ErrorMessage = "Timeout must be between 0 and 3600.")]
    [Display(Name = "Connection Timeout", Description = "Default connection timeout.")]
    [Description("Default connection timeout.")]
    public int? TimeoutSecs { get; set; } = 15;
}
