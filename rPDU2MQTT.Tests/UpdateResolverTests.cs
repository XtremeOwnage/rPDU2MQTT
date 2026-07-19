using rPDU2MQTT.Updates;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>The operator's version math (#210): SemVer parsing/ordering, image-ref parsing, and the
/// pure update resolver that decides the newest eligible release under a policy.</summary>
public class UpdateResolverTests
{
    // ---- SemVer ----

    [Theory]
    [InlineData("1.2.3", 1, 2, 3)]
    [InlineData("v1.2.3", 1, 2, 3)]
    [InlineData("1.2", 1, 2, 0)]
    [InlineData("1", 1, 0, 0)]
    [InlineData("1.2.3+abc1234", 1, 2, 3)]
    public void SemVer_ParsesReleaseVersions(string tag, int major, int minor, int patch)
    {
        Assert.True(SemVer.TryParse(tag, out var v));
        Assert.Equal((major, minor, patch), (v.Major, v.Minor, v.Patch));
        Assert.False(v.IsPreRelease);
    }

    [Theory]
    [InlineData("stable")]
    [InlineData("edge")]
    [InlineData("latest")]
    [InlineData("")]
    [InlineData(null)]
    [InlineData("1.2.3.4")]
    [InlineData("1.x")]
    public void SemVer_RejectsNonVersions(string? tag) => Assert.False(SemVer.TryParse(tag, out _));

    [Fact]
    public void SemVer_MarksPreRelease()
    {
        Assert.True(SemVer.TryParse("1.2.3-rc.1", out var v));
        Assert.True(v.IsPreRelease);
    }

    [Fact]
    public void SemVer_OrdersCorrectly()
    {
        SemVer.TryParse("1.2.3", out var a);
        SemVer.TryParse("1.10.0", out var b);
        SemVer.TryParse("2.0.0", out var c);
        SemVer.TryParse("1.2.3-rc.1", out var pre);

        Assert.True(a!.CompareTo(b!) < 0);            // 1.2.3 < 1.10.0 (numeric, not lexical)
        Assert.True(b!.CompareTo(c!) < 0);            // 1.10.0 < 2.0.0
        Assert.True(pre!.CompareTo(a!) < 0);          // 1.2.3-rc.1 < 1.2.3 (pre-release outranked by release)
    }

    // ---- ImageReference ----

    [Fact]
    public void ImageReference_ParsesRegistryRepoTag()
    {
        Assert.True(ImageReference.TryParse("ghcr.io/xtremeownage/rpdu2mqtt:1.2.3", out var r));
        Assert.Equal("ghcr.io", r.Registry);
        Assert.Equal("xtremeownage/rpdu2mqtt", r.Repository);
        Assert.Equal("1.2.3", r.Tag);
        Assert.Equal("ghcr.io/xtremeownage/rpdu2mqtt:1.5.0", r.WithTag("1.5.0"));
    }

    [Fact]
    public void ImageReference_DefaultsRegistryForBareRepo()
    {
        Assert.True(ImageReference.TryParse("library/nginx:1.25", out var r));
        Assert.Equal(ImageReference.DefaultRegistry, r.Registry);
        Assert.Equal("library/nginx", r.Repository);
        Assert.Equal("registry-1.docker.io", r.RegistryHost);
    }

    [Fact]
    public void ImageReference_ParsesDigest()
    {
        Assert.True(ImageReference.TryParse("ghcr.io/x/y@sha256:abc", out var r));
        Assert.Equal("sha256:abc", r.Digest);
        Assert.Null(r.Tag);
    }

    // ---- UpdateResolver ----

    private static readonly string[] Catalogue =
        { "1.0.0", "1.1.0", "1.2.0", "1.2.3", "2.0.0", "2.1.0", "stable", "edge", "2.2.0-rc.1" };

    [Fact]
    public void Resolve_Minor_StaysOnSameMajor()
    {
        var check = UpdateResolver.Resolve("1.1.0", Catalogue, UpdatePolicy.Minor);
        Assert.True(check.UpdateAvailable);
        Assert.Equal("1.2.3", check.Latest!.ToString());     // newest 1.x, not 2.x
    }

    [Fact]
    public void Resolve_Patch_StaysOnSameMinor()
    {
        var check = UpdateResolver.Resolve("1.2.0", Catalogue, UpdatePolicy.Patch);
        Assert.True(check.UpdateAvailable);
        Assert.Equal("1.2.3", check.Latest!.ToString());     // 1.2.x only
    }

    [Fact]
    public void Resolve_Major_TakesNewestRelease()
    {
        var check = UpdateResolver.Resolve("1.2.3", Catalogue, UpdatePolicy.Major);
        Assert.True(check.UpdateAvailable);
        Assert.Equal("2.1.0", check.Latest!.ToString());     // skips the 2.2.0-rc.1 pre-release
    }

    [Fact]
    public void Resolve_ReportsUpToDate_WhenAlreadyNewest()
    {
        var check = UpdateResolver.Resolve("2.1.0", Catalogue, UpdatePolicy.Major);
        Assert.True(check.Applicable);
        Assert.False(check.UpdateAvailable);
        Assert.Equal("2.1.0", check.Latest!.ToString());
    }

    [Fact]
    public void Resolve_NotApplicable_ForMovingChannelTag()
    {
        var check = UpdateResolver.Resolve("stable", Catalogue, UpdatePolicy.Minor);
        Assert.False(check.Applicable);
        Assert.False(check.UpdateAvailable);
    }

    [Fact]
    public void Resolve_NeverSelectsPreRelease()
    {
        var check = UpdateResolver.Resolve("2.1.0", new[] { "2.2.0-rc.1", "2.1.5" }, UpdatePolicy.Minor);
        Assert.Equal("2.1.5", check.Latest!.ToString());
    }
}
