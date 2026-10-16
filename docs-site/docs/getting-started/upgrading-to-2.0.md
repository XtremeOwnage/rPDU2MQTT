---
title: Upgrading to 2.0
---

# Upgrading to 2.0

Two changes affect existing 1.x installs. Full list: [Changelog](../changelog.md).

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

- `PDU:` alone loads as `Pdus.default`, with a warning.
- `PDU:` and `Pdus:` together: `PDU:` is ignored, with a warning.
- The `RpduConfig` CRD schema changed the same way ([Kubernetes CRD](../deployment/kubernetes-crd.md)).

Older aliases still read:

| Old key | Read as |
| --- | --- |
| `Pdus.<name>.Enable_Actions` | `Pdus.<name>.ActionsEnabled` |
| `Prometheus.Enabled: true` | `Prometheus.Exporter: true` |

`RPDU2MQTT_PDU_USERNAME` / `RPDU2MQTT_PDU_PASSWORD` apply to the `default` instance, else the first.

## Home Assistant: `energy_today` is now `energy_d`

- Tier daily energy is published as `energy_d`; the Home Assistant sensor is **Energy Daily**.
- Home Assistant creates new entities. Rename or delete the old `energy_today` ones.
- Prometheus gauge: `rpdu2mqtt_flow_energy_d`.

## After upgrading

- **System › Status**: every card green, or grey for not configured.
- Bad Energy Dashboard figures: [Repairing Home Assistant statistics](../energy-flow/totals.md#repairing-home-assistant-statistics).
