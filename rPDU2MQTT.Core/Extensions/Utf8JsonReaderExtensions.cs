using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace rPDU2MQTT.Extensions;
public static class Utf8JsonReaderExtensions
{
    /// <summary>
    /// Used to assist with debugging.... Prints JSON represented by a reader.
    /// </summary>
    /// <param name="reader"></param>
    /// <returns></returns>
    public static string ToJsonString(this Utf8JsonReader reader)
    {
        var sb = new StringBuilder();
        int depth = 0;

        while (reader.Read())
        {
            switch (reader.TokenType)
            {
                case JsonTokenType.StartObject:
                    sb.Append("{");
                    depth++;
                    break;
                case JsonTokenType.EndObject:
                    sb.Append("}");
                    depth--;
                    break;
                case JsonTokenType.StartArray:
                    sb.Append("[");
                    depth++;
                    break;
                case JsonTokenType.EndArray:
                    sb.Append("]");
                    depth--;
                    break;
                case JsonTokenType.PropertyName:
                    sb.Append($"\"{reader.GetString()}\":");
                    break;
                case JsonTokenType.String:
                    sb.Append($"\"{reader.GetString()}\"");
                    break;
                case JsonTokenType.Number:
                    if (reader.TryGetInt64(out long longValue))
                        sb.Append(longValue);
                    else
                        sb.Append(reader.GetDouble());
                    break;
                case JsonTokenType.True:
                    sb.Append("true");
                    break;
                case JsonTokenType.False:
                    sb.Append("false");
                    break;
                case JsonTokenType.Null:
                    sb.Append("null");
                    break;
            }

            // Add a comma if the next token should follow with a comma
            if (reader.TokenType == JsonTokenType.PropertyName || reader.TokenType == JsonTokenType.StartObject || reader.TokenType == JsonTokenType.StartArray)
            {
                continue; // Skip adding a comma after these token types
            }

            // Peek ahead to see if a comma is needed
            if (depth > 0 && reader.TokenType != JsonTokenType.EndObject && reader.TokenType != JsonTokenType.EndArray && reader.HasValueSequence)
            {
                sb.Append(",");
            }
        }

        return sb.ToString();
    }
}