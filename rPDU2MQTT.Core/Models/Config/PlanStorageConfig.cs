using System.ComponentModel;
using YamlDotNet.Serialization;

namespace rPDU2MQTT.Models.Config;

/// <summary>Where floor plan images are kept: a directory, or an S3-compatible object store (#462). Never the configuration.</summary>
public class PlanStorageConfig
{
    [Description("Directory floor plan images are written to. Put it on a persistent volume: a PVC on Kubernetes, a volume under Docker Compose, any directory for a plain binary. Blank uses 'plans' beside the program, which a container loses on restart. Ignored when an object store bucket is set.")]
    public string Directory { get; set; } = "";

    [Range(1, 100, ErrorMessage = "The size limit must be between 1 and 100 MB.")]
    [DefaultValue(10)]
    [Description("Largest image accepted, in megabytes. A phone photo is shrunk in the browser before it is sent, so this is rarely reached.")]
    public int MaxMegabytes { get; set; } = 10;

    [Description("An S3-compatible object store (AWS S3, MinIO, Ceph, Garage, R2) to keep images in instead of a directory.")]
    public PlanObjectStoreConfig ObjectStore { get; set; } = new();
}

/// <summary>An S3-compatible bucket for floor plan images (#462).</summary>
public class PlanObjectStoreConfig
{
    [Description("The store's endpoint, for example 'https://s3.us-east-1.amazonaws.com' or 'http://minio:9000'.")]
    public string Endpoint { get; set; } = "";

    [Description("The bucket images are kept in. Setting it switches plan storage from the directory to this store.")]
    public string Bucket { get; set; } = "";

    [DefaultValue("us-east-1")]
    [Description("The region requests are signed for. Most self-hosted stores accept 'us-east-1'.")]
    public string Region { get; set; } = "us-east-1";

    [Description("Access key id.")]
    public string AccessKeyId { get; set; } = "";

    [YamlMember(DefaultValuesHandling = DefaultValuesHandling.OmitNull)]
    [Description("Secret access key.")]
    public string? SecretAccessKey { get; set; }

    [DefaultValue("floorplans/")]
    [Description("Prefix for every object this bridge writes, so it can share a bucket.")]
    public string Prefix { get; set; } = "floorplans/";

    [DefaultValue(true)]
    [Description("Address the bucket as a path ('endpoint/bucket/key') rather than a subdomain. Self-hosted stores almost always need this on.")]
    public bool PathStyle { get; set; } = true;

    /// <summary>A bucket and an endpoint are both set, so images go to the store rather than the directory.</summary>
    public bool IsEnabled() => !string.IsNullOrWhiteSpace(Bucket) && !string.IsNullOrWhiteSpace(Endpoint);
}
