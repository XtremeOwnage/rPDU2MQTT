---
title: Locations
---

# Locations

**Energy Flow › Locations**. Sites, floors, rooms and areas, with each place's total and nodes. Bundled plugin: `plugins/rPDU2MQTT.Plugin.Locations`.

| Part | |
| --- | --- |
| Tree | Places with live power. Add, rename, reorder, delete. |
| Now / Today | The place's total. Blank when nothing metered is in it or a reading is missing. |
| Nodes | Nodes in the place, and what placed them: node, rule, floor plan or circuit. Inherited nodes are greyed. **Add nodes…** picks several; configured nodes get `Ext.locations.Location`, others an exact rule. |
| Sensors | Thermometers and humidity sensors, bound like a node (MQTT topic or Home Assistant entity). Not energy nodes. |
| Climate | Rooms and areas: sensors, or nodes reporting temperature, combined by average, first, min or max. An area with none uses its rooms'. |
| Publish to Home Assistant | Preview, then create, rename and link areas and floors. |
| Rules | `AutoLocations` pointing here. `*` matches anything. |
| Home Assistant | The `HomeAssistant` sync modes and schedule. |

A new place's id follows its first name. Deleting a place clears every reference to it.

## Climate

Not inherited: a room reads only the sensors picked for it. A Climate entry is a sensor id, or a node id for a PDU probe. Published on `location:<id>` as `temperature` and `humidity`, with Home Assistant sensors on the place's device. Unknown values are left out.

```yaml
Plugins:
  locations:
    Sensors:
      - Id: office_thermo
        Name: Office
        Sources:
          - { Type: mqtt, Metric: temperature, Topic: rtl_433/Acurite-Tower/1537, JsonField: temperature_C }
          - { Type: mqtt, Metric: percent, Topic: rtl_433/Acurite-Tower/1537, JsonField: humidity }
    Sites:
      - Id: home
        Floors:
          - Id: ground
            Rooms:
              - Id: office
                Climate:
                  Temperature: [office_thermo]
                  Humidity: [office_thermo]
                  Combine: average
```

## Home Assistant

```yaml
Plugins:
  locations:
    HomeAssistant:
      Areas: create        # create | update | off
      Floors: off          # create | update | off
      DeviceAreas: unset-only  # unset-only | off
      AreaSensors: off     # fill | always | off
      Schedule: manual     # manual | on-change | interval
      IntervalMinutes: 60
```

`update` touches only linked or same-name areas and floors. `AreaSensors` sets each area's temperature and humidity entities to its room's. Scheduled publishes run on the lease owner and report on the Status board.
