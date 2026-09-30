---
title: Home Assistant
---

# Home Assistant

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Home Assistant Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `HomeAssistant` | object |  | Home Assistant Configuration |
| `HomeAssistant.DiscoveryEnabled` | bool |  | Indicates whether Home Assistant discovery is enabled. |
| `HomeAssistant.DiscoveryTopic` | string |  | The discovery topic for Home Assistant. |
| `HomeAssistant.DiscoveryInterval` | int |  | How often (seconds) to republish discovery. 0 = run once at startup until restarted. |
| `HomeAssistant.DiscoveryRetain` | bool |  | Whether discovery messages are retained on the broker. |
| `HomeAssistant.SensorExpireAfterSeconds` | int |  | expire_after (seconds) applied to sensors; after this long without an update Home Assistant marks them unavailable. |
| `HomeAssistant.GroupMemberNameTemplate` | string | `{device} — Outlet {number} ({outlet})` | Name template for a group's mirrored member switches. Placeholders: {device}, {outlet}, {number}, {group}. |
| `HomeAssistant.GroupMemberObjectIdTemplate` | string | `{serial}_outlet_{number}` | Stable entity/object_id template for a group's mirrored member switches. Placeholders: {serial}, {number}, {device}, {group}. |
| `HomeAssistant.EnergyDashboard` | object |  | Auto-configure Home Assistant's Energy Dashboard 'devices' (with upstream relationships) from the energy-flow hierarchy, via HA's WebSocket API. |
| `HomeAssistant.EnergyDashboard.Enabled` | bool | `false` | Sync the energy-flow hierarchy into HA's Energy Dashboard via its API. Requires Url + a long-lived access token. |
| `HomeAssistant.EnergyDashboard.NodeTags` | object |  | Limit the Energy Dashboard sync to nodes with particular tags. Empty syncs every node. Filtering changes only what is sent — never a value, and never any other destination. |
| `HomeAssistant.EnergyDashboard.NodeTags.Include` | list |  | Only send nodes carrying at least one of these tags. Empty sends every node. |
| `HomeAssistant.EnergyDashboard.NodeTags.Exclude` | list |  | Never send nodes carrying any of these tags. Takes precedence over Include. |
| `HomeAssistant.EnergyDashboard.Url` | string |  | Home Assistant base URL, e.g. http://homeassistant.local:8123 . |
| `HomeAssistant.EnergyDashboard.Token` | string (secret) |  | Home Assistant long-lived access token (or set RPDU2MQTT_HASS_TOKEN). |
| `HomeAssistant.EnergyDashboard.EnergyMeasurementType` | string | `energy` | Measurement type holding each entity's cumulative energy (kWh) — used to find the Energy Dashboard stat for each tier. |
| `HomeAssistant.EnergyDashboard.ExcludeDeviceKinds` | list |  | Node kinds to leave OUT of the Energy Dashboard's individual-devices list (they're sources/storage/pass-through, shown as the dashboard's grid/solar/battery sources instead). Default: grid, solar, battery, inverter. Empty list = export every tier. |
