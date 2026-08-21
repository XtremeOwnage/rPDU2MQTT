using rPDU2MQTT.Services.Gui;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Which config fields the GUI treats as credentials. The type decides two things: the browser masks the
/// input, and the value is kept out of the change-review list. A field classified as a plain string is
/// rendered in clear text and shown verbatim in the review diff — which is how the Home Assistant
/// long-lived token came to be on screen.
/// </summary>
public class CredentialFieldsAreMaskedTests
{
    private static string? TypeOf(params string[] path)
    {
        IEnumerable<SchemaNode>? level = ConfigSchema.Build();
        SchemaNode? node = null;
        foreach (var key in path)
        {
            node = level?.FirstOrDefault(n => string.Equals(n.Key, key, StringComparison.OrdinalIgnoreCase));
            level = node?.Properties;
        }
        return node?.Type;
    }

    [Theory]
    [InlineData("HomeAssistant", "EnergyDashboard", "Token")]
    [InlineData("Api", "ApiKey")]
    [InlineData("EmonCMS", "ApiKey")]
    [InlineData("Gui", "Password")]
    [InlineData("Cache", "Password")]
    public void ACredentialIsMasked(params string[] path)
        => Assert.Equal("password", TypeOf(path));

    /// <summary>A field is not a credential because its name happens to contain one of those words.</summary>
    [Theory]
    [InlineData("HomeAssistant", "DiscoveryTopic")]
    [InlineData("HomeAssistant", "GroupMemberObjectIdTemplate")]
    public void AnOrdinarySettingIsNot(params string[] path)
        => Assert.Equal("string", TypeOf(path));
}
