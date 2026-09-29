---
title: Pdus
---

# Pdus

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

PDU instances to bridge, keyed by instance name.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Pdus` | map |  | PDU instances to bridge, keyed by instance name. |
| `Pdus.<name>.Connection` | object |  | Connection details for PDU |
| `Pdus.<name>.Connection.Host` | string |  | Hostname or IP to connect to. |
| `Pdus.<name>.Connection.Port` | int |  | The port to connect to. Range 0–65535. |
| `Pdus.<name>.Connection.Timeout` | int |  | Default connection timeout. Range 1–3600. |
| `Pdus.<name>.Connection.Scheme` | one of `http`, `https` |  | Connection scheme used |
| `Pdus.<name>.Connection.ValidateCertificate` | bool | `true` | Enables certificate validation |
| `Pdus.<name>.Credentials` | object |  | PDU login used for write actions (outlet control). Can also be supplied via RPDU2MQTT_PDU_USERNAME / RPDU2MQTT_PDU_PASSWORD. |
| `Pdus.<name>.Credentials.Username` | string |  | Username to log in as |
| `Pdus.<name>.Credentials.Password` | string (secret) |  | Password to login with |
| `Pdus.<name>.PollInterval` | int | `5` | How often (seconds) to poll the PDU and publish readings. Range 1–2147483647. |
| `Pdus.<name>.ActionsEnabled` | bool | `false` | Allow the bridge to make changes on the PDU (e.g. toggle outlets). When off, no switches or other write controls are exposed to Home Assistant. Requires PDU credentials. |
| `Pdus.<name>.RemapModel` | bool | `false` | Replace each outlet/group's Model (shown in the Home Assistant device info) with contextual text (e.g. parent PDU + name) instead of the PDU's hardware model. |
| `Pdus.<name>.RemapManufacturer` | bool | `false` | Replace each entity's Manufacturer (shown in Home Assistant) with the entity type (Outlet, Group, etc.) instead of the hardware manufacturer. |
| `Pdus.<name>.EmonCmsTag` | string |  | EmonCMS tag this PDU's feeds are filed under. Blank uses EmonCMS.Feeds.Tag. Placeholders: {device} (the PDU's name), {instance} (this entry's key), e.g. '{device}'. |
| `Pdus.<name>.EmonCmsVirtualTag` | string |  | EmonCMS tag this PDU's virtual feeds are filed under. Blank uses EmonCMS.Feeds.Virtual.Tag. Placeholders: {device}, {instance}, e.g. '{device}-virtual'. |
