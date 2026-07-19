using Microsoft.Extensions.Configuration;
using rPDU2MQTT.Core;
using rPDU2MQTT.Startup;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>HostRoles.Resolve: which workload(s) a process runs, from --role / RPDU2MQTT_ROLE.</summary>
public class HostRoleTests
{
    private static IConfiguration Cfg(params (string key, string val)[] kv)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(kv.Select(x => new KeyValuePair<string, string?>(x.key, x.val)))
            .Build();

    [Fact]
    public void DefaultsToAll_WhenUnset() => Assert.Equal(HostRole.All, HostRoles.Resolve(Cfg()));

    [Theory]
    [InlineData("worker", HostRole.Worker)]
    [InlineData("engine", HostRole.Worker)]
    [InlineData("data", HostRole.Worker)]
    [InlineData("api", HostRole.Api)]
    [InlineData("ui", HostRole.Ui)]
    [InlineData("gui", HostRole.Ui)]
    [InlineData("web", HostRole.Ui)]
    [InlineData("operator", HostRole.Operator)]
    [InlineData("op", HostRole.Operator)]
    [InlineData("all", HostRole.All)]
    public void ParsesSingleRole(string raw, HostRole expected) => Assert.Equal(expected, HostRoles.Resolve(Cfg(("role", raw))));

    [Fact]
    public void OperatorIsOptIn_NotPartOfAll() => Assert.False(HostRole.All.HasFlag(HostRole.Operator));

    [Fact]
    public void ParsesOperatorAlongsideAnotherRole() => Assert.Equal(HostRole.Ui | HostRole.Operator, HostRoles.Resolve(Cfg(("role", "ui,operator"))));

    [Fact]
    public void ParsesCommaSeparatedList() => Assert.Equal(HostRole.Api | HostRole.Ui, HostRoles.Resolve(Cfg(("role", "api, ui"))));

    [Fact]
    public void UnknownRoleFallsBackToAll() => Assert.Equal(HostRole.All, HostRoles.Resolve(Cfg(("role", "bogus"))));

    [Fact]
    public void ReadsEnvironmentKey() => Assert.Equal(HostRole.Worker, HostRoles.Resolve(Cfg(("RPDU2MQTT_ROLE", "worker"))));

    [Fact]
    public void CommandLineRoleTakesPrecedenceOverEnv() => Assert.Equal(HostRole.Api, HostRoles.Resolve(Cfg(("role", "api"), ("RPDU2MQTT_ROLE", "worker"))));
}
