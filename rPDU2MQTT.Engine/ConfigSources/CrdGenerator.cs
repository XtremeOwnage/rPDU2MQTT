using rPDU2MQTT.Services.Gui;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Startup.ConfigSources;

/// <summary>
/// Generates the RpduConfig CustomResourceDefinition manifest, deriving the <c>spec</c> OpenAPI v3
/// schema from the same <see cref="ConfigSchema"/> reflection the GUI uses, so it tracks the model.
/// </summary>
public static class CrdGenerator
{
    public static string ToYaml()
    {
        var serializer = new SerializerBuilder().Build();
        return serializer.Serialize(BuildCrd());
    }

    private static object BuildCrd()
    {
        var specSchema = ObjectSchema(ConfigSchema.Build());

        var statusSchema = new Dictionary<string, object?>
        {
            ["type"] = "object",
            ["x-kubernetes-preserve-unknown-fields"] = true,
            ["properties"] = new Dictionary<string, object?>
            {
                ["connected"] = new Dictionary<string, object?> { ["type"] = "boolean" },
                ["deviceCount"] = new Dictionary<string, object?> { ["type"] = "integer" },
                ["lastPoll"] = new Dictionary<string, object?> { ["type"] = "string" },
                ["message"] = new Dictionary<string, object?> { ["type"] = "string" },
                // Operator update check (#210): reported by the operator role, merged alongside the fields above.
                ["update"] = new Dictionary<string, object?>
                {
                    ["type"] = "object",
                    ["x-kubernetes-preserve-unknown-fields"] = true,
                    ["properties"] = new Dictionary<string, object?>
                    {
                        ["available"] = new Dictionary<string, object?> { ["type"] = "boolean" },
                        ["current"] = new Dictionary<string, object?> { ["type"] = "string" },
                        ["latest"] = new Dictionary<string, object?> { ["type"] = "string" },
                        ["policy"] = new Dictionary<string, object?> { ["type"] = "string" },
                        ["autoUpdate"] = new Dictionary<string, object?> { ["type"] = "boolean" },
                        ["applied"] = new Dictionary<string, object?> { ["type"] = "string" },
                        ["checkedAt"] = new Dictionary<string, object?> { ["type"] = "string" },
                        ["message"] = new Dictionary<string, object?> { ["type"] = "string" },
                    },
                },
            },
        };

        return new Dictionary<string, object?>
        {
            ["apiVersion"] = "apiextensions.k8s.io/v1",
            ["kind"] = "CustomResourceDefinition",
            ["metadata"] = new Dictionary<string, object?>
            {
                ["name"] = $"{RpduCrd.Plural}.{RpduCrd.Group}",
            },
            ["spec"] = new Dictionary<string, object?>
            {
                ["group"] = RpduCrd.Group,
                ["scope"] = "Namespaced",
                ["names"] = new Dictionary<string, object?>
                {
                    ["plural"] = RpduCrd.Plural,
                    ["singular"] = RpduCrd.Singular,
                    ["kind"] = RpduCrd.Kind,
                    ["shortNames"] = new List<object?> { "rpdu" },
                },
                ["versions"] = new List<object?>
                {
                    new Dictionary<string, object?>
                    {
                        ["name"] = RpduCrd.Version,
                        ["served"] = true,
                        ["storage"] = true,
                        ["subresources"] = new Dictionary<string, object?> { ["status"] = new Dictionary<string, object?>() },
                        ["additionalPrinterColumns"] = new List<object?>
                        {
                            PrinterColumn("Connected", "string", ".status.connected"),
                            PrinterColumn("Devices", "integer", ".status.deviceCount"),
                            PrinterColumn("LastPoll", "string", ".status.lastPoll"),
                            PrinterColumn("Update", "string", ".status.update.latest"),
                        },
                        ["schema"] = new Dictionary<string, object?>
                        {
                            ["openAPIV3Schema"] = new Dictionary<string, object?>
                            {
                                ["type"] = "object",
                                ["properties"] = new Dictionary<string, object?>
                                {
                                    ["spec"] = specSchema,
                                    ["status"] = statusSchema,
                                },
                            },
                        },
                    },
                },
            },
        };
    }

    private static Dictionary<string, object?> PrinterColumn(string name, string type, string jsonPath)
        => new() { ["name"] = name, ["type"] = type, ["jsonPath"] = jsonPath };

    private static Dictionary<string, object?> ObjectSchema(IEnumerable<SchemaNode> nodes)
    {
        var props = new Dictionary<string, object?>();
        foreach (var n in nodes)
            props[n.Key] = SchemaFor(n);

        return new Dictionary<string, object?>
        {
            ["type"] = "object",
            // Keep validation lenient/forward-compatible: known fields are typed, unknown are preserved.
            ["x-kubernetes-preserve-unknown-fields"] = true,
            ["properties"] = props,
        };
    }

    private static object SchemaFor(SchemaNode n)
    {
        Dictionary<string, object?> s = n.Type switch
        {
            "bool" => new() { ["type"] = "boolean" },
            "int" => new() { ["type"] = "integer" },
            "double" => new() { ["type"] = "number" },
            "enum" => new() { ["type"] = "string", ["enum"] = (n.EnumValues ?? Array.Empty<string>()).Cast<object?>().ToList() },
            "object" => ObjectSchema(n.Properties ?? new()),
            "dictionary" => new()
            {
                ["type"] = "object",
                ["x-kubernetes-preserve-unknown-fields"] = true,
                ["additionalProperties"] = n.ValueSchema is null ? new Dictionary<string, object?> { ["type"] = "string" } : SchemaFor(n.ValueSchema),
            },
            "list" => new()
            {
                ["type"] = "array",
                ["items"] = n.ValueSchema is null ? new Dictionary<string, object?> { ["type"] = "string" } : SchemaFor(n.ValueSchema),
            },
            _ => new() { ["type"] = "string" }, // string + password
        };

        if (!string.IsNullOrEmpty(n.Description) && s["type"] is not null)
            s["description"] = n.Description;
        if (n.Min is { } min && (n.Type == "int" || n.Type == "double"))
            s["minimum"] = min;
        if (n.Max is { } max && (n.Type == "int" || n.Type == "double"))
            s["maximum"] = max;

        return s;
    }
}
