using System.Text.Json;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.Config.Schemas;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.OneView;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Secret redaction completeness (guards the k8s companion-Secret feature).</summary>
public class SecretRedactionTests
{
    [Fact]
    public void RedactSecrets_ClearsEverySecretField()
    {
        var cfg = new Config();
        cfg.MQTT.Credentials = new Credentials { Username = "mqttUser", Password = "mqttPass" };
        cfg.Pdus[Config.DefaultInstanceKey] = new Models.Config.PduConfig { Credentials = new Credentials { Username = "pduUser", Password = "pduPass" } };
        cfg.EmonCMS.ApiKey = "emonKey";
        cfg.Gui.Password = "guiPass";
        cfg.Gui.Oidc.ClientSecret = "oidcSecret";

        var redacted = ConfigSchema.RedactSecrets(cfg);

        Assert.Null(redacted.MQTT.Credentials);
        Assert.Null(redacted.Primary.Credentials);
        Assert.Null(redacted.EmonCMS.ApiKey);
        Assert.Null(redacted.Gui.Password);
        Assert.Null(redacted.Gui.Oidc?.ClientSecret);
    }

    [Fact]
    public void RedactSecrets_DoesNotMutateTheOriginal()
    {
        var cfg = new Config();
        cfg.Gui.Oidc.ClientSecret = "keep-me";
        cfg.MQTT.Credentials = new Credentials { Password = "keep-me" };

        _ = ConfigSchema.RedactSecrets(cfg);

        Assert.Equal("keep-me", cfg.Gui.Oidc.ClientSecret);
        Assert.Equal("keep-me", cfg.MQTT.Credentials!.Password);
    }
}

/// <summary>EmonCMS transport + templating config survives the JSON/YAML round-trips the GUI/CRD use.</summary>
public class EmonCmsConfigTests
{
    [Fact]
    public void TransportAndTemplate_JsonRoundTrips()
    {
        var cfg = new Config();
        cfg.EmonCMS.Enabled = true;
        cfg.EmonCMS.Transport = EmonCmsTransport.Mqtt;
        cfg.EmonCMS.InputNameTemplate = "{name}_{number}_{type}";
        cfg.EmonCMS.MqttBaseTopic = "emon";

        var round = ConfigSchema.FromJson(ConfigSchema.ToJson(cfg));

        Assert.Equal(EmonCmsTransport.Mqtt, round.EmonCMS.Transport);
        Assert.Equal("{name}_{number}_{type}", round.EmonCMS.InputNameTemplate);
        Assert.Equal("emon", round.EmonCMS.MqttBaseTopic);
    }

    [Fact]
    public void Transport_DefaultsToHttp()
        => Assert.Equal(EmonCmsTransport.Http, new Config().EmonCMS.Transport);
}

/// <summary>PDU JSON → model mapping (the dictionary-to-list + string-to-number converters).</summary>
public class PduMappingTests
{
    [Fact]
    public void OutletDictionary_DeserializesToListWithKeys()
    {
        const string json = """
        { "outlet": { "0": { "label": "first" }, "1": { "label": "second" } } }
        """;

        var dev = JsonSerializer.Deserialize<Device>(json, Converter.Settings);

        Assert.NotNull(dev);
        Assert.Equal(2, dev!.Outlets.Count);
        Assert.Contains(dev.Outlets, o => o.Key == 0 && o.Label == "first");
        Assert.Contains(dev.Outlets, o => o.Key == 1 && o.Label == "second");
    }

    [Fact]
    public void LifetimeEnergy_ParsesFromStringToLong()
    {
        var dev = JsonSerializer.Deserialize<Device>("""{ "lifetimeEnergy": "12345" }""", Converter.Settings);

        Assert.NotNull(dev);
        Assert.Equal(12345L, dev!.LifetimeEnergy);
    }
}

/// <summary>Group member resolution from the OneView per-outlet group map (the group-control core).</summary>
public class GroupMemberResolutionTests
{
    private static OneViewHost Host(string serial, params (string index, string group)[] outlets)
        => new()
        {
            GroupMap = new OneViewGroupMap
            {
                Dev = new()
                {
                    [serial] = new OneViewGroupMapDevice
                    {
                        Outlet = outlets.ToDictionary(o => o.index, o => new OneViewGroupMapOutlet { Group = o.group }),
                    },
                },
            },
        };

    [Fact]
    public void ResolveGroupMembers_FindsMatchingOutletsAcrossHosts()
    {
        var oneview = new OneViewRootData
        {
            Hosts = new()
            {
                Host("SERIAL-A", ("0", "2"), ("1", "3"), ("2", "2")),
                Host("SERIAL-B", ("5", "2"), ("6", "unassigned")),
            },
        };

        var members = PDU.ResolveGroupMembers(oneview, "2");

        Assert.Equal(3, members.Count);
        Assert.Contains(("SERIAL-A", 0), members);
        Assert.Contains(("SERIAL-A", 2), members);
        Assert.Contains(("SERIAL-B", 5), members);
        Assert.DoesNotContain(("SERIAL-A", 1), members);
    }

    [Fact]
    public void ResolveGroupMembers_ReturnsEmptyForUnknownGroup()
    {
        var oneview = new OneViewRootData { Hosts = new() { Host("SERIAL-A", ("0", "2")) } };
        Assert.Empty(PDU.ResolveGroupMembers(oneview, "nope"));
    }
}
