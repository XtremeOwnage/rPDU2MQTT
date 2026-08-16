using rPDU2MQTT.Classes;
using rPDU2MQTT.Core.Integrations;
using rPDU2MQTT.Models.PDU;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A device supplied by a plugin, and the reader seam that lets the supervising grain poll it exactly as it
/// polls the built-in one — the inversion that makes a second make of hardware equal to the first.
/// </summary>
public class DeviceContractTests
{
    private sealed class FakeDevice : IIntegration, IDeviceSourcePlugin, IDeviceControlPlugin
    {
        public string Id => "fake-device";
        public string DisplayName => "Fake Device";
        public IntegrationGroup Group => IntegrationGroup.Sources;
        public bool Enabled(Config cfg) => true;

        public string InstanceId => "fake";
        public int Polls;
        public PduData? Next = Build(77);
        public Exception? Throws;
        public readonly Dictionary<int, string> State = new() { [0] = "on", [1] = "on" };

        public Task<PduData?> PollAsync(Config cfg, CancellationToken ct)
        {
            Polls++;
            if (Throws is not null) return Task.FromException<PduData?>(Throws);
            return Task.FromResult(Next);
        }

        public bool Supports(string action) => action is "on" or "off";

        public Task<string> ControlOutletAsync(Config cfg, string deviceId, int outletIndex, string action, CancellationToken ct)
        {
            State[outletIndex] = action;
            return Task.FromResult(action);
        }

        public static PduData Build(double watts)
        {
            var outlet = new Outlet { Key = 0, Entity_Name = "o0", Entity_DisplayName = "Fake Outlet" };
            outlet.Measurements.Add(new Measurement { Type = "realpower", Value = watts.ToString(), Units = "W" });
            var device = new Device { Key = "f", Entity_Name = "fake_device", Entity_DisplayName = "Fake" };
            device.Outlets.Add(outlet);
            var data = new PduData();
            data.Devices.Add(device);
            return data;
        }
    }

    [Fact]
    public async Task ThePluginReaderOwnsExactlyItsOwnInstance()
    {
        // The grain asks who handles its key. A reader claiming an instance it does not own would poll
        // someone else's hardware through someone else's client.
        var device = new FakeDevice();
        var reader = new PluginDeviceReader([device]);
        var cfg = new Config();

        Assert.True(reader.Handles("fake", cfg));
        Assert.True(reader.Handles("FAKE", cfg));      // instance ids are matched case-insensitively
        Assert.False(reader.Handles("default", cfg));  // a configured Vertiv PDU is not its business

        var data = await reader.ReadAsync("fake", cfg, CancellationToken.None);
        Assert.Equal(1, device.Polls);
        Assert.Single(data!.Devices);
    }

    [Fact]
    public async Task ReadingAnInstanceItDoesNotOwn_ReturnsNothing_RatherThanGuessing()
    {
        var reader = new PluginDeviceReader([new FakeDevice()]);
        Assert.Null(await reader.ReadAsync("someone-else", new Config(), CancellationToken.None));
    }

    [Fact]
    public void EveryPluginDeviceIsAdvertised_SoTheActivatorCanDriveIt()
    {
        // A device nothing drives is a device that never polls, which downstream is indistinguishable from
        // one that is broken. The activator and the sync service both read this list.
        var reader = new PluginDeviceReader([new FakeDevice()]);
        Assert.Equal(["fake"], reader.InstanceIds);
    }

    [Fact]
    public async Task ADeviceThatReturnsNothing_IsNotADeviceReadingZero()
    {
        // Null means "nothing to report", and the previous snapshot is left to go stale on its own. An
        // empty PduData would read downstream as every outlet having gone to zero — a reading nobody took.
        var device = new FakeDevice { Next = null };
        var reader = new PluginDeviceReader([device]);

        Assert.Null(await reader.ReadAsync("fake", new Config(), CancellationToken.None));
        Assert.Equal(1, device.Polls);
    }

    [Fact]
    public async Task AFailedPollThrows_SoTheHostCanReportItAgainstTheRightIntegration()
    {
        var device = new FakeDevice { Throws = new HttpRequestException("no route to host") };
        var reader = new PluginDeviceReader([device]);

        await Assert.ThrowsAsync<HttpRequestException>(
            () => reader.ReadAsync("fake", new Config(), CancellationToken.None));
    }

    [Fact]
    public async Task ADeviceThatCanSwitch_ReportsWhatHappened_NotWhatWasAsked()
    {
        // An echo that contradicts the next poll makes an outlet appear to flip back on its own.
        var device = new FakeDevice();
        var result = await device.ControlOutletAsync(new Config(), "fake", 1, "off", CancellationToken.None);

        Assert.Equal("off", result);
        Assert.Equal("off", device.State[1]);
        Assert.Equal("on", device.State[0]);   // and nothing else moved
    }

    [Fact]
    public void ADeviceDeclaresWhatItCanDo_SoTheGuiNeverOffersAButtonThatCannotWork()
    {
        var device = new FakeDevice();

        Assert.True(device.Supports("on"));
        Assert.False(device.Supports("reboot"));
    }

    [Fact]
    public void TheReaderUsesThePluginsOwnInterval()
    {
        // Devices age differently: a five-minute poller must not be driven at a thirty-second cadence
        // just because something else on the fleet is.
        var reader = new PluginDeviceReader([new SlowDevice()]);
        Assert.Equal(TimeSpan.FromMinutes(5), reader.Interval("slow", new Config()));
    }

    private sealed class SlowDevice : IIntegration, IDeviceSourcePlugin
    {
        public string Id => "slow";
        public string DisplayName => "Slow";
        public IntegrationGroup Group => IntegrationGroup.Sources;
        public bool Enabled(Config cfg) => true;
        public string InstanceId => "slow";
        public TimeSpan PollInterval(Config cfg) => TimeSpan.FromMinutes(5);
        public Task<PduData?> PollAsync(Config cfg, CancellationToken ct) => Task.FromResult<PduData?>(null);
    }
}
