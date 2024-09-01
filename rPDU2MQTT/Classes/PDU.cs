using Microsoft.Extensions.Logging;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using rPDU2MQTT.Models.PDUResponse;
using System.Net.Http.Json;

namespace rPDU2MQTT.Classes;

public partial class PDU
{
    private readonly Config config;
    private readonly HttpClient http;
    private readonly ILogger<PDU> log;

    public PDU(Config config, HttpClient http, ILogger<PDU> log)
    {
        this.config = config;
        this.http = http;
        this.log = log;
    }

    /// <summary>
    /// Pull all public data.
    /// </summary>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    public async Task<RootData> GetRootData_Public(CancellationToken cancellationToken)
    {
        log.LogDebug("Querying /api");
        var model = await http.GetFromJsonAsync<GetResponse<RootData>>("/api", options: Models.PDU.Converter.Settings, cancellationToken);
        log.LogDebug($"Query response {model.RetCode}");

        //Process device data.
        processData(model.Data);

        return model.Data;
    }

    public void processData(RootData data)
    {
        //Set basic details.
        data.Record_Parent = null;
        data.Record_Key = config.MQTT.ParentTopic;
        data.URL = http.BaseAddress.ToString();

        data.Entity_Identifier = Coalesce(config.Overrides?.PDU?.ID, "rPDU2MQTT")!;
        data.Entity_Name = data.Entity_DisplayName = Coalesce(config.Overrides?.PDU?.Name, data.Sys.Label, data.Sys.Name, "rPDU2MQTT")!;

        // Propagate down the parent, and identifier.
        data.Devices.SetParentAndIdentifier(data, (k, v) => k);

        //Process devices
        processDevices(data.Devices);
    }

    private void processDevices(Dictionary<string, Device> devices)
    {
        //devices.SetEntityNameAndEnabled(config.Overrides, null, null);
        foreach (var (key, device) in devices)
        {
            // Propagate down the parent, and identifier.
            device.Entity.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Entity), (k, v) => k);
            device.Outlets.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Outlets), (k, v) => k.ToString());

            // Set Overrides
            device.Outlets.SetEntityNameAndEnabled(config.Overrides, DefaultNames.UseEntityName, DefaultNames.UseEntityLabel);
            device.Entity.SetEntityNameAndEnabled(config.Overrides, DefaultNames.UseEntityName, DefaultNames.UseEntityLabel);

            // Prune disabled items.
            device.Outlets.PruneDisabled();
            device.Entity.PruneDisabled();

            // Update properties for children.
            processChildDevice(device.Entity);
            processChildDevice(device.Outlets);
        }
    }
    private void processChildDevice<TKey, TEntity>(Dictionary<TKey, TEntity> entities) where TEntity : NamedEntityWithMeasurements
    {
        foreach (var (_, entity) in entities)
        {
            // All measurements will be stored into a sub-key.
            entity.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(entity, MqttPath.Measurements), IdentifierFunc: (k, v) => v.Type);

            // Set Overrides
            Func<string, Measurement, string> MeasurementNamingFunc = (k, m) => m.Type;

            entity.Measurements.SetEntityNameAndEnabled(config.Overrides, MeasurementNamingFunc, DefaultNames.UseMeasurementType);
            entity.Measurements.PruneDisabled();
            entity.Measurements.SetEntityNamePrefix(entity.Entity_Name);
        }
    }
}
