using rPDU2MQTT.Classes;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Services;
using rPDU2MQTT.Services.Kubernetes;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// KubernetesConfigWatcher.RequiresRestart: only the listen ports / GUI auth still force a restart —
/// MQTT and every PDU instance (primary included) are applied live (#187/#192).
/// </summary>
public class ConfigWatcherTests
{
    private static Config Sample()
    {
        var c = new Config();
        c.MQTT.Connection.Host = "mqtt.example.com";
        c.MQTT.Connection.Port = 1883;
        c.Pdus["default"] = new PduConfig();
        c.Pdus["default"].Connection.Host = "pdu.example.com";
        c.Gui.Port = 8080;
        return c;
    }

    [Fact]
    public void LiveReadableChanges_DoNotRequireRestart()
    {
        var a = Sample();
        var b = Sample();
        b.EmonCMS.Feeds.AutoConfigure = true;                       // EmonCMS
        b.HASS.DiscoveryEnabled = !a.HASS.DiscoveryEnabled;          // HASS
        b.EnergyFlow.MqttExport = true;                             // EnergyFlow
        b.Overrides.Measurements["realpower"] = new() { Name = "P" }; // Overrides
        b.Debug.PublishMessages = !a.Debug.PublishMessages;         // Debug

        Assert.False(KubernetesConfigWatcher.RequiresRestart(a, b));
    }

    [Fact]
    public void ListenPortsAndAuthChanges_RequireRestart()
    {
        var baseline = Sample();

        // Listening sockets are bound once when the host is built.
        var gui = Sample(); gui.Gui.Port = 9090;
        Assert.True(KubernetesConfigWatcher.RequiresRestart(baseline, gui));

        var api = Sample(); api.Api.Port = 9999;
        Assert.True(KubernetesConfigWatcher.RequiresRestart(baseline, api));

        var health = Sample(); health.Health.Port = 9091;
        Assert.True(KubernetesConfigWatcher.RequiresRestart(baseline, health));
    }

    [Fact]
    public void MqttChanges_NoLongerRequireRestart()
    {
        // The client is re-pointed in place by MqttReconfigurator instead of exiting the process (#192).
        var baseline = Sample();

        foreach (var mutate in new Action<Config>[]
        {
            c => c.MQTT.Connection.Host = "other.example.com",
            c => c.MQTT.Connection.Port = 8883,
            c => c.MQTT.Connection.Scheme = "mqtts",
            c => c.MQTT.Credentials = new() { Username = "u", Password = "p" },
            c => c.MQTT.ClientID = "different",
            c => c.MQTT.KeepAlive = 120,
            c => c.MQTT.LastWill = false,
            c => c.MQTT.ParentTopic = "other",
        })
        {
            var changed = Sample(); mutate(changed);
            Assert.False(KubernetesConfigWatcher.RequiresRestart(baseline, changed));
        }
    }

    [Fact]
    public void PduChanges_NoLongerRequireRestart_IncludingThePrimary()
    {
        // The primary is re-pointed in place now (its PDU object identity is pinned by DI, but its
        // internals are swapped), so nothing about any instance needs the process to exit (#192).
        var baseline = Sample();

        foreach (var mutate in new Action<Config>[]
        {
            c => c.Pdus["default"].Connection.Host = "moved.example.com",
            c => c.Pdus["default"].Connection.Port = 443,
            c => c.Pdus["default"].Connection.Scheme = "https",
            c => c.Pdus["default"].PollInterval = 60,
            c => c.Pdus["default"].Credentials = new() { Username = "u", Password = "p" },
        })
        {
            var changed = Sample(); mutate(changed);
            Assert.False(KubernetesConfigWatcher.RequiresRestart(baseline, changed));
        }

        // Adding a second instance stays live too.
        var added = Sample();
        added.Pdus["second"] = new PduConfig { PollInterval = 5 };
        added.Pdus["second"].Connection.Host = "pdu-2.example.com";
        Assert.False(KubernetesConfigWatcher.RequiresRestart(baseline, added));
    }
}

/// <summary>MqttOptionsFactory: the fingerprint that decides whether the live client is re-pointed (#192).</summary>
public class MqttOptionsFactoryTests
{
    private static Config Sample()
    {
        var c = new Config();
        c.MQTT.Connection.Host = "mqtt.example.com";
        c.MQTT.Connection.Port = 1883;
        return c;
    }

    [Fact]
    public void Fingerprint_IsStableForAnUnchangedConfig()
    {
        // ClientId gets a fresh GUID per Build(), so the fingerprint must not be derived from built options.
        Assert.Equal(MqttOptionsFactory.Fingerprint(Sample()), MqttOptionsFactory.Fingerprint(Sample()));
    }

    [Theory]
    [InlineData("host")]
    [InlineData("port")]
    [InlineData("scheme")]
    [InlineData("username")]
    [InlineData("password")]
    [InlineData("clientid")]
    [InlineData("keepalive")]
    [InlineData("lastwill")]
    [InlineData("parenttopic")]
    [InlineData("validatecert")]
    public void Fingerprint_ChangesForEverySettingTheClientDependsOn(string field)
    {
        var a = Sample();
        var b = Sample();
        switch (field)
        {
            case "host": b.MQTT.Connection.Host = "other.example.com"; break;
            case "port": b.MQTT.Connection.Port = 1884; break;
            case "scheme": b.MQTT.Connection.Scheme = "mqtts"; break;
            case "username": b.MQTT.Credentials = new() { Username = "u" }; break;
            case "password": b.MQTT.Credentials = new() { Password = "p" }; break;
            case "clientid": b.MQTT.ClientID = "other"; break;
            case "keepalive": b.MQTT.KeepAlive = 120; break;
            case "lastwill": b.MQTT.LastWill = !a.MQTT.LastWill; break;
            case "parenttopic": b.MQTT.ParentTopic = "other"; break;
            case "validatecert": b.MQTT.Connection.ValidateCertificate = false; break;
        }

        Assert.NotEqual(MqttOptionsFactory.Fingerprint(a), MqttOptionsFactory.Fingerprint(b));
    }

