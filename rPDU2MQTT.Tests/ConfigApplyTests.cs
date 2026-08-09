using System.Reflection;
using System.Text.Json.Serialization;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Which saved settings this process is actually running.
///
/// <para>
/// Saving writes the whole document, but a running process can only pick up the part something re-reads.
/// The gap used to be silent: the History feature was switched on, saved, and the test button went on
/// reporting it as off, because nothing copied the saved value into the running configuration and nothing
/// said a restart was needed.
/// </para>
/// </summary>
public class ConfigApplyTests
{
    private static Config Fresh() => new();

    [Fact]
    public void TurningHistoryOnNeedsNoRestart()
    {
        // The bug this exists for. The router reads History per call, so the only thing missing was saying
        // so — and copying it in.
        var saved = Fresh();
        saved.History.Enabled = true;
        saved.History.PrometheusUrl = "http://prometheus:9090";

        Assert.Empty(ConfigApply.NeedingRestart(Fresh(), saved));
    }

    [Fact]
    public void ABrokerChangeNeedsARestart()
    {
        var saved = Fresh();
        saved.MQTT.Connection.Host = "broker.example.test";

        Assert.Equal(["MQTT.Connection.Host"], ConfigApply.NeedingRestart(Fresh(), saved));
    }

    [Fact]
    public void OnlyThePartOfASectionThatIsLiveCounts()
    {
        // HomeAssistant is half and half: the Energy Dashboard settings are re-read, discovery is not.
        var saved = Fresh();
        saved.HASS.EnergyDashboard.Url = "http://ha:8123";
        saved.HASS.DiscoveryEnabled = !Fresh().HASS.DiscoveryEnabled;

        var stranded = ConfigApply.NeedingRestart(Fresh(), saved);

        Assert.Equal(["HomeAssistant.DiscoveryEnabled"], stranded);
    }

    [Fact]
    public void SavingWhatIsAlreadyRunningStrandsNothing()
    {
        Assert.Empty(ConfigApply.NeedingRestart(Fresh(), Fresh()));
    }

    [Fact]
    public void PuttingASettingBackClearsIt()
    {
        // Recomputed against what the process is running, not accumulated: changing a value and changing it
        // back must not leave a restart hanging over nothing.
        var running = Fresh();
        var saved = Fresh();
        saved.MQTT.Connection.Host = "broker.example.test";
        Assert.NotEmpty(ConfigApply.NeedingRestart(running, saved));

        saved.MQTT.Connection.Host = running.MQTT.Connection.Host;
        Assert.Empty(ConfigApply.NeedingRestart(running, saved));
    }

    [Fact]
    public void EveryLiveAppliedPathNamesARealSetting()
    {
        // A typo here would silently claim that nothing is applied live — every change would demand a
        // restart, and the list would look right while meaning nothing.
        foreach (var path in ConfigApply.AppliedLive)
        {
            var type = typeof(Config);
            foreach (var part in path.Split('.'))
            {
                var prop = type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
                    .FirstOrDefault(p => (p.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? p.Name) == part);
                Assert.True(prop is not null, $"ConfigApply.AppliedLive names '{path}', but '{part}' is not a setting on {type.Name}.");
                type = prop!.PropertyType;
            }
        }
    }

    [Fact]
    public void ADeeperChangeIsNamedByItsWholePath()
    {
        var saved = Fresh();
        saved.Gui.Port = 9999;

        Assert.Equal(["Gui.Port"], ConfigApply.NeedingRestart(Fresh(), saved));
    }
}
