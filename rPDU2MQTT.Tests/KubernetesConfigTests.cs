using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services.Gui;
using rPDU2MQTT.Startup.ConfigSources;
using Xunit;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Tests;

public class KubernetesConfigTests
{
    [Fact]
    public void Schema_And_Json_ShareUnifiedVocabulary()
    {
        // The CR spec, GUI JSON, and YAML config must use the same field names.
        var schema = ConfigSchema.Build();
        Assert.Contains("HomeAssistant", schema.Select(n => n.Key));
        Assert.DoesNotContain("HASS", schema.Select(n => n.Key));

        var json = ConfigSchema.ToJson(new Config());
        Assert.Contains("\"HomeAssistant\"", json);
        Assert.Contains("\"Timeout\"", json);          // Connection.TimeoutSecs -> Timeout
        Assert.DoesNotContain("\"HASS\"", json);
    }

    [Fact]
    public void SpecRoundTrip_PreservesValuesAndTypes()
    {
        var cfg = new Config();
        cfg.MQTT.ParentTopic = "homelab";
        cfg.Pdus[Config.DefaultInstanceKey] = new PduConfig { PollInterval = 9 };
        cfg.Pdus[Config.DefaultInstanceKey].Connection.Port = 8080;
        cfg.HASS.DiscoveryEnabled = true;

        // Simulates the CR spec round-trip (write spec, then read it back).
        var specJson = ConfigSchema.ToJson(cfg);
        var back = ConfigSchema.FromJson(specJson);

        Assert.Equal("homelab", back.MQTT.ParentTopic);
        Assert.Equal(9, back.Primary.PollInterval);
        Assert.Equal(8080, back.Primary.Connection.Port);   // stays an int, not a string
        Assert.True(back.HASS.DiscoveryEnabled);
    }

    [Fact]
    public void RedactSecrets_RemovesCredentials()
    {
        var cfg = new Config();
        cfg.MQTT.Credentials = new() { Username = "u", Password = "p" };
        cfg.Pdus[Config.DefaultInstanceKey] = new PduConfig { Credentials = new() { Username = "hass", Password = "pw" } };
        cfg.EmonCMS.ApiKey = "key";
        cfg.Gui.Password = "guipass";

        var redacted = ConfigSchema.RedactSecrets(cfg);

        Assert.Null(redacted.MQTT.Credentials);
        Assert.Null(redacted.Primary.Credentials);
        Assert.Null(redacted.EmonCMS.ApiKey);
        Assert.Null(redacted.Gui.Password);
        // Original is untouched.
        Assert.NotNull(cfg.MQTT.Credentials);
    }

    [Fact]
    public void Crd_IsGeneratedWithSpecSchemaAndStatus()
    {
        var yaml = CrdGenerator.ToYaml();
        var crd = new DeserializerBuilder().Build().Deserialize<Dictionary<object, object>>(yaml);

        Assert.NotNull(crd);
        Assert.Equal("CustomResourceDefinition", crd["kind"]);
        Assert.Contains("rpduconfigs.rpdu2mqtt.xtremeownage.com", yaml);
        Assert.Contains("openAPIV3Schema", yaml);
        Assert.Contains("HomeAssistant", yaml);     // generated spec property
        Assert.Contains("status", yaml);            // status subresource
    }
}
