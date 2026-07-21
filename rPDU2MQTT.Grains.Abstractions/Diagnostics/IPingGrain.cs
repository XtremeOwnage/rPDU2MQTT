namespace rPDU2MQTT.Grains.Abstractions.Diagnostics;

/// <summary>
/// A trivial grain that proves the silo is up and grains activate/place — used by the diagnostics endpoint
/// during the v3 bring-up. Keyed by an arbitrary string (use "self").
/// </summary>
public interface IPingGrain : IGrainWithStringKey
{
    /// <summary>Returns the silo identity that handled the call, so we can see placement working.</summary>
    Task<string> Ping();
}
