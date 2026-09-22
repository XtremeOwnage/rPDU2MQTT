using rPDU2MQTT.Core.Plans;
using rPDU2MQTT.Models.Config;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>Floor plan images kept outside the configuration (#462): what is accepted, how it is named, where it goes.</summary>
public class PlanImageTests : IDisposable
{
    private readonly string dir = Path.Combine(Path.GetTempPath(), "plans-" + Guid.NewGuid().ToString("N"));

    public void Dispose() { if (Directory.Exists(dir)) Directory.Delete(dir, true); }

    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];

    private PlanImages Images(int mb = 10) => PlanImages.For(new PlanStorageConfig { Directory = dir, MaxMegabytes = mb });

    [Fact]
    public void TheFormat_IsReadFromTheBytes_NotTheName()
    {
        Assert.Equal(PlanImageFormat.Png, PlanImageFormat.Detect(Png));
        Assert.Equal(PlanImageFormat.Jpeg, PlanImageFormat.Detect([0xFF, 0xD8, 0xFF, 0xE0]));
        Assert.Equal(PlanImageFormat.Svg, PlanImageFormat.Detect("\n<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"u8));
        Assert.Null(PlanImageFormat.Detect("<html><body>hi</body></html>"u8));
        Assert.Null(PlanImageFormat.Detect("ftypheic"u8));
    }

    [Fact]
    public async Task AnImage_IsStoredUnderItsHash_AndReadBack()
    {
        var images = Images();

        var id = await images.SaveAsync(Png, default);
        var again = await images.SaveAsync(Png, default);

        Assert.Equal(id, again);
        Assert.True(PlanImages.IsId(id));
        Assert.EndsWith(".png", id);
        var back = await images.ReadAsync(id, default);
        Assert.Equal(Png, back!.Bytes);
        Assert.Equal("image/png", back.ContentType);
    }

    [Fact]
    public async Task AnythingOverTheLimit_OrNotAnImage_IsRefusedWithTheReason()
    {
        var images = Images(mb: 1);

        var big = new byte[2 * 1024 * 1024];
        Png.CopyTo(big, 0);
        var tooBig = await Assert.ThrowsAsync<PlanImageRejected>(() => images.SaveAsync(big, default));
        Assert.Contains("limit is 1 MB", tooBig.Message);

        var notImage = await Assert.ThrowsAsync<PlanImageRejected>(() => images.SaveAsync("hello"u8.ToArray(), default));
        Assert.Contains("PNG, JPEG, WebP or SVG", notImage.Message);
    }

    [Fact]
    public async Task AMissingImage_OrAPathForAnId_ReadsAsNothing()
    {
        var images = Images();

        Assert.Null(await images.ReadAsync("0123456789abcdef01234567.png", default));
        Assert.Null(await images.ReadAsync("../config.yaml", default));
        Assert.False(PlanImages.IsId("../../etc/passwd.png"));
    }

    [Fact]
    public void ABucket_TakesOverFromTheDirectory()
    {
        var images = PlanImages.For(new PlanStorageConfig
        {
            Directory = dir,
            ObjectStore = new PlanObjectStoreConfig { Endpoint = "http://minio:9000", Bucket = "house" },
        });

        Assert.IsType<S3PlanImageStore>(images.Store);
        Assert.Contains("house", images.Store.Describe);
    }

    private sealed class Memory : IPlanImageStore
    {
        public string Describe => "memory";
        public Task SaveAsync(string id, byte[] bytes, string contentType, CancellationToken ct) => Task.CompletedTask;
        public Task<PlanImage?> ReadAsync(string id, CancellationToken ct) => Task.FromResult<PlanImage?>(null);
        public Task DeleteAsync(string id, CancellationToken ct) => Task.CompletedTask;
    }

    [Fact]
    public void TheSharedCache_IsUsedOnlyWhenNoDirectoryOrBucketIsNamed()
    {
        var cache = new Memory();

        Assert.Same(cache, PlanImages.For(new PlanStorageConfig(), cache: cache).Store);
        Assert.False(PlanImages.For(new PlanStorageConfig(), cache: cache).Fallback);
        Assert.True(PlanImages.For(new PlanStorageConfig()).Fallback);
        Assert.False(PlanImages.For(new PlanStorageConfig { Directory = dir }).Fallback);
        Assert.IsType<DirectoryPlanImageStore>(PlanImages.For(new PlanStorageConfig { Directory = dir }, cache: cache).Store);
    }

    /// <summary>The worked example in the AWS documentation for signing a GET Object request.</summary>
    [Fact]
    public void TheSignature_MatchesAwsWorkedExample()
    {
        var headers = new Dictionary<string, string>
        {
            ["host"] = "examplebucket.s3.amazonaws.com",
            ["range"] = "bytes=0-9",
            ["x-amz-content-sha256"] = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ["x-amz-date"] = "20130524T000000Z",
        };

        var auth = SigV4.Authorization("GET", "/test.txt", "", headers, headers["x-amz-content-sha256"],
            "us-east-1", "s3", "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");

        Assert.Equal("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
            + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
            + "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41", auth);
    }
}
