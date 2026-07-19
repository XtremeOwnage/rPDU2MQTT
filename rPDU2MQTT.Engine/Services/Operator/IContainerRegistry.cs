namespace rPDU2MQTT.Services.Operator;

/// <summary>
/// Reads the tags a container image repository offers, so the operator (#210) can decide whether a newer
/// release than the deployed one exists.
/// </summary>
public interface IContainerRegistry
{
    /// <summary>
    /// List every tag published for <paramref name="repository"/> on <paramref name="registryHost"/>
    /// (the OCI/Docker Registry v2 <c>/v2/&lt;repo&gt;/tags/list</c> endpoint, with anonymous token auth
    /// for public images and pagination followed).
    /// </summary>
    Task<IReadOnlyList<string>> ListTagsAsync(string registryHost, string repository, CancellationToken ct);
}
