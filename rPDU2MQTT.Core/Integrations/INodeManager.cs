namespace rPDU2MQTT.Core.Integrations;

/// <summary>An integration that creates and maintains flow nodes. The Nodes page can hide them.</summary>
public interface INodeManager
{
    /// <summary>Rules matching the nodes this integration manages.</summary>
    IReadOnlyList<ManagedNodeRule> ManagedNodes { get; }
}

/// <summary>A node matches when it has a source of type <paramref name="SourceType"/> or carries <paramref name="Tag"/>.</summary>
public sealed record ManagedNodeRule(string? SourceType = null, string? Tag = null);
