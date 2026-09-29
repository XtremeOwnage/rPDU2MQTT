---
title: Overrides
---

# Overrides

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Overrides

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Overrides` | object |  | Overrides |
| `Overrides.PDU` | object |  | Allows overriding values for the rPDU2MQTT. |
| `Overrides.PDU.ID` | string |  | Overridden ID |
| `Overrides.PDU.Name` | string |  | Overridden Name |
| `Overrides.PDU.Enabled` | bool |  | Is this entity enabled? |
| `Overrides.PDU.Make` | string |  | Manufacturer shown in Home Assistant (e.g. 'Dell'). Applies to devices, outlets and groups. |
| `Overrides.PDU.Model` | string |  | Model shown in Home Assistant (e.g. 'PowerEdge R730xd'). Applies to devices, outlets and groups. |
| `Overrides.Devices` | map |  | Allows overriding configuration for individual devices. |
| `Overrides.Devices.<name>.Outlets` | map |  | Allows overriding values for individual outlets. |
| `Overrides.Devices.<name>.Outlets.<name>.ID` | string |  | Overridden ID |
| `Overrides.Devices.<name>.Outlets.<name>.Name` | string |  | Overridden Name |
| `Overrides.Devices.<name>.Outlets.<name>.Enabled` | bool |  | Is this entity enabled? |
| `Overrides.Devices.<name>.Outlets.<name>.Make` | string |  | Manufacturer shown in Home Assistant (e.g. 'Dell'). Applies to devices, outlets and groups. |
| `Overrides.Devices.<name>.Outlets.<name>.Model` | string |  | Model shown in Home Assistant (e.g. 'PowerEdge R730xd'). Applies to devices, outlets and groups. |
| `Overrides.Devices.<name>.ID` | string |  | Overridden ID |
| `Overrides.Devices.<name>.Name` | string |  | Overridden Name |
| `Overrides.Devices.<name>.Enabled` | bool |  | Is this entity enabled? |
| `Overrides.Devices.<name>.Make` | string |  | Manufacturer shown in Home Assistant (e.g. 'Dell'). Applies to devices, outlets and groups. |
| `Overrides.Devices.<name>.Model` | string |  | Model shown in Home Assistant (e.g. 'PowerEdge R730xd'). Applies to devices, outlets and groups. |
| `Overrides.Measurements` | map |  | Allows overriding individual measurements |
| `Overrides.Measurements.<name>.ID` | string |  | Overridden ID |
| `Overrides.Measurements.<name>.Name` | string |  | Overridden Name |
| `Overrides.Measurements.<name>.Enabled` | bool |  | Is this entity enabled? |
| `Overrides.Measurements.<name>.Make` | string |  | Manufacturer shown in Home Assistant (e.g. 'Dell'). Applies to devices, outlets and groups. |
| `Overrides.Measurements.<name>.Model` | string |  | Model shown in Home Assistant (e.g. 'PowerEdge R730xd'). Applies to devices, outlets and groups. |
| `Overrides.OneviewGroups` | object |  | Overrides specific to Oneview groups |
| `Overrides.OneviewGroups.Measurements` | map |  | Allows overriding individual measurements for groups |
| `Overrides.OneviewGroups.Measurements.<name>.ID` | string |  | Overridden ID |
| `Overrides.OneviewGroups.Measurements.<name>.Name` | string |  | Overridden Name |
| `Overrides.OneviewGroups.Measurements.<name>.Enabled` | bool |  | Is this entity enabled? |
| `Overrides.OneviewGroups.Measurements.<name>.Make` | string |  | Manufacturer shown in Home Assistant (e.g. 'Dell'). Applies to devices, outlets and groups. |
| `Overrides.OneviewGroups.Measurements.<name>.Model` | string |  | Model shown in Home Assistant (e.g. 'PowerEdge R730xd'). Applies to devices, outlets and groups. |
| `Overrides.OneviewGroups.Overrides` | map |  | Allows overriding group ID, Name, and enabled state. |
| `Overrides.OneviewGroups.Overrides.<name>.ID` | string |  | Overridden ID |
| `Overrides.OneviewGroups.Overrides.<name>.Name` | string |  | Overridden Name |
| `Overrides.OneviewGroups.Overrides.<name>.Enabled` | bool |  | Is this entity enabled? |
| `Overrides.OneviewGroups.Overrides.<name>.Make` | string |  | Manufacturer shown in Home Assistant (e.g. 'Dell'). Applies to devices, outlets and groups. |
| `Overrides.OneviewGroups.Overrides.<name>.Model` | string |  | Model shown in Home Assistant (e.g. 'PowerEdge R730xd'). Applies to devices, outlets and groups. |
