using rPDU2MQTT.Plugins;
using Xunit;

namespace rPDU2MQTT.Tests;

public class PluginApiTests
{
    [Theory]
    [InlineData("1.0.0.0", "1.0.0.0")]
    [InlineData("1.0.0.0", "1.3.0.0")]
    [InlineData("1.2.0.0", "1.3.0.0")]
    public void ACompatiblePlugin_Loads(string built, string host)
        => Assert.Null(PluginApi.Incompatible(Version.Parse(built), Version.Parse(host)));

    [Theory]
    [InlineData("1.0.0.0", "2.0.0.0", "Rebuild")]
    [InlineData("2.0.0.0", "1.0.0.0", "Rebuild")]
    [InlineData("1.4.0.0", "1.3.0.0", "Update the bridge")]
    public void AnIncompatiblePlugin_SaysWhatToDo(string built, string host, string fix)
        => Assert.Contains(fix, PluginApi.Incompatible(Version.Parse(built), Version.Parse(host)));

    [Fact]
    public void ABundledPlugin_IsBuiltAgainstThisHost()
    {
        var built = typeof(Plugin.Vertiv.VertivPlugin).Assembly.Location;
        Assert.Equal(PluginApi.Host, PluginApi.BuiltAgainst(built));
        Assert.Null(PluginApi.Incompatible(built));
    }

    [Fact]
    public void AnAssemblyThatDoesNotReferenceCore_IsNotChecked()
        => Assert.Null(PluginApi.BuiltAgainst(typeof(Xunit.FactAttribute).Assembly.Location));
}
