---
title: Configuration
---

# Configuration

rPDU2MQTT is configured by one YAML file, `config.yaml` (or `config.yml`). Most of it can also be edited
from the [web GUI](gui.md), which writes the same file.

## Where the file is read from

| Platform | Searched, in order |
| --- | --- |
| Linux / containers | `/config/config.yaml`, `/config/config.yml`, then the working directory |
| Windows | the working directory |

Under Kubernetes the configuration can come from an `RpduConfig` custom resource instead; see
[Kubernetes CRD](../deployment/kubernetes-crd.md).

## Rules

- **Keys are case-insensitive.** `Mqtt`, `MQTT` and `mqtt` are the same section.
- **Duplicate keys are an error**, and a YAML error is logged with its line number.
- **Secrets can come from the environment**, and the environment wins over the file. See
  [Environment variables](environment-variables.md).
- **Old keys still load:** `PDU:` becomes `Pdus.default`, `Enable_Actions` becomes `ActionsEnabled`,
  `Prometheus.Enabled` becomes `Prometheus.Exporter`. See [Upgrading to 2.0](../getting-started/upgrading-to-2.0.md).

## Sections

| Section | Guide | Reference |
| --- | --- | --- |
| `MQTT` | [MQTT](mqtt.md) | [settings](../reference/settings/mqtt.md) |
| `Pdus` | [PDUs](pdus.md), [OneView](oneview.md) | [settings](../reference/settings/pdus.md) |
| `Overrides` | [Overrides](overrides.md) | [settings](../reference/settings/overrides.md) |
| `HomeAssistant` | [Home Assistant](home-assistant.md) | [settings](../reference/settings/homeassistant.md) |
| `EnergyFlow` | [Energy flow](../energy-flow/index.md) | [settings](../reference/settings/energyflow.md) |
| `History` | [History](history.md) | [settings](../reference/settings/history.md) |
| `Prometheus` | [Prometheus](prometheus.md) | [settings](../reference/settings/prometheus.md) |
| `EmonCMS` | [EmonCMS](emoncms.md) | [settings](../reference/settings/emoncms.md) |
| `Modbus` | [Live sources › Modbus TCP](../energy-flow/sources.md#live-sources-from-modbus-tcp) | [settings](../reference/settings/modbus.md) |
| `Gui` | [Configuration GUI](gui.md) | [settings](../reference/settings/gui.md) |
| `Api` | [REST API](../reference/rest-api.md) | [settings](../reference/settings/api.md) |
| `Health` | [Health checks](../reference/health.md) | [settings](../reference/settings/health.md) |
| `Logging`, `Debug` | [Logging and debug](logging.md) | [logging](../reference/settings/logging.md), [debug](../reference/settings/debug.md) |
| `PlanStorage` | [Floor plans › Plan storage](../energy-flow/floor-plans.md#plan-storage) | [settings](../reference/settings/planstorage.md) |
| `Cache` | [Totals and counters](../energy-flow/totals.md#where-todays-totals-are-kept) | [settings](../reference/settings/cache.md) |
| `Operator` | [Helm chart](../deployment/helm.md) | [settings](../reference/settings/operator.md) |
| `Plugins` | [Writing plugins](../development/writing-plugins.md) | [settings](../reference/settings/plugins.md) |

## Example files

The repository keeps three example configurations:

- [Minimal](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Configuration/minimum-configuration-example.yaml) — the least needed for a working service.
- [Recommended](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Configuration/recommended-configuration.yaml) — renames and re-ids a few measurements.
- [Configuration spec](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Configuration/config.spec.yaml) — the documented options in one file.
