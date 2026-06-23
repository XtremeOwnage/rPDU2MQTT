using rPDU2MQTT.Classes;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>v2 multi-PDU config groundwork: a v1 single-PDU config migrates into the Pdus instance map.</summary>
public class MultiPduConfigTests
{
    [Fact]
    public void Initialize_DerivesSingleInstanceFromPdu()
    {
        var cfg = new Config();
        cfg.PDU.Connection.Host = "rack-pdu-1.example.com";
        cfg.PDU.PollInterval = 7;

        var result = YamlConfigLoader.Initialize(cfg);

        var instance = Assert.Contains(Config.DefaultInstanceKey, result.Pdus);
        Assert.Same(result.PDU, instance);
        Assert.Equal("rack-pdu-1.example.com", instance.Connection.Host);
        Assert.Equal(7, instance.PollInterval);
    }

    [Fact]
    public void Initialize_PreservesAnAlreadyPopulatedInstanceMap()
    {
        var cfg = new Config();
        var custom = new Models.Config.PduConfig();
        custom.Connection.Host = "pdu-b.example.com";
        cfg.Pdus = new() { ["b"] = custom };

        var result = YamlConfigLoader.Initialize(cfg);

        Assert.True(result.Pdus.ContainsKey("b"));
        Assert.False(result.Pdus.ContainsKey(Config.DefaultInstanceKey));
    }
}
