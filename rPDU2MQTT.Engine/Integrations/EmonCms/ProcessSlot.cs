namespace rPDU2MQTT.Integrations.EmonCms;

/// <summary>EmonCMS process keys for generated processlists, written as <c>key:feedid</c>.</summary>
public static class ProcessSlot
{
    /// <summary>Log to feed (1): feed-id arg; writes the value as given, passes it on unchanged.</summary>
    public const string LogToFeed = "process__log_to_feed";

    /// <summary>kWh to kWh/d (23): feed-id arg; reads cumulative kWh, writes the day's total, passes the input on; needs Redis.</summary>
    public const string KwhToKwhd = "process__kwh_to_kwhd";

    /// <summary>Source Feed (53): feed-id arg; yields that feed's latest value, as a virtual feed's first step.</summary>
    public const string SourceFeed = "process__source_feed_data_time";

    /// <summary>Power to kWh (4): feed-id arg; reads watts, writes cumulative kWh, passes the watts on unchanged.</summary>
    public const string PowerToKwh = "process__power_to_kwh";

    /// <summary>Power to kWh/d (5): feed-id arg; reads watts, writes the day's kWh, passes the watts on unchanged.</summary>
    public const string PowerToKwhd = "process__power_to_kwhd";

    /// <summary>kWh Accumulator (no id_num): feed-id arg; reads cumulative kWh, adds positive deltas to the feed's own total ignoring resets, passes that total on; needs Redis.</summary>
    public const string KwhAccumulator = "process__kwh_accumulator";

    /// <summary>kWh to Power (21): feed-id arg; reads cumulative kWh, writes watts, passes the watts on, so it is ordered last; needs Redis.</summary>
    public const string KwhToPower = "process__kwh_to_power";
}
