using rPDU2MQTT.Core.Flow;
using rPDU2MQTT.NodeTemplates;
using Xunit;

namespace rPDU2MQTT.Tests;

/// <summary>
/// Guards the built-in device templates so an importable template always produces a valid, wireable set of
/// energy-flow nodes/sources — the same rules the GUI and the Modbus/flow pipeline enforce.
/// </summary>
public class NodeTemplateCatalogTests
{
    private static readonly HashSet<string> Kinds = new() { "node", "panel", "inverter", "battery", "solar", "grid", "load" };
    private static readonly HashSet<string> Metrics = new() { "realpower", "apparentpower", "energy", "current", "voltage", "frequency", "powerfactor" };
    private static readonly HashSet<string> RegisterTypes = new() { "holding", "input" };
    private static readonly HashSet<string> DataTypes = new() { "uint16", "int16", "uint32", "int32", "float32" };
    private static readonly HashSet<string> WordOrders = new() { "big", "little" };

    [Fact]
    public void Catalogue_IsNotEmpty_AndIdsAreUnique()
    {
        Assert.NotEmpty(NodeTemplateCatalog.All);
        var ids = NodeTemplateCatalog.All.Select(t => t.Id).ToList();
        Assert.Equal(ids.Count, ids.Distinct().Count());
    }

    [Fact]
    public void Eg4FlexBoss21_IsPresent()
        => Assert.Contains(NodeTemplateCatalog.All, t => t.Id == "eg4-flexboss21");

    [Theory]
    [MemberData(nameof(Templates))]
    public void Template_IsStructurallyValid(NodeTemplate t)
    {
        Assert.False(string.IsNullOrWhiteSpace(t.Id));
        Assert.False(string.IsNullOrWhiteSpace(t.Name));
        Assert.True(t.Transport is NodeTemplate.ModbusTransport or NodeTemplate.MqttTransport);
        Assert.NotEmpty(t.Nodes);

        // Modbus devices must define a connection to create; MQTT devices must not.
        if (t.Transport == NodeTemplate.ModbusTransport) Assert.NotNull(t.Modbus);

        var keys = t.Nodes.Select(n => n.Key).ToList();
        Assert.Equal(keys.Count, keys.Distinct().Count());          // node keys unique within a template
        var keySet = keys.ToHashSet();

        foreach (var node in t.Nodes)
        {
            Assert.False(string.IsNullOrWhiteSpace(node.Key));
            Assert.Contains(node.Kind, Kinds);
            if (node.FeedsKey is not null) Assert.Contains(node.FeedsKey, keySet);   // links resolve internally

            // The flow cache holds one value per (node, metric) — a template must not bind a metric twice.
            var metrics = node.Sources.Select(s => s.Metric).ToList();
            Assert.Equal(metrics.Count, metrics.Distinct().Count());

            foreach (var s in node.Sources)
            {
                Assert.Contains(s.Metric, Metrics);
                // A declared unit must be convertible to the metric's canonical unit, else ingest silently no-ops it.
                if (!string.IsNullOrWhiteSpace(s.Unit))
                    Assert.Contains(s.Unit, FlowUnits.UnitsFor(s.Metric));

                if (t.Transport == NodeTemplate.ModbusTransport)
                {
                    Assert.Contains(s.RegisterType, RegisterTypes);
                    Assert.Contains(s.DataType, DataTypes);
                    Assert.Contains(s.WordOrder, WordOrders);
                    Assert.True(s.Register >= 0);
                }
            }
        }
    }

    public static IEnumerable<object[]> Templates() => NodeTemplateCatalog.All.Select(t => new object[] { t });
}
