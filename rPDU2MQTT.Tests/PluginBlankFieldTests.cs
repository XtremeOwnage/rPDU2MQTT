using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Plugin.Tigo;
using Xunit;
public class PluginBlankFieldTests
{
    [Theory]
    [InlineData("empty")] [InlineData("null")]
    public void BlankFields_KeepTheirDefaults(string kind)
    {
        object? blank = kind == "empty" ? "" : null;
        var conn = new Dictionary<string, object?> { ["Id"]="tap-1", ["Name"]="Tigo Tap", ["Enabled"]=true, ["Host"]="10.103.6.174", ["Port"]=4196L, ["Mode"]="Listen", ["GatewayId"]=blank, ["PollIntervalMs"]=blank, ["AmpsScale"]=blank };
        var sections = new Dictionary<string, object?> { ["tigo"] = new Dictionary<string, object?> { ["Enabled"]=true, ["StaleSeconds"]=blank, ["Connections"]=new List<object?>{conn} } };
        string? w = null;
        var p = new TigoPlugin();
        var s = (TigoSettings)PluginConfigBinder.Bind(p, "tigo", sections, m => w = m);
        Assert.Null(w); Assert.Single(s.Connections); Assert.Equal(180, s.StaleSeconds); Assert.Equal(1000, s.Connections[0].PollIntervalMs);
    }
}
public class PluginJsonSectionBlankTests
{
    [Fact]
    public void BlankFields_InAJsonSection_KeepTheirDefaults()
    {
        var cfg = rPDU2MQTT.Services.Gui.ConfigSchema.FromJson("""{"Plugins":{"tigo":{"Enabled":true,"StaleSeconds":null,"Connections":[{"Id":"tap-1","Host":"10.103.6.174","Port":4196,"Mode":"Listen","PollIntervalMs":null,"AmpsScale":null,"GatewayId":""}]}}}""");
        string? w = null;
        var s = (TigoSettings)PluginConfigBinder.Bind(new TigoPlugin(), "tigo", cfg.Plugins, m => w = m);
        Assert.Null(w); Assert.Single(s.Connections); Assert.Equal(180, s.StaleSeconds);
    }
}
