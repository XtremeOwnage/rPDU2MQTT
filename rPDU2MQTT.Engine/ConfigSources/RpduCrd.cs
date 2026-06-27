namespace rPDU2MQTT.Startup.ConfigSources;

/// <summary>Identifiers for the RpduConfig CustomResourceDefinition.</summary>
public static class RpduCrd
{
    public const string Group = "rpdu2mqtt.xtremeownage.com";
    public const string Version = "v1alpha1";
    public const string Plural = "rpduconfigs";
    public const string Singular = "rpduconfig";
    public const string Kind = "RpduConfig";
    public const string ApiVersion = Group + "/" + Version;
}
