namespace rPDU2MQTT.Models.Config;

/// <summary>
/// EmonCMS feed storage engines. The values are EmonCMS's own engine ids, passed straight to
/// <c>feed/create.json?engine=</c>.
/// </summary>
public enum EmonCmsFeedEngine
{
    MySQL = 0,
    PHPTimeSeries = 2,
    PHPFina = 5,
    VirtualFeed = 7,
}
