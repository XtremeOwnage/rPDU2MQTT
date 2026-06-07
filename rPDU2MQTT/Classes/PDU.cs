using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.PDU;
using rPDU2MQTT.Models.PDU.DummyDevices;
using rPDU2MQTT.Models.PDU.OneView;
using System.Diagnostics.CodeAnalysis;

namespace rPDU2MQTT.Classes;

public partial class PDU
{
    private readonly Config config;
    private readonly PduApiHandler api;

    /// <summary>
    /// A flag which determines if we should leverage the ONEView API, instead of the direct API.
    /// </summary>
    /// <remarks>
    /// Detection of ONEView is performed on the first polling interval.
    /// </remarks>
    private bool? useOneView { get; set; } = null;

    public PDU(Config config, PduApiHandler api)
    {
        this.config = config;
        this.api = api;
    }

    /// <summary>
    /// Pull all public data.
    /// </summary>
    /// <param name="cancellationToken"></param>
    /// <returns></returns>
    public async Task<PduData> GetRootData_Public(CancellationToken cancellationToken)
    {
        if (useOneView is null)
        {
            this.useOneView = await api.GetAsync<bool>("/api/conf/oneview/enabled", cancellationToken);
            if (useOneView == true)
                Log.Debug("Detected OneView. Will use /oneview for collecting data.");
            else
                Log.Debug("OneView is not enabled. Using /api.");
        }

        if (useOneView is null)
            throw new Exception("Failed to determine if Device Aggregation is enabled.");

        if (useOneView == true)
        {
            // View ONE-View API
            var data = await api.GetAsync<OneViewRootData>("/oneview", cancellationToken);

            // Process data.
            await processOneViewData(data, cancellationToken);

            // Return the single model.
            return new PduData
            {
                PDUs = data.Hosts.Select(o => o.Cache).ToArray(),
                Devices = data.Hosts.SelectMany(o => o.Cache.Devices).ToList(),
                Groups = data.Groups
            };
        }
        else
        {
            var model = await api.GetAsync<rPDU>("/api", cancellationToken);

            // Process single-device data.
            await processData(model, cancellationToken);

            // Return the single model.
            return new PduData
            {
                PDUs = [model],
                Devices = model.Devices
            };
        }
    }

    private async Task processOneViewData(OneViewRootData data, CancellationToken cancellationToken)
    {
        //Set basic details.
        data.Record_Parent = null;
        data.Record_Key = config.MQTT.ParentTopic;
        //data.URL = api.BaseAddress;

        data.Entity_Identifier = Coalesce(config.Overrides?.rPDU2MQTT?.ID, "rPDU2MQTT")!;
        data.Entity_Name = data.Entity_DisplayName = "OneView"; // Coalesce(config.Overrides?.rPDU2MQTT?.Name, "rPDU2MQTT")!;

        // Process groups.
        await processOneViewGroups(data, data.Groups, cancellationToken);


        //Process individual hosts, as if they were stand-alone hosts.
        foreach (var host in data.Hosts)
            await processData(host.Cache, cancellationToken);

    }

    private async Task processOneViewGroups(OneViewRootData Parent, List<OneViewGroup> Groups, CancellationToken cancellationToken)
    {
        // Create a child-object named "Groups"
        var Entity_Groups = BaseEntity.FromDevice(Parent, MqttPath.Groups);

        // Propagate down the parent, and identifier.
        Groups.SetParentAndIdentifier(Entity_Groups, o => o.Key);

        // Populate Name, DisplayName, and Enabled for devices.
        Groups.SetEntityNameAndEnabled(config.Overrides!, o => o.Name, o => o.Label);

        // Remove disabled items.
        Groups.PruneDisabled();

        // Process Groups.
        await processListRecursive(Groups, Parent, cancellationToken);
    }



