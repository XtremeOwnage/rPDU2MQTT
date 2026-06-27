using System.Reflection;
using System.Text.Json.Serialization;

namespace rPDU2MQTT.Extensions;

public static class EnumExtensions
{
    public static string ToJsonString<T>(this T enumValue) where T : Enum
    {
        var type = enumValue.GetType();
        var memberInfo = type.GetMember(enumValue.ToString());

        if (memberInfo.Length > 0)
        {
            var attribute = memberInfo[0].GetCustomAttribute<JsonPropertyNameAttribute>();
            if (attribute != null)
            {
                return attribute.Name;
            }
        }

        return enumValue.ToString();
    }
}
