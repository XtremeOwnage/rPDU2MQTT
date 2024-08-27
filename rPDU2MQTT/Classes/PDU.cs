using Microsoft.Extensions.Logging;
using NLog.Fluent;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Interfaces;
using rPDU2MQTT.Models.Config;
using rPDU2MQTT.Models.HomeAssistant;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using rPDU2MQTT.Models.PDUResponse;
using System.Net.Http.Json;
using System.Reflection;
using static System.Runtime.InteropServices.JavaScript.JSType;

namespace rPDU2MQTT.Classes;

public partial class PDU
{
    public string DeviceID => config.PDU.DeviceId;
    private PduConfig pduConfig => config.PDU;
    private readonly Config config;
    private readonly HttpClient http;
    private readonly ILogger<PDU> log;

    /// <summary>
    /// Dummy device which represents the device itself.
    /// </summary>
    public BaseEntity entity_Device { get; init; }

    /// <summary>
    /// Dummy device which represents the root entity. (aka, top level MQTT key)
    /// </summary>
    public BaseEntity entity_Root { get; init; }

    public PDU(Config config, HttpClient http, ILogger<PDU> log)
    {
        this.config = config;
        this.http = http;
        this.log = log;

        //Setup a hierarchy of MQTT paths / devices.


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
        data.Entity_Identifier = $"rPDU2MQTT";

        // Propagate down the parent, and identifier.
        data.Devices.SetParentAndIdentifier(data);

        //Process devices
        processDevices(data.Devices);
    }

    private void processDevices(Dictionary<string, Device> devices)
    {
        foreach (var (key, device) in devices)
        {
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
        // Retreive / Generate "entity_id" for each outlet.
        string getEntityID(string key, Outlet outlet)
        {
            if (int.TryParse(key, out int num) && config.Overrides.OutletID.ContainsKey(num + 1))
            {
                var newValue = config.Overrides.OutletID[num + 1].FormatName();
                this.log.LogDebug($"Overriding entity_id for outlet '{key}' to '{newValue}'");
                return newValue;
            }
            else
                return $"outlet_{key}";
        }

        // Retreive / Generate "name" for each outlet. 
        string getName(string key, Outlet outlet)
        {
            if (int.TryParse(key, out int num) && config.Overrides.OutletName.ContainsKey(num + 1))
            {
                var newValue = config.Overrides.OutletName[num + 1];
                this.log.LogDebug($"Overriding entity Name for outlet '{key}' to '{newValue}'");
                return newValue;
            }
            else
                return (outlet.Label ?? outlet.Name);
        }

        foreach (var (key, entity) in entities)
        {
            if (entity is Outlet o)
            {
                entity.Entity_Name = getEntityID(key, o);
                entity.Entity_DisplayName = getName(key, o);
            }
            else
            {
                entity.Entity_Name = (entity.Label ?? entity.Name).FormatName();
                entity.Entity_DisplayName = (entity.Label ?? entity.Name);
            }

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
            entity.Entity_Name = entity.GetEntityName();
            entity.Entity_DisplayName = entity.Type;
        }
    }
}
