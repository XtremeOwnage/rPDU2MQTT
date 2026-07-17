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

/// <summary>Runtime reconcile planner (phase 5): what to start/stop when Config.Pdus changes.</summary>
public class InstanceReconcileTests
{
    private static PduConfig Pdu(string host, int poll = 5)
    {
        var c = new PduConfig { PollInterval = poll };
        c.Connection.Host = host;
        return c;
    }

    [Fact]
    public void Plan_StartsAddedInstances()
    {
        var running = new Dictionary<string, string> { ["default"] = InstanceReconcile.Signature(Pdu("a")) };
        var desired = new Dictionary<string, PduConfig> { ["default"] = Pdu("a"), ["b"] = Pdu("b") };

        var (toStop, toStart, primaryChanged) = InstanceReconcile.Plan(running, desired, "default");

        Assert.Equal(new[] { "b" }, toStart);
        Assert.Empty(toStop);
        Assert.False(primaryChanged);
    }

    [Fact]
    public void Plan_StopsRemovedInstances()
    {
        var running = new Dictionary<string, string>
        {
            ["default"] = InstanceReconcile.Signature(Pdu("a")),
            ["b"] = InstanceReconcile.Signature(Pdu("b")),
        };
        var desired = new Dictionary<string, PduConfig> { ["default"] = Pdu("a") };

        var (toStop, toStart, _) = InstanceReconcile.Plan(running, desired, "default");

        Assert.Equal(new[] { "b" }, toStop);
        Assert.Empty(toStart);
    }

    [Fact]
    public void Plan_RebuildsChangedNonPrimary()
    {
        var running = new Dictionary<string, string>
        {
            ["default"] = InstanceReconcile.Signature(Pdu("a")),
            ["b"] = InstanceReconcile.Signature(Pdu("b1")),
        };
        var desired = new Dictionary<string, PduConfig> { ["default"] = Pdu("a"), ["b"] = Pdu("b2") };

        var (toStop, toStart, _) = InstanceReconcile.Plan(running, desired, "default");

        Assert.Contains("b", toStop);
        Assert.Contains("b", toStart);
    }

    [Fact]
    public void Plan_PrimaryConnectionChange_FlagsRestart_AndIsNotStopped()
    {
        var running = new Dictionary<string, string> { ["default"] = InstanceReconcile.Signature(Pdu("a1")) };
        var desired = new Dictionary<string, PduConfig> { ["default"] = Pdu("a2") };

        var (toStop, toStart, primaryChanged) = InstanceReconcile.Plan(running, desired, "default");

        Assert.True(primaryChanged);
        Assert.Empty(toStop);
        Assert.Empty(toStart);
    }

    [Fact]
    public void Plan_IgnoresHostlessDesiredInstances()
    {
        var running = new Dictionary<string, string> { ["default"] = InstanceReconcile.Signature(Pdu("a")) };
        var desired = new Dictionary<string, PduConfig> { ["default"] = Pdu("a"), ["b"] = new PduConfig() }; // b has no host

        var (toStop, toStart, _) = InstanceReconcile.Plan(running, desired, "default");

        Assert.Empty(toStart);
        Assert.Empty(toStop);
    }
}

/// <summary>Registry runtime add/remove (phase 5), keeping the primary fixed.</summary>
public class PduInstanceRegistryRuntimeTests
{
    private static PduConfig Pdu(string host) { var c = new PduConfig(); c.Connection.Host = host; return c; }

    private static PduInstanceRegistry Registry()
    {
        var cfg = new Config();
        cfg.Pdus["default"] = Pdu("10.0.0.1");
        return new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg));
    }

    [Fact]
    public void TryCreate_AddsAnInstance_AndRemoveDropsNonPrimary()
    {
        var registry = Registry();

        Assert.NotNull(registry.TryCreate("b", Pdu("10.0.0.2")));
        Assert.True(registry.All.ContainsKey("b"));
        Assert.NotSame(registry.Primary, registry.Get("b"));

        Assert.True(registry.Remove("b"));
        Assert.False(registry.All.ContainsKey("b"));
    }

    [Fact]
    public void Remove_RefusesToRemoveThePrimary()
    {
        var registry = Registry();
        Assert.False(registry.Remove(registry.PrimaryId));
        Assert.True(registry.All.ContainsKey(registry.PrimaryId));
    }

    [Fact]
    public void TryCreate_SkipsHostlessInstance()
    {
        var registry = Registry();
        Assert.Null(registry.TryCreate("b", new PduConfig())); // no host
        Assert.False(registry.All.ContainsKey("b"));
    }
}

/// <summary>
/// Re-pointing the primary instance in place (#192). Its PDU object is the DI singleton the GUI, control
/// and discovery hold, so it must keep its identity while its connection changes underneath.
/// </summary>
public class PrimaryRepointTests
{
    private static Config Cfg(string host, int? port = null, string? scheme = null)
    {
        var c = new Config();
        c.Pdus["default"] = new PduConfig { PollInterval = 5 };
        c.Pdus["default"].Connection.Host = host;
        c.Pdus["default"].Connection.Port = port;
        c.Pdus["default"].Connection.Scheme = scheme;
        return c;
    }

    [Fact]
    public void RepointPrimary_KeepsTheSameObject_ButChangesTheTarget()
    {
        var cfg = Cfg("pdu-a.example.com");
        var registry = new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg));
        var before = registry.Primary;
        Assert.Contains("pdu-a.example.com", before.BaseAddress);

        var moved = Cfg("pdu-b.example.com", 443, "https");
        Assert.True(registry.RepointPrimary(moved.Pdus["default"]));

        // Same instance — every existing reference (GUI/control/discovery) must stay valid.
        Assert.Same(before, registry.Primary);
        Assert.Contains("pdu-b.example.com", registry.Primary.BaseAddress);
        Assert.StartsWith("https://", registry.Primary.BaseAddress);
    }

    [Fact]
    public void RepointPrimary_IsRefused_WhenTheNewConfigHasNoHost()
    {
        var cfg = Cfg("pdu-a.example.com");
        var registry = new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg));

        var hostless = new PduConfig { PollInterval = 5 };

        Assert.False(registry.RepointPrimary(hostless));
        // Left pointed at the previous device rather than broken.
        Assert.Contains("pdu-a.example.com", registry.Primary.BaseAddress);
    }

    [Fact]
    public void Repoint_IsIdempotentAndRepeatable()
    {
        var cfg = Cfg("pdu-a.example.com");
        var registry = new PduInstanceRegistry(cfg, new PduInstanceFactory(cfg));
        var pdu = registry.Primary;

        // Repeated re-points must not leave the PDU wedged (the old HttpClient is disposed each time;
        // using a disposed client would throw here).
        for (var i = 0; i < 3; i++)
        {
            Assert.True(registry.RepointPrimary(Cfg($"pdu-{i}.example.com").Pdus["default"]));
            Assert.Contains($"pdu-{i}.example.com", pdu.BaseAddress);
        }

        Assert.Same(pdu, registry.Primary);
    }
}
