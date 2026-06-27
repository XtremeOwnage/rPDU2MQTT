namespace rPDU2MQTT.Models.Config;

/// <summary>How measurements are delivered to EmonCMS.</summary>
public enum EmonCmsTransport
{
    /// <summary>POST to the EmonCMS <c>input/post</c> HTTP API (default).</summary>
    Http,

    /// <summary>Publish to EmonCMS's MQTT input (the broker rPDU2MQTT already connects to).</summary>
    Mqtt,
}
