using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>v2 multi-PDU config: Pdus is the instance map; Primary resolves the GUI/cross-cutting instance.</summary>
public class MultiPduConfigTests
{
    [Fact]
    public void Initialize_SeedsADefaultInstanceWhenEmpty()
    {
        var result = YamlConfigLoader.Initialize(new Config());

        Assert.True(result.Pdus.ContainsKey(Config.DefaultInstanceKey));
        Assert.Same(result.Pdus[Config.DefaultInstanceKey], result.Primary);
    }

    [Fact]
    public void Initialize_PreservesConfiguredInstances()
    {
        var cfg = new Config();
        cfg.Pdus["b"] = new PduConfig();
        cfg.Pdus["b"].Connection.Host = "pdu-b.example.com";

        var result = YamlConfigLoader.Initialize(cfg);

        Assert.True(result.Pdus.ContainsKey("b"));
        Assert.False(result.Pdus.ContainsKey(Config.DefaultInstanceKey));
    }

    [Fact]
    public void Primary_PrefersTheDefaultKeyThenFirst()
    {
        var cfg = new Config();
        cfg.Pdus["a"] = new PduConfig { PollInterval = 3 };
        cfg.Pdus[Config.DefaultInstanceKey] = new PduConfig { PollInterval = 7 };
        Assert.Equal(7, cfg.Primary.PollInterval);

        var single = new Config();
        single.Pdus["only"] = new PduConfig { PollInterval = 9 };
        Assert.Equal(9, single.Primary.PollInterval);
    }

    [Fact]
    public void EnableActionsAlias_AppliesPerInstance()
    {
        var cfg = new Config();
        cfg.Pdus[Config.DefaultInstanceKey] = new PduConfig { EnableActionsAlias = true };

        var result = YamlConfigLoader.Initialize(cfg);

        Assert.True(result.Primary.ActionsEnabled);
    }

    [Fact]
    public void Initialize_MigratesDeprecatedPduSectionToDefaultInstance()
    {
        var cfg = new Config { PDU = new PduConfig { PollInterval = 7 } };
        cfg.PDU.Connection.Host = "rack-pdu-1.example.com";

        var result = YamlConfigLoader.Initialize(cfg);

        var migrated = Assert.Contains(Config.DefaultInstanceKey, result.Pdus);
        Assert.Equal("rack-pdu-1.example.com", migrated.Connection.Host);
        Assert.Equal(7, migrated.PollInterval);
        Assert.Same(migrated, result.Primary);
        Assert.Null(result.PDU); // cleared so it never round-trips
    }

    [Fact]
    public void Registry_SkipsInstancesMissingHost_AndKeepsValidOnes()
    {
        var cfg = new Config();
        cfg.Pdus["default"] = new PduConfig(); cfg.Pdus["default"].Connection.Host = "10.0.0.1";
        cfg.Pdus["new"] = new PduConfig(); // no Host — a half-configured GUI addition

        var registry = new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg));

        Assert.True(registry.All.ContainsKey("default"));
        Assert.False(registry.All.ContainsKey("new"));
        // An unknown/skipped instance resolves to the primary instead of throwing.
        Assert.Same(registry.Primary, registry.Get("new"));
    }

    [Fact]
    public void Registry_ThrowsWhenNoInstanceHasAHost()
    {
        var cfg = new Config();
        cfg.Pdus["a"] = new PduConfig(); // no Host
        cfg.Pdus["b"] = new PduConfig(); // no Host

        Assert.Throws<Exception>(() => new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg)));
    }

    [Fact]
    public void Initialize_PrefersPdusOverDeprecatedPduWhenBothPresent()
    {
        var cfg = new Config { PDU = new PduConfig() };
        cfg.PDU.Connection.Host = "legacy.example.com";
        cfg.Pdus["a"] = new PduConfig();
        cfg.Pdus["a"].Connection.Host = "explicit.example.com";

        var result = YamlConfigLoader.Initialize(cfg);

        Assert.False(result.Pdus.ContainsKey(Config.DefaultInstanceKey));
        Assert.Equal("explicit.example.com", result.Pdus["a"].Connection.Host);
        Assert.Null(result.PDU);
    }
}
