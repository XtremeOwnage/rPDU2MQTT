using System.Net;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

public class TrustedNetworksTests
{
    private static IReadOnlyList<Cidr> Ranges(params string[] cidrs) => TrustedNetworks.Parse(cidrs).Valid;
    private static IPAddress Ip(string s) => IPAddress.Parse(s);

    [Theory]
    [InlineData("10.100.64.247/32", "10.100.64.247", true)]
    [InlineData("10.100.64.247/32", "10.100.64.248", false)]
    [InlineData("10.100.64.247", "10.100.64.247", true)]
    [InlineData("10.100.64.0/24", "10.100.64.1", true)]
    [InlineData("10.100.64.0/24", "10.100.65.1", false)]
    [InlineData("10.100.64.5/24", "10.100.64.200", true)]
    [InlineData("10.0.0.0/8", "10.255.255.255", true)]
    [InlineData("0.0.0.0/0", "192.168.1.1", true)]
    [InlineData("10.100.64.247/32", "::ffff:10.100.64.247", true)]
    [InlineData("fd00::/8", "fd12::1", true)]
    [InlineData("fd00::/8", "fe80::1", false)]
    [InlineData("10.0.0.0/8", "fd00::1", false)]
    public void CidrMatching(string cidr, string address, bool expected)
    {
        Assert.True(Cidr.TryParse(cidr, out var c));
        Assert.Equal(expected, c.Contains(Ip(address)));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-an-ip")]
    [InlineData("10.0.0.0/33")]
    [InlineData("10.0.0.0/-1")]
    [InlineData("10.0.0.0/")]
    [InlineData("fd00::/129")]
    public void InvalidEntriesAreRejected(string cidr) => Assert.False(Cidr.TryParse(cidr, out _));

    [Fact]
    public void ParseSeparatesInvalidEntries()
    {
        var (valid, invalid) = TrustedNetworks.Parse(["10.0.0.0/8", "bogus", " ", "fd00::/8"]);
        Assert.Equal(2, valid.Count);
        Assert.Equal(new[] { "bogus" }, invalid);
    }

    [Fact]
    public void SplitReadsCommaSeparatedLists() =>
        Assert.Equal(new[] { "10.100.64.247/32", "10.16.3.101/32" }, TrustedNetworks.Split(" 10.100.64.247/32, 10.16.3.101/32 ,"));

    private static readonly IReadOnlyList<Cidr> Gateway = Ranges("10.16.3.101/32");

    [Fact]
    public void WithoutTrustedProxies_ForwardedForIsIgnored()
    {
        var client = TrustedNetworks.ClientAddress(Ip("10.16.3.101"), ["10.100.64.247"], []);
        Assert.Equal(Ip("10.16.3.101"), client);
    }

    [Fact]
    public void FromATrustedProxy_TheEntryItAddedIsTheClient()
    {
        var client = TrustedNetworks.ClientAddress(Ip("10.16.3.101"), ["10.100.64.247"], Gateway);
        Assert.Equal(Ip("10.100.64.247"), client);
    }

    [Fact]
    public void ASpoofedEntryLeftOfTheProxysIsNotUsed()
    {
        // The gateway appends the real peer after whatever the client sent.
        var client = TrustedNetworks.ClientAddress(Ip("10.16.3.101"), ["10.100.64.247,10.100.64.2"], Gateway);
        Assert.Equal(Ip("10.100.64.2"), client);
        Assert.False(TrustedNetworks.InAny(client, Ranges("10.100.64.247/32")));
    }

    [Fact]
    public void ADirectConnectionCannotSpoofForwardedFor()
    {
        var client = TrustedNetworks.ClientAddress(Ip("10.100.64.2"), ["10.100.64.247"], Gateway);
        Assert.Equal(Ip("10.100.64.2"), client);
    }

    [Fact]
    public void ChainedTrustedProxiesAreWalked()
    {
        var proxies = Ranges("10.16.3.101/32", "10.100.7.0/24");
        var client = TrustedNetworks.ClientAddress(Ip("10.16.3.101"), ["1.2.3.4, 10.100.64.247, 10.100.7.9"], proxies);
        Assert.Equal(Ip("10.100.64.247"), client);
    }

    [Fact]
    public void MultipleHeadersAreReadInOrder()
    {
        var client = TrustedNetworks.ClientAddress(Ip("10.16.3.101"), ["10.100.64.247", "10.100.64.2"], Gateway);
        Assert.Equal(Ip("10.100.64.2"), client);
    }

    [Fact]
    public void AMalformedEntryStopsTheWalk()
    {
        var client = TrustedNetworks.ClientAddress(Ip("10.16.3.101"), ["10.100.64.247, garbage"], Gateway);
        Assert.Equal(Ip("10.16.3.101"), client);
    }

    [Fact]
    public void AnEmptyHeaderLeavesTheProxyAsTheClient()
    {
        Assert.Equal(Ip("10.16.3.101"), TrustedNetworks.ClientAddress(Ip("10.16.3.101"), [], Gateway));
    }

    [Theory]
    [InlineData("10.100.64.247:51234")]
    [InlineData("[::ffff:10.100.64.247]:51234")]
    public void EntriesWithPortsAreRead(string entry)
    {
        var client = TrustedNetworks.ClientAddress(Ip("10.16.3.101"), [entry], Gateway);
        Assert.Equal(Ip("10.100.64.247"), client);
    }

    [Fact]
    public void IPv4MappedPeerMatchesAnIPv4Proxy()
    {
        var client = TrustedNetworks.ClientAddress(Ip("::ffff:10.16.3.101"), ["10.100.64.247"], Gateway);
        Assert.Equal(Ip("10.100.64.247"), client);
    }

    [Theory]
    [InlineData("GET", "/", true)]
    [InlineData("GET", "/app.js", true)]
    [InlineData("GET", "/api/config", true)]
    [InlineData("GET", "/api/flow", true)]
    [InlineData("GET", "/api/events", true)]
    [InlineData("HEAD", "/api/status", true)]
    [InlineData("POST", "/api/flow/live", true)]
    [InlineData("POST", "/api/panels/resolve", true)]
    [InlineData("POST", "/api/integrations/tigo/optimizers", true)]
    [InlineData("POST", "/api/config", false)]
    [InlineData("POST", "/api/control/outlet", false)]
    [InlineData("POST", "/api/restart", false)]
    [InlineData("POST", "/api/plans/images", false)]
    [InlineData("POST", "/api/integrations/tigo", false)]
    [InlineData("POST", "/api/integrations/tigo/optimizers/extra", false)]
    [InlineData("DELETE", "/api/plans/images/x", false)]
    [InlineData("PUT", "/api/config", false)]
    [InlineData("GET", "/api/diagnostics/logs", false)]
    [InlineData("GET", "/API/Diagnostics", false)]
    [InlineData("GET", "/api/mqtt/topics", false)]
    [InlineData("GET", "/api/ha/orphans", false)]
    [InlineData("GET", "/api/operator/tags", false)]
    [InlineData("GET", "/api/restart/targets", false)]
    [InlineData("GET", "/api/discover/nodes", false)]
    public void ViewerRequests(string method, string path, bool allowed) =>
        Assert.Equal(allowed, TrustedNetworks.ViewerMayRequest(method, path));

    [Fact]
    public void ViewerConfigCarriesNoCredentials()
    {
        var config = new Config();
        config.Gui.Password = "gui-pass";
        config.Gui.Oidc.ClientSecret = "oidc-secret";
        config.HASS.Token = "ha-token";
        config.Api.ApiKey = "api-key";
        config.Cache.Password = "cache-pass";
        config.MQTT.Credentials = new Models.Config.Schemas.Credentials { Username = "u", Password = "mqtt-pass" };
        config.Plugins["example"] = new Dictionary<string, object?> { ["Host"] = "h", ["Password"] = "plugin-pass", ["AuthToken"] = "plugin-token" };

        var json = ConfigSchema.ToViewerJson(config);

        foreach (var secret in new[] { "gui-pass", "oidc-secret", "ha-token", "api-key", "cache-pass", "mqtt-pass", "plugin-pass", "plugin-token" })
            Assert.DoesNotContain(secret, json);
        Assert.Contains("\"Host\"", json);
    }

    [Fact]
    public void TrustedListsAppearInTheGuiSettings()
    {
        var gui = ConfigSchema.Build().Single(n => n.Key == "Gui");
        Assert.Equal("list", gui.Properties!.Single(p => p.Key == "TrustedNetworks").Type);
        Assert.Equal("list", gui.Properties!.Single(p => p.Key == "TrustedProxies").Type);
    }

    [Theory]
    [InlineData("GET", "/kiosk", null, true)]
    [InlineData("GET", "/kiosk/", null, true)]
    [InlineData("GET", "/app.js", null, true)]
    [InlineData("GET", "/api/flow", null, true)]
    [InlineData("GET", "/api/flow/series", null, true)]
    [InlineData("GET", "/api/status/board", null, true)]
    [InlineData("POST", "/api/flow/live", null, true)]
    [InlineData("GET", "/api/events", "flow:realpower,status", true)]
    [InlineData("GET", "/api/events", "status,logs", false)]
    [InlineData("GET", "/", null, false)]
    [InlineData("GET", "/api/config", null, false)]
    [InlineData("GET", "/api/schema", null, false)]
    [InlineData("POST", "/api/config", null, false)]
    [InlineData("DELETE", "/kiosk", null, false)]
    public void KioskRequests(string method, string path, string? topics, bool allowed) =>
        Assert.Equal(allowed, TrustedNetworks.KioskMayRequest(method, path, topics));
}
