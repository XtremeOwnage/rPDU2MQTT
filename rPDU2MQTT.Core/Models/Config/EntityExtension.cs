namespace rPDU2MQTT.Models.Config;

/// <summary>The core entities a plugin can keep its own settings on.</summary>
public static class EntityKind
{
    public const string Node = "node";
    public const string Panel = "panel";
    public const string Breaker = "breaker";

    public static readonly string[] All = [Node, Panel, Breaker];
}

/// <summary>
/// A core entity that carries plugin settings, keyed by plugin id. A plugin cannot add a property to a class
/// it does not define, so it gets an open bag — the arrangement <c>Config.Plugins</c> uses for whole sections.
/// </summary>
public interface IExtensible
{
    Dictionary<string, object?>? Ext { get; set; }
}

/// <summary>Marks the property where plugins keep their settings on an entity, so the schema can describe them.</summary>
[AttributeUsage(AttributeTargets.Property)]
public sealed class ExtensionPointAttribute : Attribute
{
    public string Entity { get; }

    public ExtensionPointAttribute(string entity) => Entity = entity;
}
