using rPDU2MQTT.Models.HomeAssistant;
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
    public static DiscoveryDevice GetDiscoveryDevice(this rPDU data)
    {
        return new DiscoveryDevice
        {
            ConfigurationUrl = data.URL,
            HardwareVersion = data.Sys.Version,
            Manufacturer = data.Sys.Oem,
            UniqueIdentifier = data.Entity_Identifier,
            Model = data.Sys.ModelNumber,
            SerialNumber = data.Sys.SerialNumber,
            SoftwareVersion = data.Sys.AppVersion,
            Name = data.Entity_DisplayName,
            Connections = BuildConnections(data),
        };
    }

    /// <summary>Home Assistant device connections (MAC + IPv4) from the PDU's ethernet config.</summary>
    private static List<string[]>? BuildConnections(rPDU data)
    {
        var ethernet = data.Conf?.Network?.Ethernet;
        var connections = new List<string[]>();

        var mac = ethernet?.MacAddr;
        if (!string.IsNullOrWhiteSpace(mac))
            connections.Add(["mac", mac]);

        var ip = ethernet?.Address?.The1?.Address;
        if (!string.IsNullOrWhiteSpace(ip))
            connections.Add(["ip", ip]);

        return connections.Count > 0 ? connections : null;
    }
}
