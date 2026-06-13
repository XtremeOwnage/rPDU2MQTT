using rPDU2MQTT.Classes;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

public class ConfigSchemaTests
{
    [Fact]
    public void Build_ProducesTopLevelSections()
    {
        var schema = ConfigSchema.Build();
        var keys = schema.Select(n => n.Key).ToHashSet();

        Assert.Contains("MQTT", keys);
        Assert.Contains("PDU", keys);
        Assert.Contains("Gui", keys);
        Assert.All(schema, n => Assert.False(string.IsNullOrEmpty(n.Label)));
    }

    [Fact]
    public void Build_UsesFriendlyDisplayNamesAndHelpText()
    {
        var pdu = ConfigSchema.Build().Single(n => n.Key == "PDU");
        var actions = pdu.Properties!.Single(n => n.Key == "ActionsEnabled");

        // Key stays the config field; Label is the friendly GUI title from [Display(Name)].
        Assert.Equal("Enable Write Actions", actions.Label);
        Assert.False(string.IsNullOrWhiteSpace(actions.Description));
        Assert.All(pdu.Properties!, p => Assert.False(string.IsNullOrWhiteSpace(p.Description)));
    }

    [Fact]
    public void Build_ClassifiesScalarTypes()
    {
        var mqtt = ConfigSchema.Build().Single(n => n.Key == "MQTT");
        Assert.Equal("object", mqtt.Type);

        var keepAlive = mqtt.Properties!.Single(n => n.Key == "KeepAlive");
        Assert.Equal("int", keepAlive.Type);

        var parentTopic = mqtt.Properties!.Single(n => n.Key == "ParentTopic");
        Assert.Equal("string", parentTopic.Type);
        Assert.True(parentTopic.Required);
    }

    [Fact]
    public void Build_MarksPasswordFields()
    {
        var gui = ConfigSchema.Build().Single(n => n.Key == "Gui");
        var password = gui.Properties!.Single(n => n.Key == "Password");
        Assert.Equal("password", password.Type);
    }

    [Fact]
    public void Build_TreatsOverridesDevicesAsDictionary()
    {
        var overrides = ConfigSchema.Build().Single(n => n.Key == "Overrides");
        var devices = overrides.Properties!.Single(n => n.Key == "Devices");
        Assert.Equal("dictionary", devices.Type);
        Assert.NotNull(devices.ValueSchema);
        Assert.Equal("object", devices.ValueSchema!.Type);
    }

    [Fact]
    public void JsonRoundTrip_PreservesValues()
    {
        var cfg = new Config();
        cfg.MQTT.ParentTopic = "homelab";
        cfg.MQTT.KeepAlive = 90;
        cfg.Gui.Enabled = true;
        cfg.Gui.Port = 9090;

        var json = ConfigSchema.ToJson(cfg);
        var back = ConfigSchema.FromJson(json);

        Assert.Equal("homelab", back.MQTT.ParentTopic);
        Assert.Equal(90, back.MQTT.KeepAlive);
        Assert.True(back.Gui.Enabled);
        Assert.Equal(9090, back.Gui.Port);
    }

    [Fact]
    public void ToYaml_EmitsAliasedKeys()
    {
        var cfg = new Config();
        cfg.MQTT.ParentTopic = "homelab";

        var yaml = ConfigSchema.ToYaml(cfg);

        // YAML uses the model's aliases (e.g. HomeAssistant, not HASS).
        Assert.Contains("MQTT:", yaml);
        Assert.Contains("HomeAssistant:", yaml);
        Assert.Contains("homelab", yaml);
    }
}
