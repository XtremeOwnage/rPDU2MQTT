using rPDU2MQTT.Services.Gui;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>One Home Assistant URL and token, shared by everything that talks to its API.</summary>
public class HomeAssistantConnectionTests
{
    [Fact]
    public void TheEnergyDashboardsUrlAndToken_MoveToHomeAssistant()
    {
        var cfg = YamlConfigLoader.DeserializeString("""
            HomeAssistant:
              EnergyDashboard:
                Enabled: true
                Url: http://ha:8123
                Token: abc
            """);

        Assert.Equal("http://ha:8123", cfg.HASS.Url);
        Assert.Equal("abc", cfg.HASS.Token);
        Assert.Null(cfg.HASS.EnergyDashboard.LegacyUrl);
        Assert.Null(cfg.HASS.EnergyDashboard.LegacyToken);
        Assert.True(cfg.HASS.EnergyDashboard.Enabled);
    }

    [Fact]
    public void OnceMoved_TheOldKeysAreNotWrittenBack()
    {
        var cfg = YamlConfigLoader.DeserializeString("""
            HomeAssistant:
              EnergyDashboard:
                Url: http://ha:8123
            """);

        var yaml = ConfigSchema.ToYaml(cfg);
        var json = ConfigSchema.ToJson(cfg);

        Assert.Equal("http://ha:8123", YamlConfigLoader.DeserializeString(yaml).HASS.Url);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(yaml, "Url: http://ha:8123"));
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(json, "http://ha:8123"));
    }

    [Fact]
    public void ANewUrl_WinsOverTheOldOne()
    {
        var cfg = YamlConfigLoader.DeserializeString("""
            HomeAssistant:
              Url: http://new:8123
              EnergyDashboard:
                Url: http://old:8123
            """);

        Assert.Equal("http://new:8123", cfg.HASS.Url);
    }

    [Fact]
    public void AKubernetesSpecWithTheOldKeys_IsMovedToo()
    {
        var cfg = YamlConfigLoader.Initialize(ConfigSchema.FromJson(
            """{ "HomeAssistant": { "EnergyDashboard": { "Url": "http://ha:8123", "Token": "abc" } } }"""));

        Assert.Equal("http://ha:8123", cfg.HASS.Url);
        Assert.Equal("abc", cfg.HASS.Token);
    }

    [Fact]
    public void TheGuiShowsTheUrlAndToken_OnlyOnHomeAssistant()
    {
        var ha = ConfigSchema.Build().Single(n => n.Key == "HomeAssistant");

        Assert.Contains(ha.Properties!, p => p.Key == "Url");
        Assert.Equal("password", ha.Properties!.Single(p => p.Key == "Token").Type);
        var dashboard = ha.Properties!.Single(p => p.Key == "EnergyDashboard");
        Assert.DoesNotContain(dashboard.Properties!, p => p.Key is "Url" or "Token");
    }
}
