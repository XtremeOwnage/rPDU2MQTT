namespace rPDU2MQTT.Startup.ConfigSources;

/// <summary>Selects the configuration source from <c>RPDU2MQTT_CONFIG_SOURCE</c> (default: file).</summary>
public static class ConfigSourceFactory
{
    public static bool IsKubernetes
    {
        get
        {
            var src = Environment.GetEnvironmentVariable("RPDU2MQTT_CONFIG_SOURCE");
            return string.Equals(src, "k8s", StringComparison.OrdinalIgnoreCase)
                || string.Equals(src, "kubernetes", StringComparison.OrdinalIgnoreCase);
        }
    }
}
