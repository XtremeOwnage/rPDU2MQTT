namespace rPDU2MQTT.Integrations.EmonCms;

/// <summary>
/// One EmonCMS feed as <c>/feed/list.json</c> describes it: enough to find it, read it, and know how old
/// the reading is.
/// </summary>
/// <param name="Id">Its numeric id, as a string — EmonCMS quotes it in some versions and not others.</param>
/// <param name="Name">The feed name, which is unique only within a tag.</param>
/// <param name="Tag">The group it is filed under. May be empty.</param>
/// <param name="Unit">The unit EmonCMS holds for it ("W", "kWh"), or empty when it holds none.</param>
/// <param name="Value">Its latest value, or null when the feed has never been written.</param>
/// <param name="AtUtc">When that value was recorded, or null when EmonCMS gave no timestamp.</param>
public sealed record EmonCmsFeed(string Id, string Name, string Tag, string Unit, double? Value, DateTime? AtUtc);
