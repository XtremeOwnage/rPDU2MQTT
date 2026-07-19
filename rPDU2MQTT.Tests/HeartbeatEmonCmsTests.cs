using System.Text.Json;
using rPDU2MQTT.Core;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A split API/UI node shows the worker's EmonCMS export health by reading it off the worker's heartbeat.
/// These lock the wire contract that carries it across processes.
/// </summary>
public class HeartbeatEmonCmsTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    [Fact]
    public void Heartbeat_RoundTrips_WithEmonCmsHealth()
    {
        var health = new EmonCmsHealth(Ok: true, LastAttemptUtc: DateTime.UtcNow, LastSuccessUtc: DateTime.UtcNow, LastError: null, Count: 12);
        var beat = new Heartbeat("worker-x", new[] { "worker" }, "host", DateTime.UtcNow, DateTime.UtcNow, "1.0.0", health);

        var back = JsonSerializer.Deserialize<Heartbeat>(JsonSerializer.Serialize(beat, Web), Web);

        Assert.NotNull(back!.EmonCms);
        Assert.True(back.EmonCms!.Ok);
        Assert.Equal(12, back.EmonCms.Count);
    }

    [Fact]
    public void Heartbeat_WithoutEmonCms_DeserializesToNull()
    {
        // Older/other-role heartbeats carry no EmonCms; the field must stay optional.
        var beat = new Heartbeat("ui-x", new[] { "ui" }, "host", DateTime.UtcNow, DateTime.UtcNow, "1.0.0");
        var back = JsonSerializer.Deserialize<Heartbeat>(JsonSerializer.Serialize(beat, Web), Web);
        Assert.Null(back!.EmonCms);
    }

    [Fact]
    public void EmonCmsStatus_Snapshot_UsesTheFieldNamesTheBoardReads()
    {
        var status = new EmonCmsStatus();
        status.RecordSuccess(5);

        using var doc = JsonSerializer.SerializeToDocument(status.Snapshot(), Web);
        var root = doc.RootElement;

        // home.ts / diagnostics.ts read these exact keys.
        Assert.True(root.GetProperty("ok").GetBoolean());
        Assert.Equal(5, root.GetProperty("count").GetInt32());
        Assert.True(root.TryGetProperty("lastSuccessUtc", out _));
        Assert.True(status.HasAttempted);
    }

    [Fact]
    public void EmonCmsStatus_HasNotAttempted_BeforeAnyExport() => Assert.False(new EmonCmsStatus().HasAttempted);
}
