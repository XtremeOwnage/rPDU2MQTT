using System.Text.Json;
using rPDU2MQTT.Models.PDU.OneView;
using Xunit;

namespace rPDU2MQTT.Tests;

public class OneViewGroupTests
{
    // The "Total" group exposes its rollup as pduTotal, keyed like outlet ({"0": {...}}).
    // It must deserialize into a list with its measurements (previously it was silently dropped).
    [Fact]
    public void PduTotal_DeserializesAsListWithMeasurements()
    {
        const string json = """
        {
          "pduTotal": {
            "0": {
              "name": "outlet",
              "measurement": {
                "3": { "type": "energy", "units": "kWh", "sumValue": "8909.927" },
                "0": { "type": "realPower", "units": "W", "sumValue": "564" }
              }
            }
          }
        }
        """;

        var entities = JsonSerializer.Deserialize<OneViewGroupEntities>(json);

        Assert.NotNull(entities);
        var total = Assert.Single(entities!.PduTotal);
        Assert.Equal(2, total.Measurements.Count);
        Assert.Contains(total.Measurements, m => m.Type == "energy" && m.SumValue == "8909.927");
        Assert.Contains(total.Measurements, m => m.Type == "realPower" && m.Units == "W");
    }

    [Fact]
    public void Outlet_AggregateStillDeserializes()
    {
        const string json = """
        { "outlet": { "0": { "name": "outlet", "measurement": { "3": { "type": "energy", "units": "kWh", "sumValue": "2573.487" } } } } }
        """;

        var entities = JsonSerializer.Deserialize<OneViewGroupEntities>(json);

        Assert.NotNull(entities);
        var outlet = Assert.Single(entities!.Outlets);
        Assert.Equal("energy", Assert.Single(outlet.Measurements).Type);
        Assert.Empty(entities.PduTotal);
    }
}
