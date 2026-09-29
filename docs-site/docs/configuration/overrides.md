---
title: Overrides
---

# Overrides

This section allows you to override generated `entity_id`, names, and enabled/disabled states for various objects. 

For all override sections, Name can be updated at anytime. Home assistant will reflect the updated names after the next discovery job runs.

ID fields, are only used when the device/entity is initially created. Changing this after the entity has been created will have no effect.

All fields, are optional.

> The GUI's **Overrides** editor is the easiest way to set these — it's driven by your live PDU data,
> so you pick real devices/outlets/measurements and can preview the generated paths before saving:
>

## PDU Override
Override details about the PDU itself.

```yaml
Overrides:
  PDU:
    ID: null  # Leave as null unless you have a specific ID
    Name: "Your-PDU"  # Customize the PDU name
```

## Devices Override
Override details regarding devices exposed by the PDU using their serial numbers.

Each PDU can expose multiple devices. The outlets, sensors, etc will belong to one of these devices within Home Assistant.

```yaml
Overrides:
  Devices:
    A0AE260C851900C3:       # Replace this with the serial number from your device. You can get this from the info tab.
      ID: null              # Leave as null unless you have a specific ID
      Name: "Device Name"   # Customize the device name
      Enabled: true         # Set to false to disable this device. 
```

## Outlets Override
Customize individual outlets by their number (1-based, matching the PDU UI). Outlets are nested under
their device's serial number.

```yaml
Overrides:
  Devices:
    A0AE260C851900C3:           # Device serial number
      Outlets:
        1:
          ID: kube02                # Customize the outlet ID
          Name: "Proxmox: Kube02"   # Customize the outlet name
          Enabled: true             # Set to false to disable this outlet
          Make: "Dell"              # Manufacturer shown in Home Assistant
          Model: "PowerEdge R730xd" # Model shown in Home Assistant
```

`Make` and `Model` override what Home Assistant shows in the device info (instead of the PDU's
hardware make/model, e.g. `GEI` / `MNU3E1R1-...`). They apply to devices, outlets, and OneView groups,
and take precedence over the `RemapMake` / `RemapModel` toggles.

## Measurements Override
Customize how metrics are sent to services. The entity ID used for metrics is `[DEVICE_ID]_[METRIC_TYPE]`.

Example, say, you have a device named `kube02`. The measurements will be named kube02_power

```yaml
Overrides:
  Measurements:
    apparentPower:
      ID: null         # Leave as null unless you have a specific ID
      Name: "Apparent Power"  # Human-readable name for this metric
      Enabled: true    # Set to false to disable this metric
    realPower:
      ID: power        # Customize the ID if needed
      Name: "Power"    # Human-readable name for this metric
      Enabled: true    # Set to false to disable this metric
```
