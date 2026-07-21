using rPDU2MQTT.Classes;
using rPDU2MQTT.Core;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// #214: paste a section from one instance's export into another. Merge applies only what the paste
/// mentions; Replace makes the paste the whole configuration.
/// </summary>
public class ConfigImportTests
{
    private static Config Current()
    {
        var cfg = new Config();
        cfg.MQTT.ParentTopic = "prod";
        cfg.MQTT.Connection.Host = "prod-broker";
        cfg.MQTT.KeepAlive = 90;
        cfg.Prometheus.Exporter = true;
        cfg.Prometheus.Port = 9999;
        cfg.EnergyFlow.MqttExport = true;
        cfg.EnergyFlow.Nodes.Add(new rPDU2MQTT.Models.Config.EnergyFlowNode { Id = "prod-total", Label = "Total" });
        return cfg;
    }

    [Fact]
    public void Merge_AppliesOnlyWhatThePasteMentions()
    {
        var result = ConfigImport.Apply(Current(), """
            EnergyFlow:
              Nodes:
                - Id: solar
                  Label: Solar
            """, ConfigImportMode.Merge);

        // The pasted section is applied...
        Assert.Equal("solar", Assert.Single(result.Config.EnergyFlow.Nodes).Id);
        Assert.Equal(new[] { "EnergyFlow" }, result.Sections);

        // ...and nothing else moved — including the sibling key inside the very section that was touched,
        // which is the part a naive "deserialize and overwrite" gets wrong (MqttExport would go back to
        // false, because that's the default the paste never mentioned).
        Assert.True(result.Config.EnergyFlow.MqttExport);
        Assert.Equal("prod", result.Config.MQTT.ParentTopic);
        Assert.Equal("prod-broker", result.Config.MQTT.Connection.Host);
        Assert.True(result.Config.Prometheus.Exporter);
        Assert.Equal(9999, result.Config.Prometheus.Port);
    }

    [Fact]
    public void Merge_ReachesNestedKeys_WithoutResettingTheirSiblings()
    {
        var result = ConfigImport.Apply(Current(), """
            Mqtt:
              Connection:
                Host: dev-broker
            """, ConfigImportMode.Merge);

        Assert.Equal("dev-broker", result.Config.MQTT.Connection.Host);
        Assert.Equal("prod", result.Config.MQTT.ParentTopic);   // sibling of Connection
        Assert.Equal(90, result.Config.MQTT.KeepAlive);         // sibling of Host, one level down
    }

    [Fact]
    public void Replace_MakesThePasteTheWholeConfiguration()
    {
        var result = ConfigImport.Apply(Current(), """
            EnergyFlow:
              Nodes:
                - Id: solar
                  Label: Solar
            """, ConfigImportMode.Replace);

        Assert.Equal("solar", Assert.Single(result.Config.EnergyFlow.Nodes).Id);

        // Everything the paste didn't mention goes back to its default — that's what "full replacement" means.
        Assert.False(result.Config.EnergyFlow.MqttExport);
        Assert.Equal("rPDU2MQTT", result.Config.MQTT.ParentTopic);
        Assert.False(result.Config.Prometheus.Exporter);
    }

    [Fact]
    public void A_List_IsOneValue()
    {
        var current = Current();
        current.EnergyFlow.Links.Add(new rPDU2MQTT.Models.Config.EnergyFlowLink { From = "a", To = "b" });

        var result = ConfigImport.Apply(current, """
            EnergyFlow:
              Links:
                - From: solar
                  To: inverter
            """, ConfigImportMode.Merge);

        // Half-merging two wiring lists would produce a topology neither side asked for.
        var link = Assert.Single(result.Config.EnergyFlow.Links);
        Assert.Equal("solar", link.From);

        // ...and the nodes list, which the paste didn't mention, is untouched.
        Assert.Equal("prod-total", Assert.Single(result.Config.EnergyFlow.Nodes).Id);
    }

    [Fact]
    public void A_KubernetesManifest_IsUnwrapped()
    {
        var result = ConfigImport.Apply(Current(), """
            apiVersion: rpdu2mqtt.xtremeownage.com/v1
            kind: RpduConfig
            metadata:
              name: rpdu2mqtt
            spec:
              Mqtt:
                ParentTopic: from-cluster
            """, ConfigImportMode.Merge);

        Assert.Equal("from-cluster", result.Config.MQTT.ParentTopic);
        Assert.Equal(new[] { "MQTT" }, result.Sections);
        Assert.Contains(result.Notes, n => n.Contains("RpduConfig"));

        // The manifest's own keys aren't config sections and mustn't be reported as ones.
        Assert.DoesNotContain("kind", result.Sections);
    }

    [Fact]
    public void Aliases_And_Casing_AreAccepted()
    {
        // The export writes "HomeAssistant"; the model calls the property HASS.
        var result = ConfigImport.Apply(Current(), """
            HomeAssistant:
              DiscoveryEnabled: true
            prometheus:
              Port: 1234
            """, ConfigImportMode.Merge);

        Assert.True(result.Config.HASS.DiscoveryEnabled);
        Assert.Equal(1234, result.Config.Prometheus.Port);
        Assert.True(result.Config.Prometheus.Exporter);   // its sibling survived
        Assert.Equal(new[] { "HomeAssistant", "Prometheus" }, result.Sections);   // reported as the config file names it
    }

    [Fact]
    public void Rubbish_IsRefused_WithSomethingToActOn()
    {
        Assert.Throws<ArgumentException>(() => ConfigImport.Apply(Current(), "", ConfigImportMode.Merge));
        Assert.Throws<ArgumentException>(() => ConfigImport.Apply(Current(), "just a string", ConfigImportMode.Merge));

        // Valid YAML, but nothing in it is part of the configuration.
        var ex = Assert.Throws<ArgumentException>(() => ConfigImport.Apply(Current(), "Nonsense:\n  Foo: 1", ConfigImportMode.Merge));
        Assert.Contains("match the configuration model", ex.Message);
    }
}
