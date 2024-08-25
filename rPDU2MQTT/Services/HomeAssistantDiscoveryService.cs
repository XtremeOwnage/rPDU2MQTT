using Microsoft.Extensions.Logging;
using rPDU2MQTT.Classes;
using rPDU2MQTT.Extensions;
using rPDU2MQTT.Helpers;
using rPDU2MQTT.Models.HomeAssistant.baseClasses;
using rPDU2MQTT.Services.baseTypes;

namespace rPDU2MQTT.Services;

/// <summary>
/// This class publishes metrics from the PDU, to MQTT.
/// </summary>
public class HomeAssistantDiscoveryService : baseDiscoveryService
{
    public HomeAssistantDiscoveryService(ILogger<HomeAssistantDiscoveryService> log, ServiceDependancies deps) : base(deps, log) { }

    protected override async Task Execute(CancellationToken cancellationToken)
    {
        var data = await pdu.GetRootData_Public(cancellationToken);
        var ParentDevice = data.GetDiscoveryDevice(this.cfg.PDU.Url);

        log.LogDebug("Starting discovery job.");

        List<baseEntity> Sensors = new();

        foreach (var device in data.Devices.Values)
        {
            foreach (var entity in device.Entity.Values)
            {
                //So... I only have a single-phase PDU.
                // Duct-tape to just attach phase-A data to the primary device.
                // If- this integration ever gets used for a dual-phase PDU, this will need to be updated.
                if (entity.Label != "Input")
                    continue;

                foreach (var measurement in entity.Measurements.Values)
                {
                    //If we are unable to parse this measurement as valid, skip to the next.
                    var dto = measurement.TryParseValue();
                    if (dto is null || dto.EntitySuffix is null)
                        continue;

                    Sensors.Add(CreateSensorDiscovery(measurement, ParentDevice, dto));
                }
            }

            //if(false)
            foreach (var outlet in device.Outlets.Values)
            {
                var childDevice = ParentDevice.CreateChild(outlet);

                Sensors.Add(outlet.CreateStateDiscovery(childDevice));

                foreach (var measurement in outlet.Measurements.Values)
                {
                    //If we are unable to parse this measurement as valid, skip to the next.
                    var dto = measurement.TryParseValue();
                    if (dto is null || dto.EntitySuffix is null)
                        continue;

                    Sensors.Add(CreateSensorDiscovery(measurement, childDevice, dto));
                }
            }

        }

        log.LogInformation("Publishing discovery messages");

        await this.PublishDeviceSensors(Sensors, cancellationToken);

        log.LogInformation("Discovery information published.");
    }
}