using System.Text.Json.Serialization;

namespace rPDU2MQTT.Models.PDU.OneView;

/// <summary>
/// Per-outlet group assignment exposed by OneView under each host's <c>groupMap</c>:
/// <c>groupMap.dev.&lt;deviceSerial&gt;.outlet.&lt;index&gt;.group</c> = the group key that outlet
/// belongs to (null when unassigned). This is how a OneView group's member outlets are resolved.
/// </summary>
public class OneViewGroupMap
{
    [JsonPropertyName("dev")]
    public Dictionary<string, OneViewGroupMapDevice>? Dev { get; set; }
}

public class OneViewGroupMapDevice
{
    [JsonPropertyName("outlet")]
    public Dictionary<string, OneViewGroupMapOutlet>? Outlet { get; set; }
}

public class OneViewGroupMapOutlet
{
    [JsonPropertyName("group")]
    public string? Group { get; set; }
}
