using System.Diagnostics.CodeAnalysis;

namespace rPDU2MQTT.Helpers;

public static class ThrowError
{
    [DoesNotReturn]
    public static T ConfigurationMissing<T>(string ConfigurationPath)
    {
        Console.WriteLine("Please validate configuration.yaml");
        string msg = $"Missing required configuration of type {typeof(T).Name}. Path: " + ConfigurationPath;
        Console.WriteLine(msg);

        throw new Exception(msg);
    }

    public static void TestRequiredConfigurationSection([AllowNull, NotNull] object section, string ConfigurationPath)
    {
        if (section is null)
        {
            Console.WriteLine("Please validate configuration.yaml");
            string msg = $"Missing required configuration. Path: " + ConfigurationPath;
            Console.WriteLine(msg);

            throw new Exception(msg);
        }
    }


}
