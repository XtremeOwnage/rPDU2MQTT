namespace rPDU2MQTT.Abstractions.Flow;

/// <summary>A reference to a child node: its declared type (which grain class owns it) and its id.</summary>
public sealed record NodeChild(string Type, string Id);

/// <summary>
/// A node's configuration in the energy-flow tree (framework-free): its mode/type and the children it rolls
/// up. A parent grain manages its children through this — pushed by the flow reconciler from config. For a
/// residual node, <see cref="Children"/> are its measured siblings and <see cref="Parent"/> is the measured
/// node whose total it splits, so it can report the untracked remainder (total − Σ siblings).
/// </summary>
public sealed record NodeSpec(string Mode, List<NodeChild> Children, NodeChild? Parent = null);

/// <summary>A node grain's self-description for the tree/diagnostics.</summary>
public sealed record NodeDescription(string Id, string Mode, int ChildCount);
