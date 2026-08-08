using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Reading ages survive being merged.
///
/// <para>
/// The Node Data page exists to tell a dead publisher from a binding that was never right, which it does by
/// asking the API when each reading arrived. The API asks the live source for those diagnostics — and the
/// live source is always a <see cref="CompositeFlowValueSource"/>, which did not offer them. Every row on
/// the page read "— / never" in every deployment, while the diagram beside it drew those same values
/// perfectly, because the diagram only needs <see cref="IFlowValueSource.TryGetValue"/>.
/// </para>
/// </summary>
public class CompositeDiagnosticsTests
{
    private sealed class Plain : IFlowValueSource
    {
        public bool TryGetValue(string node, string metric, out double value) { value = 7; return node == "derived"; }
    }

    private static FlowValueCache Cache(string node, string metric, double value)
    {
        var c = new FlowValueCache();
        c.Set(node, metric, value, 120, DateTime.UtcNow);
        return c;
    }

    [Fact]
    public void TheCompositeReportsWhatItsSourcesKnow()
    {
        var composite = new CompositeFlowValueSource(new Plain(), Cache("solar", "realpower", 4237));

        Assert.True(((IFlowValueDiagnostics)composite).TryDescribe("solar", "realpower", out var reading));
        Assert.Equal(4237, reading.Value);
        Assert.True(reading.Fresh);
    }

    [Fact]
    public void ASourceWithNoDiagnosticsIsSkipped_NotFatal()
    {
        // A source that cannot date its readings is under no obligation to — that is why the interface is
        // separate. It must not stop the ones that can from answering.
        var composite = new CompositeFlowValueSource(new Plain(), Cache("solar", "realpower", 1));

        Assert.False(((IFlowValueDiagnostics)composite).TryDescribe("derived", "realpower", out _));
        Assert.True(((IFlowValueDiagnostics)composite).TryDescribe("solar", "realpower", out _));
    }

    [Fact]
    public void EveryReportingKeyIsListedOnce()
    {
        var composite = new CompositeFlowValueSource(Cache("solar", "realpower", 1), Cache("solar", "realpower", 2), Cache("grid", "energy", 3));

        var keys = ((IFlowValueDiagnostics)composite).ReportedKeys;

        Assert.Equal(2, keys.Count);
        Assert.Contains(("solar", "realpower"), keys);
        Assert.Contains(("grid", "energy"), keys);
    }

    [Fact]
    public void TheLiveSourceTheGuiIsGivenCanBeAsked()
    {
        // The bug was structural: the GUI's source is a composite, so the page's whole reason for existing
        // depended on the composite offering this.
        Assert.True(typeof(IFlowValueDiagnostics).IsAssignableFrom(typeof(CompositeFlowValueSource)));
    }
}
