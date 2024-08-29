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
        var model = await http.GetFromJsonAsync<GetResponse<RootData>>("/api", options: Models.PDU.Converter.Settings, cancellationToken);

        //Process device data.
        processData(model.Data);

        return model.Data;
    }

    public void processData(RootData data)
    {
        //Set basic details.
        data.Record_Parent = null;
        data.Record_Key = config.MQTT.ParentTopic;

        data.Entity_Identifier = Coalesce(config.Overrides.PduID, "rPDU2MQTT")!;
        data.Entity_Name = data.Entity_DisplayName = Coalesce(config.Overrides.PduName, data.Sys.Label, data.Sys.Name, "rPDU2MQTT")!;

        // Propagate down the parent, and identifier.
        data.Devices.SetParentAndIdentifier(data);

        //Process devices
        processDevices(data.Devices);
    }

    private void processDevices(Dictionary<string, Device> devices)
    {
        foreach (var (key, device) in devices)
        {
            // Remove any disabled outlets.
            config.Outlets.RemoveDisabledRecords(device.Outlets);

            // Propagate down the parent, and identifier.
            device.Entity.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Entity));
            device.Outlets.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Outlets));

            // Update properties for children.
            processChildDevice(device.Entity);
            processChildDevice(device.Outlets);
        }
    }
    private void processChildDevice<T>(Dictionary<string, T> entities) where T : NamedEntityWithMeasurements
    {
        foreach (var (key, entity) in entities)
        {
            if (entity is Outlet o)
            {
                int k = int.TryParse(key, out int s) ? s + 1 : 0; //Note- the plus one, is so the number aligns with what is seen on the GUI.
                entity.ApplyOverrides(k.ToString(), config.Outlets);
            }
            else
            {
                entity.Entity_Name = (entity.Label ?? entity.Name).FormatName();
                entity.Entity_DisplayName = (entity.Label ?? entity.Name);
            }

            // Remove any disabled measurements.
            config.Measurements.RemoveDisabledRecords(entity.Measurements, o => o.Type);

            // All measurements will be stored into a sub-key.
            entity.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(entity, MqttPath.Measurements));

            // Update properties for measurements.
            processMeasurements(entity.Measurements);
        }
    }

    private void processMeasurements<T>(Dictionary<string, T> measurements) where T : Measurement
    {
        foreach (var (key, entity) in measurements)
        {
            // We want to override the default key here- to give a nice, readable key.
            entity.Record_Key = entity.Type;
            entity.ApplyOverrides(entity.Type, config.Measurements, DefaultName: entity.Type, DefaultDisplayName: entity.Type);

            //SInce- ApplyNameOverridesReturnIsValid already set the EntityName, we are just going to append a suffix to it.
            entity.Entity_Name = entity.GetEntityName(entity.Entity_Name);
        }
    }
}
