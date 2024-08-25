using System.Text.RegularExpressions;

namespace rPDU2MQTT.Helpers;

public static partial class FormatNameHelper
{
    /// <summary>
    /// Formats a name to make it sutiable for use with home assistant, etc.
    /// </summary>
    /// <param name="Name"></param>
    /// <returns></returns>
    public static string FormatName(this string Name)
    {
        //Replace any characters other then spaces, and understores.
        return SpacesAndCharactersOnly().Replace(Name, "")
            //Convert everything to lower-case
            .ToLowerInvariant()
            //Replace spaces now.
            .Replace(' ', '_')
            //Replace duplicated understores
            .Replace("__", "_");
    }


    const string Pattern = @"[^\w\s]";

    [GeneratedRegex(Pattern, RegexOptions.Singleline)]
    private static partial Regex SpacesAndCharactersOnly();
}
