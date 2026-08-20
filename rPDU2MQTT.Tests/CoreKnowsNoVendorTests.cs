using System.Reflection;
using rPDU2MQTT.Core.Flow;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Core does not know how to talk to anybody.
///
/// <para>
/// The whole point of the integration contracts is that a vendor's knowledge lives with that vendor: its
/// wire format, its query grammar, the way it names things. Core holds the seams — <c>IMeasurementHistory</c>,
/// <c>IFlowValueSource</c>, the flow graph — and the config model the GUI is generated from.
/// </para>
/// <para>
/// This drifted once already: PromQL syntax and two vendors' JSON parsers sat in <c>Core/Flow</c>, used by
/// nothing but the two Engine classes that speak those protocols. Left there, the next backend's parser
/// goes in beside them, and "add your vendor to Core" becomes the pattern the codebase teaches.
/// </para>
/// <para>
/// The config model is the deliberate exception: <c>PrometheusConfig</c> and <c>EmonCMSConfig</c> are what
/// an operator fills in, and the schema, the GUI form and the CRD are all generated from Core's types.
/// Naming a vendor's settings is not the same as knowing its protocol — and neither is carrying its
/// status, which is why the two DTOs below are listed rather than moved.
/// </para>
/// </summary>
public class CoreKnowsNoVendorTests
{
    private static readonly string[] Vendors = ["Prometheus", "EmonCms", "EmonCMS", "HomeAssistant", "Vertiv", "Influx"];

    /// <summary>
    /// Two status DTOs that name EmonCMS without knowing anything about how to talk to it: the outcome a
    /// process carries on its heartbeat and in the process registry. They are the pre-plugin world showing
    /// through — before <c>IntegrationStatus</c> existed, EmonCMS was the one integration a process
    /// reported by name — and generalising them means changing the diagnostics payload the GUI reads, which
    /// is its own change rather than a rider on this one. Listed here so they are a decision on the record
    /// and not an omission (ToDo item 27).
    /// </summary>
    private static readonly string[] KnownExceptions = ["rPDU2MQTT.Core.EmonCmsHealth", "rPDU2MQTT.Core.Diagnostics.EmonCmsReport"];

    [Fact]
    public void NoVendorNamedTypeLivesInCore_OutsideTheConfigModel()
    {
        var offenders = typeof(FlowGraphBuilder).Assembly.GetTypes()
            .Where(t => t.IsPublic || t.IsNestedPublic || t.IsNotPublic)
            .Where(t => !(t.Namespace ?? "").StartsWith("rPDU2MQTT.Models.Config", StringComparison.Ordinal))
            .Where(t => !(t.Namespace ?? "").StartsWith("rPDU2MQTT.Models.PDU", StringComparison.Ordinal))
            .Where(t => (t.Name.StartsWith('<') || t.DeclaringType is not null) == false)   // compiler-generated
            .Where(t => Vendors.Any(v => t.Name.Contains(v, StringComparison.Ordinal)))
            .Select(t => $"{t.Namespace}.{t.Name}")
            .Where(name => !KnownExceptions.Contains(name, StringComparer.Ordinal))
            .OrderBy(x => x, StringComparer.Ordinal)
            .ToList();

        Assert.True(offenders.Count == 0,
            "Core has learned a vendor's protocol again — move it next to that vendor's integration, "
          + "where the next backend can copy it instead of extending it:\n  " + string.Join("\n  ", offenders));
    }

    [Fact]
    public void CoreCarriesTheSeamsThoseVendorsImplement()
    {
        // The other half of the same rule: taking the vendors out must not take the contracts with them.
        var core = typeof(FlowGraphBuilder).Assembly;
        Assert.NotNull(core.GetType("rPDU2MQTT.Core.Flow.IMeasurementHistory"));
        Assert.NotNull(core.GetType("rPDU2MQTT.Core.Flow.IFlowValueSource"));
        Assert.NotNull(core.GetType("rPDU2MQTT.Core.Integrations.IIntegration"));
    }
}
