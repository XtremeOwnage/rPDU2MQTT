---
title: Overrides
---

# Overrides

Names, ids, make/model and enabled state for the bridge device, each PDU device, each outlet, each measurement type and each OneView group.

## In the GUI

**Sources › Overrides**. The page lists what the PDU reports. Blank fields keep the value in the placeholder.

![Overrides page](../assets/screenshots/overrides.webp)

| Field | Effect |
| --- | --- |
| Name (display) | Name in Home Assistant, MQTT and the GUI. Changes apply on the next discovery. |
| ID (object_id) | Entity id. Used when the entity is first created only. |
| Make (manufacturer) | Manufacturer in Home Assistant device info |
| Model | Model in Home Assistant device info |
| Enabled | Off removes the device, outlet or measurement |

- **Refresh live data** reloads the device list.
- **Preview generated paths** shows topics and metric names with unsaved edits applied.
- Make and Model override **Remap Model** / **Remap Manufacturer**.

## In YAML

```yaml
Overrides:
  PDU:
    Name: Rack PDU
  Devices:
    A0AE260C851900C3:          # device serial
      Name: Rack PDU 1
      Enabled: true
      Outlets:
        1:                     # outlet number, 1-based
          ID: kube02
          Name: "Proxmox: Kube02"
          Make: Dell
          Model: PowerEdge R730xd
  Measurements:
    realPower:
      ID: power
      Name: Power
    apparentPower:
      Enabled: false
```

OneView group overrides: [OneView](oneview.md#overrides).

All settings: [Overrides reference](../reference/settings/overrides.md).
