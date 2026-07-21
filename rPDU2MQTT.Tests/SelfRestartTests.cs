using rPDU2MQTT.Core;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// #192: a process that stops in order to be restarted must not exit 0. Exit 0 means "the job is done" —
/// it's what leaves a Kubernetes pod sitting in Completed, and it makes a deliberate restart look identical
/// to a clean finish in any log or dashboard.
/// </summary>
[Collection("SelfRestart")]
public class SelfRestartTests
{
    [Fact]
    public void CleanShutdown_IsZero_RestartIsNot()
    {
        Assert.Equal(0, SelfRestart.ExitCodeFor(restartRequested: false));
        Assert.Equal(75, SelfRestart.ExitCodeFor(restartRequested: true));

        // 75 is the BSD EX_TEMPFAIL — "temporary failure, retry" — which is exactly the intent.
        Assert.Equal(75, SelfRestart.ExitCode);
    }

    [Fact]
    public void Marking_RecordsTheIntent_AndTheReason()
    {
        SelfRestart.Clear();
        Assert.False(SelfRestart.Requested);
        Assert.Equal(0, SelfRestart.ExitCodeFor(SelfRestart.Requested));

        SelfRestart.Mark("GUI request");

        Assert.True(SelfRestart.Requested);
        Assert.Equal("GUI request", SelfRestart.Reason);
        Assert.Equal(SelfRestart.ExitCode, SelfRestart.ExitCodeFor(SelfRestart.Requested));

        SelfRestart.Clear();
    }
}
