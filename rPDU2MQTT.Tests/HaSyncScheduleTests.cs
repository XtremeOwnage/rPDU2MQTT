using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Plugin.Locations;
using Xunit;

namespace rPDU2MQTT.Tests;

public class HaSyncScheduleTests
{
    private static Config With(string schedule, int minutes = 60)
    {
        var cfg = new Config();
        cfg.HASS.Url = "http://ha:8123";
        cfg.HASS.Token = "t";
        cfg.Plugins["locations"] = PluginConfigBinder.ToNode(new LocationSettings { HomeAssistant = new() { Schedule = schedule, IntervalMinutes = minutes } });
        return cfg;
    }

    private static HaSyncRunner Runner() => new(() => throw new InvalidOperationException(), () => new Config(), new SoleOwnerLease());

    [Fact]
    public void Manual_IsNeverDue()
    {
        Assert.False(Runner().Due(With(HaSyncMode.Manual), DateTime.UtcNow));
    }

    [Fact]
    public void Interval_IsDueOncePerInterval()
    {
        var r = Runner();
        var cfg = With(HaSyncMode.Interval, 10);
        var t = DateTime.UtcNow;
        Assert.True(r.Due(cfg, t));
        Assert.False(r.Due(cfg, t.AddMinutes(9)));
        Assert.True(r.Due(cfg, t.AddMinutes(10)));
    }

    [Fact]
    public void OnChange_IsDueWhenTheConfigChanges()
    {
        var r = Runner();
        var cfg = With(HaSyncMode.OnChange);
        Assert.True(r.Due(cfg, DateTime.UtcNow));
        Assert.False(r.Due(cfg, DateTime.UtcNow));
        cfg.EnergyFlow.Nodes.Add(new() { Id = "new" });
        Assert.True(r.Due(cfg, DateTime.UtcNow));
    }

    [Fact]
    public void WithoutAUrlAndToken_NothingIsDue()
    {
        var cfg = With(HaSyncMode.Interval);
        cfg.HASS.Token = "";
        Assert.False(Runner().Due(cfg, DateTime.UtcNow));
    }
}
