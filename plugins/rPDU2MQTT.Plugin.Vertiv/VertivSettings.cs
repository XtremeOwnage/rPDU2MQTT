using System.ComponentModel;

namespace rPDU2MQTT.Plugin.Vertiv;

public sealed class VertivSettings
{
    [DefaultValue(true)]
    [Description("Poll and control the PDUs under Pdus.")]
    public bool Enabled { get; set; } = true;
}
