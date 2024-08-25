using rPDU2MQTT.Extensions;
using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Helpers;

public static class MQTTHelper
{
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

        return string.Join("/", paths.Select(p => p.Trim('/')));
    }

    public static string JoinPaths(string basePath, MqttPath path)
    {
        return JoinPaths(basePath, path.ToJsonString());
    }
}
