---
title: IoTaWatt
---

# IoTaWatt

IoTaWatt inputs and outputs read directly over the device's local [query API](https://docs.iotawatt.com/en/master/query.html). No EmonCMS or MQTT in between.

## In the GUI

**Sources › IoTaWatt**. Turn on **Enabled**, **+ Add** a device, **Save**.

| Field | Setting | Default |
| --- | --- | --- |
| Enabled | `Plugins.iotawatt.Enabled` | off |
| Poll Interval Seconds | `PollIntervalSeconds` (5 minimum) | `10` |
| Timeout Seconds | `TimeoutSeconds` | `10` |
| ID | `Devices[].Id` | |
| Name | `Devices[].Name` | |
| URL | `Devices[].Url`, e.g. `http://iotawatt.local` | |
| Energy Since | `Devices[].EnergySince`: unix or ISO time | first poll |
| Enabled | `Devices[].Enabled` | on |

- **Test** reads each device's series list.
- **List series** shows every input and output with its current value.
- Bind a series on a node: [Bindings](../energy-flow/nodes.md#bindings), type **IoTaWatt series**, then pick the series (and the device, with more than one). Stored as `Settings.Series` and `Settings.Device`.

## Metrics

| Series | Metric | Read as |
| --- | --- | --- |
| Power input or output | `realpower` | `.watts` |
| | `apparentpower` | `.va` |
| | `current` | `.amps` |
| | `powerfactor` | `.pf` |
| | `energy` | `.wh`, converted to kWh |
| Voltage input | `voltage` | `.volts` |
| | `frequency` | `.hz` |
| Output in other units | any | its own unit; set `Unit` on the binding |

## Polling

- One request per device per poll for every bound live series. IoTaWatt does not sample while it answers.
- A value is timed by the 5-second group it was logged in, not by the poll.
- Energy with `Accumulation: period` is watt-hours since the IoTaWatt's local midnight.
- Energy with `Accumulation: lifetime` is watt-hours since `EnergySince`. Blank pins the first poll's time and keeps it across restarts.

## In YAML

```yaml
Plugins:
  iotawatt:
    Enabled: true
    Devices:
      - { Id: main, Url: http://iotawatt.local }
EnergyFlow:
  Nodes:
    - Id: house
      Sources:
        - { Type: iotawatt, Metric: realpower, Settings: { Series: Main } }
        - { Type: iotawatt, Metric: energy, Settings: { Series: Main } }
        - { Type: iotawatt, Metric: voltage, Settings: { Series: Voltage } }
```
