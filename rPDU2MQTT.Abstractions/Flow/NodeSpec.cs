namespace rPDU2MQTT.Abstractions.Flow;

/// <summary>A reference to a child node: its declared type (which grain class owns it) and its id.</summary>
public sealed record NodeChild(string Type, string Id);

/// <summary>
/// A node's configuration in the energy-flow tree (framework-free): its mode/type and the children it rolls
/// up. A parent grain manages its children through this — pushed by the flow reconciler from config.
/// </summary>
public sealed record NodeSpec(string Mode, List<NodeChild> Children);

/// <summary>A node grain's self-description for the tree/diagnostics.</summary>
public sealed record NodeDescription(string Id, string Mode, int ChildCount);
