﻿using rPDU2MQTT.Models.HomeAssistant;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Extensions;
public static class RootData_Extensiosn
{
    /// <summary>
    /// Returns Discovery Device for RootData.
    /// </summary>
    /// <param name="data"></param>
    /// <param name="DeviceURL"></param>
    /// <returns></returns>
    public static DiscoveryDevice GetDiscoveryDevice(this RootData data, string DeviceURL)
    {
        return new DiscoveryDevice
        {
            ConfigurationUrl = DeviceURL,
            HardwareVersion = data.Sys.Version,
            Manufacturer = data.Sys.Oem,
            UniqueIdentifier = data.Entity_Identifier,
            Model = data.Sys.ModelNumber,
            SerialNumber = data.Sys.SerialNumber,
            SoftwareVersion = data.Sys.AppVersion,
            Name = data.Sys.Label ?? data.Sys.Name,
        };
    }
}
