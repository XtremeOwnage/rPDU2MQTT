using Microsoft.Extensions.Logging;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using rPDU2MQTT.Models.PDUResponse;
using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;

namespace rPDU2MQTT.Classes;

public partial class PDU
{
    private readonly Config config;
    private readonly HttpClient http;
    private readonly ILogger<PDU> log;

    public PDU(Config config, [DisallowNull, NotNull] HttpClient http, ILogger<PDU> log)
    {
        this.config = config;
        this.http = http ?? throw new NullReferenceException("HttpClient in constructor was null");
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
        processData(model.Data, cancellationToken);

        return model.Data;
    }

    public async void processData(RootData data, CancellationToken cancellationToken)
    {
        //Set basic details.
        data.Record_Parent = null;
        data.Record_Key = config.MQTT.ParentTopic;
        data.URL = http.BaseAddress!.ToString();

        data.Entity_Identifier = Coalesce(config.Overrides?.PDU?.ID, "rPDU2MQTT")!;
        data.Entity_Name = data.Entity_DisplayName = Coalesce(config.Overrides?.PDU?.Name, data.Sys.Label, data.Sys.Name, "rPDU2MQTT")!;

        // Propagate down the parent, and identifier.
        data.Devices.SetParentAndIdentifier(data, (k, v) => k);

        // Populate Name, DisplayName, and Enabled for devices.
        data.Devices.SetEntityNameAndEnabled(config.Overrides!, (k, d) => d.Name, (k, d) => d.Label);

        //Process devices
        await processRecursive(data.Devices, data, cancellationToken);
    }

    private async Task processRecursive<TEntity, TParent>([AllowNull] TEntity entity, TParent? parent, CancellationToken cancellationToken)
        where TEntity : BaseEntity
        where TParent : NamedEntity
    {
        if (entity is null)
            return;
        else if (entity is Device device)
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

            // Recurse to the next tier.
            await processRecursive(device.Outlets, device, cancellationToken);
            await processRecursive(device.Entity, device, cancellationToken);
        }
        else if (entity is NamedEntityWithMeasurements nem)
        {
            // All measurements will be stored into a sub-key.
            nem.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(entity, MqttPath.Measurements), IdentifierFunc: (k, v) => v.Type);

            // Set Overrides
            Func<string, Measurement, string> MeasurementNamingFunc = (k, m) => m.Type;

            nem.Measurements.SetEntityNameAndEnabled(config.Overrides, MeasurementNamingFunc, DefaultNames.UseMeasurementType);
            nem.Measurements.PruneDisabled();

            if (entity is Entity)
                // For entities- these belong directly to a "Device"
                // We want to set the prefix to the parent device's name.
                nem.Measurements.SetEntityNamePrefix(parent!.Entity_Name);
            else
                // We want to prefix the measurements, with the outlet name.
                // ie, mydevice_power
                nem.Measurements.SetEntityNamePrefix(nem.Entity_Name);
        }
        else
        {
            if (System.Diagnostics.Debugger.IsAttached)
                System.Diagnostics.Debugger.Break();
        }
    }

    private async Task processRecursive<TKey, TEntity, TParent>(Dictionary<TKey, TEntity> entities, TParent parent, CancellationToken cancellationToken)
        where TKey : notnull
        where TEntity : notnull, BaseEntity
        where TParent : NamedEntity
    {
        foreach (var (_, entity) in entities)
            await processRecursive(entity, parent, cancellationToken);
    }
}
