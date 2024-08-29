namespace rPDU2MQTT.Helpers;

public static class StringHelper
{
    /// <summary>
    /// Returns the first non-<see langword="null"/>, non-empty value.
    /// </summary>
    /// <param name="values"></param>
    /// <returns></returns>
    public static string? Coalesce(params string?[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value))
                return value;
        }

        return null;
    }
}
