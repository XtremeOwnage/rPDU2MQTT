using rPDU2MQTT.Core;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>The bus restart command's target matching (#210) — a process obeys "all" or its own role.</summary>
public class RestartCommandTests
{
    private static RestartCommand Cmd(string target) => new(target, DateTime.UtcNow);

    [Fact]
    public void All_MatchesEveryProcess()
    {
        Assert.True(Cmd("all").MatchesRoles(new[] { "worker" }));
        Assert.True(Cmd("all").MatchesRoles(new[] { "worker", "api", "ui" }));
        Assert.True(Cmd("ALL").MatchesRoles(new[] { "ui" }));   // case-insensitive
    }

    [Fact]
    public void Role_MatchesOnlyProcessesRunningThatRole()
    {
        Assert.True(Cmd("worker").MatchesRoles(new[] { "worker" }));
        Assert.True(Cmd("api").MatchesRoles(new[] { "worker", "api", "ui" }));   // an all-in-one runs every role
        Assert.False(Cmd("worker").MatchesRoles(new[] { "api", "ui" }));
        Assert.False(Cmd("ui").MatchesRoles(Array.Empty<string>()));
    }

    [Fact]
    public void TopicFor_IsUnderTheBusNamespace()
        => Assert.Equal("rpdu2mqtt/_bus/command/restart", RestartCommand.TopicFor("rpdu2mqtt"));
}
