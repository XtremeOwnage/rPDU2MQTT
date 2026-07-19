using System.Diagnostics.CodeAnalysis;

namespace rPDU2MQTT.Updates;

/// <summary>
/// A parsed OCI image reference (<c>[registry/]repository[:tag][@digest]</c>) — e.g.
/// <c>ghcr.io/xtremeownage/rpdu2mqtt:1.2.3</c>. The operator (#210) uses it to learn which registry and
/// repository to query for available tags, and which tag is currently deployed.
/// </summary>
public sealed record ImageReference(string Registry, string Repository, string? Tag, string? Digest)
{
    /// <summary>Registry used when a reference omits one (Docker Hub's implicit default).</summary>
    public const string DefaultRegistry = "docker.io";

    /// <summary>The registry's HTTPS API host. Docker Hub's registry lives at registry-1.docker.io.</summary>
    public string RegistryHost => Registry == DefaultRegistry ? "registry-1.docker.io" : Registry;

    public static bool TryParse([NotNullWhen(true)] string? image, [NotNullWhen(true)] out ImageReference? reference)
    {
        reference = null;
        if (string.IsNullOrWhiteSpace(image)) return false;
        var s = image.Trim();

        string? digest = null;
        var at = s.IndexOf('@');
        if (at >= 0)
        {
            digest = s[(at + 1)..];
            s = s[..at];
            if (digest.Length == 0 || s.Length == 0) return false;
        }

        // A registry is the first path segment only if it looks like a host (has a '.' or ':' or is
        // "localhost") — otherwise the whole thing is a Docker-Hub-style repository (e.g. "library/nginx").
        string registry = DefaultRegistry;
        var firstSlash = s.IndexOf('/');
        if (firstSlash > 0)
        {
            var candidate = s[..firstSlash];
            if (candidate.Contains('.') || candidate.Contains(':') || candidate == "localhost")
            {
                registry = candidate;
                s = s[(firstSlash + 1)..];
            }
        }

        // A ':' after the last '/' is a tag; a ':' inside the registry host (port) was already split off.
        string? tag = null;
        var lastSlash = s.LastIndexOf('/');
        var colon = s.LastIndexOf(':');
        if (colon > lastSlash)
        {
            tag = s[(colon + 1)..];
            s = s[..colon];
            if (tag.Length == 0) return false;
        }

        if (s.Length == 0) return false;
        reference = new ImageReference(registry, s, tag, digest);
        return true;
    }

    public override string ToString()
    {
        var baseRef = $"{Registry}/{Repository}";
        if (Tag is not null) baseRef += $":{Tag}";
        if (Digest is not null) baseRef += $"@{Digest}";
        return baseRef;
    }

    /// <summary>This reference with a different tag and no digest (used to roll the deployment to a new tag).</summary>
    public string WithTag(string tag) => $"{Registry}/{Repository}:{tag}";
}
