using rPDU2MQTT.Models.PDU.OneView;

namespace rPDU2MQTT.Models.PDU;

public class PduData
{
    public List<Device> Devices { get; init; } = new();
    public List<OneViewGroup> Groups { get; init; } = new();
    public rPDU[] PDUs { get; init; } = [];
}
