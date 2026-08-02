using rPDU2MQTT.Services.Gui;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Settings the GUI shows but must not let you change — the ones whose "off" removes the means of turning
/// them back on.
/// </summary>
public class GuiLockoutTests
{
    private static SchemaNode Field(string section, string key)
    {
        var s = ConfigSchema.Build().Single(n => n.Key == section);
        return s.Properties!.Single(p => p.Key == key);
    }

    [Fact]
    public void TheGuisOwnEnabledFlag_CannotBeEditedFromTheGui()
    {
        // Switching it off from inside the GUI takes away the only screen that could switch it back on; the
        // config is then reachable only by hand-editing the deployment.
        var f = Field("Gui", "Enabled");

        Assert.False(string.IsNullOrWhiteSpace(f.NotEditableReason));
        Assert.Contains("lock you out", f.NotEditableReason);
    }

    [Fact]
    public void ItIsStillPresentInTheSchema_SoTheFormCanShowItRatherThanHideIt()
    {
        // Hiding it would read as unsupported and send the operator looking. The form disables it and prints
        // the reason instead, which needs the field to actually be there.
        Assert.Equal("bool", Field("Gui", "Enabled").Type);
    }

    [Fact]
    public void OrdinaryFields_AreUntouched()
    {
        Assert.Null(Field("Gui", "ShowProjectLink").NotEditableReason);
        Assert.Null(Field("MQTT", "ClientID").NotEditableReason);
    }
}