    private async Task processData(rPDU data, CancellationToken cancellationToken)
    {
        //Set basic details.
        data.Record_Parent = null;
        data.Record_Key = config.MQTT.ParentTopic;
        data.URL = api.BaseAddress;

        data.Entity_Identifier = Coalesce(config.Overrides?.rPDU2MQTT?.ID, "rPDU2MQTT")!;
        data.Entity_Name = data.Entity_DisplayName = Coalesce(config.Overrides?.rPDU2MQTT?.Name, data.Sys.Label, data.Sys.Name, "rPDU2MQTT")!;

        // Propagate down the parent, and identifier.
        data.Devices.SetParentAndIdentifier(data, o => o.Key);

        // Populate Name, DisplayName, and Enabled for devices.
        data.Devices.SetEntityNameAndEnabled(config.Overrides!, o => o.Name, o => o.Label);

        //Process devices
        await processListRecursive(data.Devices, data, cancellationToken);
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
            device.Entity.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Entity), o => o.Key);
            device.Outlets.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Outlets), o => o.Key.ToString());

            // Set Overrides
            device.Outlets.SetEntityNameAndEnabled(config.Overrides, DefaultNames.UseEntityName, DefaultNames.UseEntityLabel);
            device.Entity.SetEntityNameAndEnabled(config.Overrides, DefaultNames.UseEntityName, DefaultNames.UseEntityLabel);

            // Prune disabled items.
            device.Outlets.PruneDisabled();
            device.Entity.PruneDisabled();

            // Recurse to the next tier.
            await processListRecursive(device.Outlets, device, cancellationToken);
            await processListRecursive(device.Entity, device, cancellationToken);
        }
        else if (entity is NamedEntityWithMeasurements nem)
        {
            // All measurements will be stored into a sub-key.
            nem.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(entity, MqttPath.Measurements), IdentifierFunc: o => o.Type);

            // Set Overrides
            Func<Measurement, string> MeasurementNamingFunc = o => o.Type;

            nem.Measurements.SetEntityNameAndEnabled(config.Overrides, MeasurementNamingFunc, DefaultNames.UseMeasurementType);
            nem.Measurements.PruneDisabled();

            if (entity is Entity)
                // For entities- these belong directly to a "Device"
                // We want to set the prefix to the parent device's name.
                nem.Measurements.SetEntityNamePrefix(parent!.Entity_Name);
            else
                // We want to prefix the measurements, with the outlet name.
                // ie, mydevice_power
                nem.Measurements.SetEntityNamePrefix(string.Join('_', parent.Entity_Name, nem.Entity_Name).FormatName());
        }
        else if (entity is OneViewGroup grp)
        {
            // Propagate down the parent, and identifier.
            //grp.Entity.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Entity), o => o.Key);
            //grp.Entity.Outlets.SetParentAndIdentifier(BaseEntity.FromDevice(device, MqttPath.Outlets), o => o.Key.ToString());

            if (grp.Entity?.PduTotal?.Measurements?.Any() ?? false)
                grp.Entity.PduTotal.Measurements.SetEntityNamePrefix(parent!.Entity_Name);

            foreach (var outlet in grp.Entity.Outlets)
            {
                // All measurements will be stored into a sub-key.
                outlet.Measurements.SetParentAndIdentifier(BaseEntity.FromDevice(entity, MqttPath.Measurements), IdentifierFunc: o => o.Type);
                outlet.Measurements.SetEntityNameAndEnabled(config.Overrides, o => o.Type, DefaultNames.UseMeasurementType);
                outlet.Measurements.PruneDisabled();

                outlet.Measurements.SetEntityNamePrefix(parent!.Entity_Name);
            }


        }
        else
        {
            if (System.Diagnostics.Debugger.IsAttached)
                System.Diagnostics.Debugger.Break();
        }
    }

    private async Task processListRecursive<TEntity, TParent>(List<TEntity> entities, TParent parent, CancellationToken cancellationToken)
        where TEntity : notnull, BaseEntity
        where TParent : NamedEntity
    {
        foreach (var entity in entities)
            await processRecursive(entity, parent, cancellationToken);
    }
}
