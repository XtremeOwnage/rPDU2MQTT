using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.Config.Schemas;
using rPDU2MQTT.Services.Gui;
using rPDU2MQTT.Startup;
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
        Assert.Contains("Pdus", keys);
        Assert.Contains("Gui", keys);
        Assert.All(schema, n => Assert.False(string.IsNullOrEmpty(n.Label)));
    }

    [Fact]
    public void EmonCmsFeedTypes_Json_DeserializesLegacyStringForm_AndObjectForm()
    {
        // v1 stored Types as bare strings; existing persisted config must still load (#163 rework).
        var legacy = ConfigSchema.FromJson("""{"EmonCMS":{"Feeds":{"Types":["realpower","energy"]}}}""");
        Assert.Equal(new[] { "realpower", "energy" }, legacy.EmonCMS.Feeds.Types.Select(t => t.Type));
        Assert.All(legacy.EmonCMS.Feeds.Types, t => Assert.Null(t.Engine));   // inherit the Feeds-level default

        var obj = ConfigSchema.FromJson("""{"EmonCMS":{"Feeds":{"Types":[{"Type":"energy","Daily":true,"IntervalSeconds":30}]}}}""");
        var only = Assert.Single(obj.EmonCMS.Feeds.Types);
        Assert.Equal("energy", only.Type);
        Assert.True(only.Daily);
        Assert.Equal(30, only.IntervalSeconds);
    }

    [Fact]
    public void EmonCmsFeedTypes_Yaml_DeserializesLegacyStringForm_AndObjectForm()
    {
        var legacy = rPDU2MQTT.Startup.YamlConfigLoader.DeserializeString(
            "EmonCMS:\n  Feeds:\n    Types:\n      - realpower\n      - energy\n");
        Assert.Equal(new[] { "realpower", "energy" }, legacy.EmonCMS.Feeds.Types.Select(t => t.Type));

        var obj = rPDU2MQTT.Startup.YamlConfigLoader.DeserializeString(
            "EmonCMS:\n  Feeds:\n    Types:\n      - Type: energy\n        Daily: true\n        IntervalSeconds: 30\n");
        var only = Assert.Single(obj.EmonCMS.Feeds.Types);
        Assert.Equal("energy", only.Type);
        Assert.True(only.Daily);
        Assert.Equal(30, only.IntervalSeconds);
    }

    [Fact]
    public void Build_ConnectionScheme_IsADropdownWithABlankChoice()
    {
        // Pdus (dictionary) -> PduConfig -> Connection -> Scheme should render as an enum (#176).
        var pdus = ConfigSchema.Build().Single(n => n.Key == "Pdus");
        var connection = pdus.ValueSchema!.Properties!.Single(n => n.Key == "Connection");
        var scheme = connection.Properties!.Single(n => n.Key == "Scheme");

        Assert.Equal("enum", scheme.Type);
        // Optional field: a leading blank keeps "unset" (auto scheme from the port) selectable.
        Assert.Equal(new[] { "", "http", "https" }, scheme.EnumValues);
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
    public void MqttLastWill_DefaultsTrue_AndRoundTrips()
    {
        Assert.True(new Config().MQTT.LastWill);

        var cfg = new Config();
        cfg.MQTT.LastWill = false;
        var back = ConfigSchema.FromJson(ConfigSchema.ToJson(cfg));
        Assert.False(back.MQTT.LastWill);

        var mqtt = ConfigSchema.Build().Single(n => n.Key == "MQTT");
        Assert.Contains("LastWill", mqtt.Properties!.Select(n => n.Key));
    }

    [Fact]
    public void EnergyFlow_SurvivesTheSaveThenReloadRoundTrip()
    {
        // The GUI saves a hierarchy edit and the app re-reads it live (config.EnergyFlow = source.Load()),
        // which only reflects the change if EnergyFlow survives the exact serialization path: the browser
        // posts JSON -> the endpoint parses it -> SaveAsync writes YAML -> Load() parses YAML back.
        var posted = new Config();
        posted.EnergyFlow.Nodes.Add(new EnergyFlowNode { Id = "gridboss", Label = "Grid Boss", Value = 1234 });
        posted.EnergyFlow.Links.Add(new EnergyFlowLink { From = "grid", To = "gridboss" });
        posted.EnergyFlow.Links.Add(new EnergyFlowLink { From = "gridboss", To = "main_panel" });

        var parsed = ConfigSchema.FromJson(ConfigSchema.ToJson(posted));   // browser -> endpoint
        var yaml = ConfigSchema.ToYaml(parsed);                            // endpoint -> disk (SaveAsync)
        var reloaded = YamlConfigLoader.DeserializeString(yaml);           // disk -> memory (Load)

        var node = Assert.Single(reloaded.EnergyFlow.Nodes);
        Assert.Equal("gridboss", node.Id);
        Assert.Equal("Grid Boss", node.Label);
        Assert.Equal(1234, node.Value);
        Assert.Equal(2, reloaded.EnergyFlow.Links.Count);
        Assert.Contains(reloaded.EnergyFlow.Links, l => l.From == "grid" && l.To == "gridboss");
        Assert.Contains(reloaded.EnergyFlow.Links, l => l.From == "gridboss" && l.To == "main_panel");
    }

    [Fact]
    public void Build_UsesFriendlyDisplayNamesAndHelpText()
    {
        // PDU settings now live under the Pdus instance map; the per-instance schema is its ValueSchema.
        var pdus = ConfigSchema.Build().Single(n => n.Key == "Pdus");
        var pdu = pdus.ValueSchema!;
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
    public void Build_MarksOidcClientSecretAsPassword()
    {
        var gui = ConfigSchema.Build().Single(n => n.Key == "Gui");
        var oidc = gui.Properties!.Single(n => n.Key == "Oidc");
        var secret = oidc.Properties!.Single(n => n.Key == "ClientSecret");
        Assert.Equal("password", secret.Type);
    }

    [Fact]
    public void RedactSecrets_ClearsOidcClientSecret()
    {
        var cfg = new Config();
        cfg.Gui.Oidc.ClientSecret = "shh";
        Assert.Null(ConfigSchema.RedactSecrets(cfg).Gui.Oidc.ClientSecret);
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
