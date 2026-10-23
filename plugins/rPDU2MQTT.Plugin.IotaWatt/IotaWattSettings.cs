using System.ComponentModel;

namespace rPDU2MQTT.Plugin.IotaWatt;

public sealed class IotaWattSettings
{
    [DefaultValue(false)]
    [Description("Read IoTaWatt inputs and outputs over each device's local query API.")]
    public bool Enabled { get; set; }

    [Description("The IoTaWatts to read.")]
    public List<IotaWattDevice> Devices { get; set; } = [];

    [DefaultValue(10)]
    [Description("Seconds between polls. IoTaWatt stops sampling while it answers a query, so keep this at 5 or more.")]
    public int PollIntervalSeconds { get; set; } = 10;

    [DefaultValue(10)]
    [Description("Seconds to wait for a device to answer.")]
    public int TimeoutSeconds { get; set; } = 10;
}

public sealed class IotaWattDevice
{
    [Description("Stable id for this device, e.g. 'main'. Bindings name it in Settings.Device.")]
    public string Id { get; set; } = "";

    [Description("Friendly name.")]
    public string? Name { get; set; }

    [DefaultValue(true)]
    [Description("Read this device.")]
    public bool Enabled { get; set; } = true;

    [Description("Base URL, e.g. http://iotawatt.local.")]
    public string Url { get; set; } = "";

    [Description("Unix or ISO time that lifetime energy counters count from. Blank: the first poll, remembered.")]
    public string? EnergySince { get; set; }
}
