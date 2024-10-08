﻿using System.ComponentModel;
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

    [YamlMember(Alias = "Scheme", DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Display(Name = "Connection Scheme", Description = "Connection scheme used")]
    [Description("Default connection scheme.")]
    public string? Scheme { get; set; }

    [DefaultValue(true)]
    [Display(Name = "Validate Certificate", Description = "Enables certificate validation")]
    [YamlMember(Alias = "ValidateCertificate")]
    public bool? ValidateCertificate { get; set; } = true;
}
