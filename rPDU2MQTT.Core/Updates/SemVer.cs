using System.Diagnostics.CodeAnalysis;

namespace rPDU2MQTT.Updates;

/// <summary>
/// A minimal semantic version (<c>MAJOR.MINOR.PATCH</c> with an optional pre-release suffix) — just enough
/// to compare release image tags for the operator's update check (#210). A leading <c>v</c> is tolerated.
/// Build metadata (<c>+…</c>) is ignored for comparison, matching SemVer. Anything that isn't a clean
/// numeric version (e.g. moving channel tags like <c>stable</c>/<c>edge</c>) fails to parse.
/// </summary>
public sealed record SemVer(int Major, int Minor, int Patch, string? PreRelease = null) : IComparable<SemVer>
{
    /// <summary>True when this is a pre-release (e.g. <c>1.2.3-beta.1</c>), which the update check skips.</summary>
    public bool IsPreRelease => !string.IsNullOrEmpty(PreRelease);

    public static bool TryParse([NotNullWhen(true)] string? tag, [NotNullWhen(true)] out SemVer? version)
    {
        version = null;
        if (string.IsNullOrWhiteSpace(tag)) return false;

        var s = tag.Trim();
        if (s.StartsWith('v') || s.StartsWith('V')) s = s[1..];

        // Drop build metadata; keep the pre-release for ordering.
        var plus = s.IndexOf('+');
        if (plus >= 0) s = s[..plus];

        string? pre = null;
        var dash = s.IndexOf('-');
        if (dash >= 0)
        {
            pre = s[(dash + 1)..];
            s = s[..dash];
            if (pre.Length == 0) return false;
        }

        var parts = s.Split('.');
        if (parts.Length is < 1 or > 3) return false;

        var nums = new int[3];
        for (int i = 0; i < 3; i++)
        {
            if (i >= parts.Length) { nums[i] = 0; continue; }
            if (!int.TryParse(parts[i], out var n) || n < 0) return false;
            nums[i] = n;
        }

        version = new SemVer(nums[0], nums[1], nums[2], pre);
        return true;
    }

    public int CompareTo(SemVer? other)
    {
        if (other is null) return 1;
        var c = Major.CompareTo(other.Major);
        if (c != 0) return c;
        c = Minor.CompareTo(other.Minor);
        if (c != 0) return c;
        c = Patch.CompareTo(other.Patch);
        if (c != 0) return c;

        // A release outranks a pre-release of the same core version (1.2.3 > 1.2.3-rc.1).
        if (IsPreRelease && !other.IsPreRelease) return -1;
        if (!IsPreRelease && other.IsPreRelease) return 1;
        return string.CompareOrdinal(PreRelease ?? "", other.PreRelease ?? "");
    }

    public override string ToString() =>
        IsPreRelease ? $"{Major}.{Minor}.{Patch}-{PreRelease}" : $"{Major}.{Minor}.{Patch}";
}
