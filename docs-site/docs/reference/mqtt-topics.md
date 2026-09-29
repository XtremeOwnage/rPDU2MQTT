---
title: MQTT topics
---

# MQTT topics

Everything is published under `MQTT.ParentTopic` (default `rPDU2MQTT`). The examples below were captured
from the demo setup: one PDU instance whose device serial is `A0AE260C851900C3`, with ten outlets.

![Paths page: the MQTT topic, Prometheus metric and EmonCMS key for each measurement](../assets/screenshots/paths.webp)

The GUI's **Paths** page lists the exact topic for every measurement, including the effect of your
[overrides](../configuration/overrides.md). Use it rather than working topics out by hand.

## Bridge

| Topic | Payload |
| --- | --- |
| `<parent>/Status` | `online` / `offline`. The Last-Will topic, used as every entity's availability topic while `MQTT.LastWill` is on. |
| `<parent>/rediscover` | Command topic of the bridge's **Rediscover** button in Home Assistant. |
| `<parent>/restart` | Command topic of the bridge's **Restart** button in Home Assistant. |

## PDU devices

A lone PDU instance publishes without a namespace. With several instances, each is published under a
namespace of its own (see [PDUs](../configuration/pdus.md)).

| Topic | Example payload |
| --- | --- |
| `<parent>/<serial>/state` | `normal` |
| `<parent>/<serial>/alarm`, `…/alarm_attributes` | device alarm state, and its attributes as JSON |
| `<parent>/<serial>/entity/<entity>/measurements/<type>` | `1082` (e.g. `entity/total0/measurements/apparentPower`) |
| `<parent>/<serial>/outlets/<n>/measurements/<type>` | `201` |
| `<parent>/<serial>/outlets/<n>/measurements/<type>/alarm` | `normal` |
| `<parent>/<serial>/outlets/<n>/state` | `on` / `off` |
| `<parent>/<serial>/outlets/<n>/name` | `TrueNAS` |
| `<parent>/<serial>/outlets/<n>/onDelay`, `offDelay`, `rebootDelay` | seconds |
| `<parent>/<serial>/outlets/<n>/poaAction` | `on`, `off` or `last` |

`<n>` is the outlet's 0-based index in the PDU's data. Measurement types seen on outlets are
`realPower`, `apparentPower`, `current`, `voltage`, `powerFactor` and `energy`.

### Outlet commands

With `Pdus.<name>.ActionsEnabled: true` and PDU credentials, Home Assistant discovery wires these command
topics (from the outlet device's discovery payload):

| Topic | Entity |
| --- | --- |
| `…/outlets/<n>/set` | Switch (`on` / `off`) |
| `…/outlets/<n>/reboot` | Reboot button |
| `…/outlets/<n>/resetStats` | Reset Statistics button |
| `…/outlets/<n>/onDelay/set`, `offDelay/set`, `rebootDelay/set` | Delay numbers |
| `…/outlets/<n>/poaAction/set` | Power-On Action select |

## Energy-flow tiers

With `EnergyFlow.MqttExport: true`, every tier is published as JSON to
`EnergyFlow.MqttTopicTemplate` (default `{parent}/energyflow/{id}`). Rooms, floors and sites are tiers
too (`location_<id>`), as are PDUs (`pdu_<device>`), outlets (`outlet_<device>_<n>`), groups and breakers.

`rPDU2MQTT/energyflow/solar`:

```json
{"id":"solar","value":5503.66,"power":5503.66,"energy":19334.79,"energy_out":null,"energy_in":null,
 "energy_d":57.16,"soc":null,"units":"W","energyUnits":"kWh","label":"Solar Array","kind":"solar",
 "parents":[],"timestamp":"2026-09-29T13:18:23.414Z"}
```

| Field | Meaning |
| --- | --- |
| `value`, `power` | power in `units` |
| `energy` | lifetime energy counter, in `energyUnits` |
| `energy_in`, `energy_out` | per-direction energy, for nodes with a directional energy source |
| `energy_d` | energy since the period boundary (see [Totals and counters](../energy-flow/totals.md)) |
| `soc` | state of charge, for nodes with a `soc` source |
| `timestamp` | time of the reading; for a rolled-up tier, the oldest contributing reading |

A value nothing determines is `null`, never `0`.

## Home Assistant discovery

Discovery uses device-based payloads under `HomeAssistant.DiscoveryTopic`:

- `<discovery>/device/rPDU2MQTT/config` — the bridge.
- `<discovery>/device/rPDU2MQTT_<serial>/config` — each PDU device.
- `<discovery>/device/rPDU2MQTT_<serial>_outlets_<n>/config` — each outlet.
- `<discovery>/device/energyflow_<id>/config` — each exported energy-flow tier.
