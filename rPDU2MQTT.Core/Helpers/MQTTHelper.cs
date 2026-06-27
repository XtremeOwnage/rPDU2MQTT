using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Helpers;

public static class MQTTHelper
{
    /// <summary>Topic suffix (under the parent topic) for the bridge's LWT/birth availability status.</summary>
    public const string StatusSuffix = "Status";

    /// <summary>Command-topic suffixes (under the parent topic) for the diagnostic action buttons.</summary>
    public const string RediscoverSuffix = "rediscover";
    public const string RestartSuffix = "restart";

    /// <summary>Full availability status topic for the configured parent topic.</summary>
    public static string StatusTopic(string parentTopic) => JoinPaths(parentTopic, StatusSuffix);

    /// <summary>
    /// Joins multiple paths into a single MQTT path, ensuring there are no extra slashes.
    /// </summary>
    /// <param name="paths">An array of strings representing the paths to be joined.</param>
    /// <returns>A single string representing the joined MQTT path.</returns>
    public static string JoinPaths(params string[] paths)
    {
        if (paths == null || paths.Length == 0)
        {
            return string.Empty;
        }

        return string.Join("/", paths.Where(o => !string.IsNullOrEmpty(o)).Select(p => p.Trim('/')));
    }

    public static string JoinPaths(string basePath, MqttPath path)
    {
        return JoinPaths(basePath, path.ToJsonString());
    }
}
