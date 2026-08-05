using rPDU2MQTT.Core;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// A publish that is never acknowledged must not wedge the service — and abandoning it must not take the
/// connection down with it, which is exactly what the first attempt at this did on a live system.
/// </summary>
public class PublishTimeoutTests
{
    private static readonly TimeSpan Short = TimeSpan.FromMilliseconds(120);

    [Fact]
    public async Task AnUnacknowledgedPublish_TimesOutInsteadOfHangingForever()
    {
        var hang = new TaskCompletionSource();

        var ex = await Assert.ThrowsAsync<TimeoutException>(
            () => PublishTimeout.RunAsync(() => hang.Task, Short, "Rack_PDU/pdu_1/outlets/3/state"));

        // The topic is the actionable part: it says which publish, and therefore which ACL to look at.
        Assert.Contains("Rack_PDU/pdu_1/outlets/3/state", ex.Message);
        hang.SetResult();
    }

    [Fact]
    public async Task TheAbandonedPublishIsNeverCancelled()
    {
        // The regression that took a live broker connection down. Cancelling a HiveMQtt publish mid-flight
        // tears the connection apart, turning "not acknowledging" into "disconnected" — strictly worse. The
        // token handed to the publish is the caller's, and timing out must leave it untouched.
        var caller = new CancellationTokenSource();
        var observed = false;
        var hang = new TaskCompletionSource();

        Task Publish()
        {
            caller.Token.Register(() => observed = true);
            return hang.Task;
        }

        await Assert.ThrowsAsync<TimeoutException>(() => PublishTimeout.RunAsync(Publish, Short, "t", caller.Token));

        Assert.False(observed, "the publish's token was cancelled — that is what killed the connection before");
        Assert.False(caller.IsCancellationRequested);
        hang.SetResult();
    }

    [Fact]
    public async Task APublishThatCompletesInTime_JustReturns()
    {
        await PublishTimeout.RunAsync(() => Task.CompletedTask, TimeSpan.FromSeconds(30), "t");
    }

    [Fact]
    public async Task ARealPublishFailure_StillSurfaces()
    {
        // Timing out must not swallow the ordinary case: a broker that actively refuses should report its
        // own error, not a timeout, and not silence.
        var ex = await Assert.ThrowsAsync<InvalidOperationException>(
            () => PublishTimeout.RunAsync(() => Task.FromException(new InvalidOperationException("refused")),
                                          TimeSpan.FromSeconds(30), "t"));
        Assert.Equal("refused", ex.Message);
    }

    [Fact]
    public async Task ShuttingDown_IsNotReportedAsABrokerTimeout()
    {
        // Cancelling on shutdown is not the broker's fault and must not be logged as one — otherwise every
        // restart leaves a misleading "the broker did not acknowledge" in the log.
        //
        // The timeout is minutes and the cancellation is immediate, so the wait can only end one way. Racing
        // the two on the clock (cancel at 50ms, time out at 80ms) is what an earlier version of this test did,
        // and it failed roughly one run in five: under load the 80ms timer fired before the 50ms cancellation
        // callback was scheduled, and reporting a timeout there is the correct answer, not a bug.
        var shutdown = new CancellationTokenSource();
        var hang = new TaskCompletionSource();

        var run = PublishTimeout.RunAsync(() => hang.Task, TimeSpan.FromMinutes(5), "t", shutdown.Token);
        shutdown.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);

        hang.SetResult();
    }

    [Fact]
    public async Task AFastPublish_DoesNotLeaveTheTimerPendingForTheWholeTimeout()
    {
        // The delay is cancelled on success; without that, a 15s timeout would keep a timer alive for every
        // message published — hundreds per pass.
        var started = DateTime.UtcNow;
        await PublishTimeout.RunAsync(() => Task.CompletedTask, TimeSpan.FromSeconds(30), "t");
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(1));
    }
}