    [Fact]
    public void Build_AppliesSchemeCredentialsAndLastWill()
    {
        var c = Sample();
        c.MQTT.Connection.Scheme = "mqtts";
        c.MQTT.Connection.Port = null;              // inferred from the scheme
        c.MQTT.Credentials = new() { Username = "u", Password = "p" };
        c.MQTT.ParentTopic = "topic";

        var o = MqttOptionsFactory.Build(c);

        Assert.Equal("mqtt.example.com", o.Host);
        Assert.Equal(8883, o.Port);
        Assert.True(o.UseTLS);
        Assert.Equal("u", o.UserName);
        Assert.NotNull(o.LastWillAndTestament);
        Assert.StartsWith("topic", o.LastWillAndTestament!.Topic);
    }

    [Fact]
    public void Build_OmitsLastWill_WhenDisabled()
    {
        var c = Sample();
        c.MQTT.LastWill = false;
        Assert.Null(MqttOptionsFactory.Build(c).LastWillAndTestament);
    }
}

/// <summary>
/// MqttReconfigurator (#192): the decision to re-point, and the re-point sequence itself, driven through
/// <see cref="FakeHiveMQClient"/> so no live broker is needed.
/// </summary>
public class MqttReconfiguratorTests
{
    private static Config Sample()
    {
        var c = new Config();
        c.MQTT.Connection.Host = "mqtt.example.com";
        c.MQTT.Connection.Port = 1883;
        return c;
    }

    // A real client, never connected — enough to exercise the paths that don't touch the socket.
    private static HiveMQtt.Client.HiveMQClient Client(Config c) => new(MqttOptionsFactory.Build(c));

    [Fact]
    public async Task ApplyAsync_IsANoOp_WhenNothingTheClientCaresAboutChanged()
    {
        var cfg = Sample();
        var sut = new MqttReconfigurator(Client(cfg), cfg);

        // A change the client doesn't depend on must not trigger a reconnect (which would throw here,
        // since there is no broker to connect to).
        cfg.HASS.DiscoveryEnabled = !cfg.HASS.DiscoveryEnabled;
        cfg.Prometheus.Exporter = true;

        Assert.False(sut.NeedsRepoint(cfg));
        Assert.False(await sut.ApplyAsync());
    }

    [Fact]
    public async Task ApplyAsync_Disconnects_SwapsOptions_Reconnects_AndRestoresSubscriptions()
    {
        var cfg = Sample();
        var fake = new FakeHiveMQClient { Options = MqttOptionsFactory.Build(cfg) };
        // Two topics the services had subscribed to before the change.
        fake.Subscriptions.Add(new HiveMQtt.MQTT5.Types.Subscription(
            new HiveMQtt.MQTT5.Types.TopicFilter("rPDU2MQTT/cmd", HiveMQtt.MQTT5.Types.QualityOfService.AtLeastOnceDelivery)));
        fake.Subscriptions.Add(new HiveMQtt.MQTT5.Types.Subscription(
            new HiveMQtt.MQTT5.Types.TopicFilter("rPDU2MQTT/restart", HiveMQtt.MQTT5.Types.QualityOfService.AtLeastOnceDelivery)));

        var sut = new MqttReconfigurator(fake, cfg);

        cfg.MQTT.Connection.Host = "new-broker.example.com";
        cfg.MQTT.Connection.Port = 8883;
        cfg.MQTT.Connection.Scheme = "mqtts";

        Assert.True(await sut.ApplyAsync());

        // Order matters: the socket must be closed and the options swapped BEFORE reconnecting, then the
        // subscriptions replayed — otherwise the new broker never learns about the command topics.
        Assert.Equal(
            new[] { "disconnect", "connect", "subscribe:rPDU2MQTT/cmd", "subscribe:rPDU2MQTT/restart" },
            fake.Calls);

        // The client connected with the NEW options, and kept the same client object.
        Assert.Equal("new-broker.example.com", fake.OptionsWhenConnected!.Host);
        Assert.Equal(8883, fake.OptionsWhenConnected.Port);
        Assert.True(fake.OptionsWhenConnected.UseTLS);
        Assert.True(fake.Connected);

        // Applying again with no further change is a no-op (no second reconnect).
        fake.Calls.Clear();
        Assert.False(await sut.ApplyAsync());
        Assert.Empty(fake.Calls);
    }

    [Fact]
    public async Task ApplyAsync_SkipsTheDisconnect_WhenNotCurrentlyConnected()
    {
        var cfg = Sample();
        var fake = new FakeHiveMQClient { Options = MqttOptionsFactory.Build(cfg), Connected = false };
        var sut = new MqttReconfigurator(fake, cfg);

        cfg.MQTT.Connection.Host = "new-broker.example.com";
        Assert.True(await sut.ApplyAsync());

        Assert.Equal(new[] { "connect" }, fake.Calls);
    }

    [Fact]
    public void NeedsRepoint_TracksTheLiveConfig()
    {
        var cfg = Sample();
        var sut = new MqttReconfigurator(Client(cfg), cfg);

        Assert.False(sut.NeedsRepoint(cfg));

        var moved = Sample();
        moved.MQTT.Connection.Host = "other.example.com";
        Assert.True(sut.NeedsRepoint(moved));
    }
}
