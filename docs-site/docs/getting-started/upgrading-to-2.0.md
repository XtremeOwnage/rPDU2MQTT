---
title: Upgrading to 2.0
---

# Upgrading to 2.0

2.0.0 turns rPDU2MQTT from a single-PDU bridge into an energy-consolidation service: many PDUs plus
MQTT, Modbus, EmonCMS and Home Assistant sources, mapped into one energy hierarchy. Two changes need
attention on an existing install.

## `PDU:` becomes `Pdus:`

The single `PDU:` section is replaced by `Pdus:`, a map of named PDU instances.

=== "1.x"

    ```yaml
    PDU:
      Connection: { Host: pdu.lan, Port: 80 }
      PollInterval: 5
    ```

=== "2.0"

    ```yaml
    Pdus:
      default:
        Connection: { Host: pdu.lan, Port: 80 }
        PollInterval: 5
    ```

An old config still loads: when `Pdus:` is empty, `PDU:` is moved to `Pdus.default` and a warning is
logged. When both are present, `PDU:` is ignored with a warning. Update the file to silence it. The
`RpduConfig` CRD schema and the examples changed with it; see [Kubernetes CRD](../deployment/kubernetes-crd.md).

Two older aliases are still read:

| Old key | Read as |
| --- | --- |
| `Pdus.<name>.Enable_Actions` | `Pdus.<name>.ActionsEnabled` |
| `Prometheus.Enabled: true` | `Prometheus.Exporter: true` |

`RPDU2MQTT_PDU_USERNAME` / `RPDU2MQTT_PDU_PASSWORD` apply to the primary instance: the one named
`default`, otherwise the first.

## Home Assistant: `energy_today` is now `energy_d`

Energy-flow tiers publish their daily energy as `energy_d`, and the Home Assistant sensor is
**Energy Daily**. Home Assistant creates new entities for them; rename or delete the old `energy_today`
ones. The Prometheus gauge is `rpdu2mqtt_flow_energy_d`.

## After upgrading

- Open **Status** in the GUI and check every card is green or grey (not configured).
- If Home Assistant's Energy dashboard shows impossible figures after the switch, see
  [Repairing Home Assistant statistics](../energy-flow/totals.md#repairing-home-assistant-statistics).
