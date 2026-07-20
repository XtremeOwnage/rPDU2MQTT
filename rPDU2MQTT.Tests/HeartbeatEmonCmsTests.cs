using System.Text.Json;
using rPDU2MQTT.Services;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// EmonCMS export health is carried on a process's registration (v3: the ProcessRegistryGrain) so a split
/// API/UI node shows the worker's true export state. These lock the status shape the board reads.
/// </summary>
public class HeartbeatEmonCmsTests
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    [Fact]
    public void EmonCmsStatus_Snapshot_UsesTheFieldNamesTheBoardReads()
    {
        var status = new EmonCmsStatus();
        status.RecordSuccess(5);

        using var doc = JsonSerializer.SerializeToDocument(status.Snapshot(), Web);
        var root = doc.RootElement;

        Assert.True(root.GetProperty("ok").GetBoolean());
        Assert.Equal(5, root.GetProperty("count").GetInt32());
        Assert.True(root.TryGetProperty("lastSuccessUtc", out _));
        Assert.True(status.HasAttempted);
    }

    [Fact]
    public void EmonCmsStatus_HasNotAttempted_BeforeAnyExport() => Assert.False(new EmonCmsStatus().HasAttempted);
}
