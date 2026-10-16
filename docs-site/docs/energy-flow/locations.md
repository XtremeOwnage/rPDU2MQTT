---
title: Locations
---

# Locations

**Energy Flow › Locations**. Sites, floors, rooms and areas, with each place's total and members. Bundled plugin: `plugins/rPDU2MQTT.Plugin.Locations`.

| Part | |
| --- | --- |
| Tree | Places with live power. Add, rename, reorder, delete. |
| Now / Today | The place's total. Blank when nothing metered is in it or a reading is missing. |
| Members | Nodes in the place, and why: set, rule, floor plan or circuit. Inherited members are greyed. |
| Climate | Rooms and areas: temperature and humidity sensors, combined by average, first, min or max. An area with none uses its rooms'. |
| Publish to Home Assistant | Preview, then create, rename and link areas and floors. |
| Rules | `AutoLocations` pointing here. `*` matches anything. |
| Assign | Tick nodes, pick a place. Configured nodes get `Ext.locations.Location`; others get an exact rule. |

A new place's id follows its first name. Deleting a place clears every reference to it.

## Climate

Not inherited: a room reads only the sensors picked for it. Published on `location:<id>` as `temperature` and `humidity`, with Home Assistant sensors on the place's device. Unknown values are left out.

```yaml
Plugins:
  locations:
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
