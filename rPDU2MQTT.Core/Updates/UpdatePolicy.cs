namespace rPDU2MQTT.Updates;

/// <summary>
/// How far the operator (#210) is allowed to move the deployed image when checking for updates. Bounds
/// the newest candidate relative to the currently-deployed version so an update never silently crosses a
/// boundary the operator wasn't told it could.
/// </summary>
public enum UpdatePolicy
{
    /// <summary>Only newer patches on the same <c>MAJOR.MINOR</c> line (e.g. 1.2.3 → 1.2.9).</summary>
    Patch,
    /// <summary>Newer patches or minors within the same <c>MAJOR</c> line (e.g. 1.2.3 → 1.5.0). No breaking changes.</summary>
    Minor,
    /// <summary>Any newer release, including a new major (e.g. 1.2.3 → 2.0.0). May include breaking changes.</summary>
    Major,
}
