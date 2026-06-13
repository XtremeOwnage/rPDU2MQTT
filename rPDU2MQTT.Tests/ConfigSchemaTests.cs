using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config.Schemas;
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
    public void Build_OverrideDevicesAndOutletsExposeMakeAndModel()
    {
        var overrides = ConfigSchema.Build().Single(n => n.Key == "Overrides");
        var deviceVal = overrides.Properties!.Single(n => n.Key == "Devices").ValueSchema!;
        Assert.Contains("Make", deviceVal.Properties!.Select(n => n.Key));
        Assert.Contains("Model", deviceVal.Properties!.Select(n => n.Key));

        var outletVal = deviceVal.Properties!.Single(n => n.Key == "Outlets").ValueSchema!;
        Assert.Contains("Make", outletVal.Properties!.Select(n => n.Key));
        Assert.Contains("Model", outletVal.Properties!.Select(n => n.Key));
    }

    [Fact]
    public void OverrideMakeModel_JsonRoundTrips()
    {
        var cfg = new Config();
        cfg.Overrides.Devices["DEV"] = new DeviceOverride { Outlets = { [1] = new EntityOverride { Make = "Dell", Model = "PowerEdge R730xd" } } };

        var back = ConfigSchema.FromJson(ConfigSchema.ToJson(cfg));
        var outlet = back.Overrides.Devices["DEV"]!.Outlets[1]!;

        Assert.Equal("Dell", outlet.Make);
        Assert.Equal("PowerEdge R730xd", outlet.Model);
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
