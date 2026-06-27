using rPDU2MQTT.Models.PDU;

namespace rPDU2MQTT.Core.Flow;

/// <summary>
/// Builds a <see cref="FlowGraph"/> from a PDU snapshot. Today the flow is auto-derived as
/// PDU → outlet, weighted by a per-outlet measurement (default <c>realpower</c>) — the structure that
/// can be read straight from the data. Richer multi-level / cross-source flows (circuits, transfer
/// switches, solar) come from the user-defined hierarchy (#129) layered onto this same model.
/// </summary>
public static class FlowGraphBuilder
{
    public const string DefaultMetric = "realpower";

    public static FlowGraph Build(PduData data, string metric = DefaultMetric)
    {
        var nodes = new List<FlowNode>();
        var links = new List<FlowLink>();
        var units = "";

        foreach (var device in data.Devices)
        {
            var pduId = $"pdu:{device.Entity_Name}";
            var pduHasFlow = false;

            foreach (var outlet in device.Outlets)
            {
                var m = outlet.Measurements.FirstOrDefault(x => string.Equals(x.Type, metric, StringComparison.OrdinalIgnoreCase));
                if (m is null || !double.TryParse(m.Value, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var value))
                    continue;
                if (value <= 0)
                    continue; // a Sankey only shows actual flow

                if (string.IsNullOrEmpty(units))
                    units = m.Units;

                var outletId = $"outlet:{device.Entity_Name}:{outlet.Key}";
                nodes.Add(new FlowNode(outletId, outlet.Entity_DisplayName, "outlet"));
                links.Add(new FlowLink(pduId, outletId, value));
                pduHasFlow = true;
            }

            // Only surface PDUs that actually have measured flow, so the diagram isn't cluttered with
            // idle/unmeasured devices.
            if (pduHasFlow)
                nodes.Insert(0, new FlowNode(pduId, device.Entity_DisplayName, "pdu"));
        }

        return new FlowGraph(nodes, links, metric, units);
    }
}
