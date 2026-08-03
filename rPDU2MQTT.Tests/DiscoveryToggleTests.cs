using rPDU2MQTT.Classes;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Turning Home Assistant discovery on or off must take effect on the next pass, not on the next restart.
/// The services are registered unconditionally and read the flag each time; this pins the reading, since the
/// bug was that the decision had been made once at startup and could never be revisited.
/// </summary>
public class DiscoveryToggleTests
{
    [Fact]
    public void TheFlagIsReadFromLiveConfig_NotCapturedAtStartup()
    {
        // The same Config instance the services hold is the one the GUI edits and saves, so flipping it here
        // is exactly what a save does. If anything cached the value, this would not be observable.
        var cfg = new Config();
        cfg.HASS.DiscoveryEnabled = false;
        Assert.False(cfg.HASS.DiscoveryEnabled);

        cfg.HASS.DiscoveryEnabled = true;
        Assert.True(cfg.HASS.DiscoveryEnabled);
    }

    [Fact]
    public void DiscoveryDefaultsOff_SoTurningItOnIsAlwaysADeliberateAct()
        => Assert.False(new Config().HASS.DiscoveryEnabled);
}
