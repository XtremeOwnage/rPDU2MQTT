namespace rPDU2MQTT.Grains.Operator;

/// <summary>
/// Normalising and comparing OCI image digests, which reach us in several shapes.
/// <para>
/// A registry manifest digest is a bare <c>sha256:…</c>. A running pod's <c>ContainerStatus.ImageID</c>,
/// however, is a full pull reference — <c>ghcr.io/owner/repo@sha256:…</c>, sometimes prefixed
/// <c>docker-pullable://</c>. To decide whether the running image *is* what the registry now serves for a
/// moving tag, we compare only the <c>sha256:…</c> part, case-insensitively.
/// </para>
/// </summary>
public static class ImageDigest
{
    /// <summary>The <c>sha256:…</c> portion of a digest or an <c>image@sha256:…</c> reference, lower-cased; null if none.</summary>
    public static string? Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var i = value.IndexOf("sha256:", StringComparison.OrdinalIgnoreCase);
        return i >= 0 ? value[i..].Trim().ToLowerInvariant() : null;
    }

    /// <summary>True when both references carry the same digest. False if either is missing or unparseable.</summary>
    public static bool Equal(string? a, string? b)
    {
        var na = Normalize(a);
        var nb = Normalize(b);
        return na is not null && nb is not null && string.Equals(na, nb, StringComparison.Ordinal);
    }
}
