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
        cfg.Api.ApiKey = "apikey";

        var redacted = ConfigSchema.RedactSecrets(cfg);

        Assert.Null(redacted.MQTT.Credentials);
        Assert.Null(redacted.Primary.Credentials);
        Assert.Null(redacted.EmonCMS.ApiKey);
        Assert.Null(redacted.Gui.Password);
        // Stripped from the CR, so it must come back via RPDU2MQTT_API_KEY (#190).
        Assert.Null(redacted.Api.ApiKey);
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

    /// <summary>
    /// The committed CRD manifests are generated artifacts (<c>rPDU2MQTT --emit-crd</c>), and nothing was
    /// checking they still matched the config model. Examples/Kubernetes/crd/crd.yaml had silently drifted
    /// 199 lines behind across several releases — anyone applying it got a schema with no EnergyFlow and no
    /// EmonCMS feed settings. Pin both so adding a config field can't quietly leave them stale again.
    /// </summary>
    [Theory]
    [InlineData("charts/rpdu2mqtt/crds/rpduconfig.yaml")]
    [InlineData("Examples/Kubernetes/crd/crd.yaml")]
    public void CommittedCrdManifests_MatchTheGenerator(string relativePath)
    {
        var repoRoot = FindRepoRoot();
        var path = Path.Combine(repoRoot, relativePath);
        Assert.True(File.Exists(path), $"{relativePath} is missing.");

        var committed = File.ReadAllText(path).ReplaceLineEndings("\n").TrimEnd();
        var generated = CrdGenerator.ToYaml().ReplaceLineEndings("\n").TrimEnd();

        Assert.True(committed == generated,
            $"{relativePath} is out of date with the config model. Regenerate it:\n" +
            $"    dotnet run --project rPDU2MQTT --no-launch-profile -- --emit-crd > {relativePath}");
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "rPDU2MQTT.sln")))
            dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("Could not locate the repository root (no rPDU2MQTT.sln above the test output).");
    }
}
