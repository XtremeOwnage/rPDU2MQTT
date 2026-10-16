---
title: Configuration
---

# Configuration

## Where settings live

| Source | Edited by |
| --- | --- |
| `config.yaml` | GUI **Save**, or by hand |
| `RpduConfig` custom resource (Kubernetes) | GUI **Save** (patches the resource), `kubectl`, GitOps. See [Kubernetes CRD](../deployment/kubernetes-crd.md) |
| Environment variables | Secrets and runtime options. See [Environment variables](../system/environment-variables.md) |

Most settings have a GUI page. Set only in the file or chart values:

- Feature switches: `Gui.Enabled`, `HomeAssistant.DiscoveryEnabled`, `Prometheus.Exporter`, `EmonCMS.Enabled`, `History.Enabled`, `Cache.Enabled`, `Api.Enabled`, `Health.Enabled`, `Operator.Enabled`.
- `Health`, `Api`, `PlanStorage`, `Cache`.

## File location

| Platform | Searched, in order |
| --- | --- |
| Linux / containers | `/config/config.yaml`, `/config/config.yml`, working directory |
| Windows | Working directory |

No file found: the searched paths are logged, and the process exits after 15 seconds.

## Rules

- Keys are case-insensitive.
- Duplicate keys are an error. YAML errors are logged with the line number.
- Secrets from the environment override the file.
- Old keys still load: `PDU:` → `Pdus.default`, `Enable_Actions` → `ActionsEnabled`, `Prometheus.Enabled` → `Prometheus.Exporter`.

## Sections

| Section | Page | Reference |
| --- | --- | --- |
| `MQTT` | [MQTT](../integrations/mqtt.md) | [settings](../reference/settings/mqtt.md) |
| `Pdus` | [Vertiv rPDU](../vertiv/index.md) | [settings](../reference/settings/pdus.md) |
| `Overrides` | [Overrides](../vertiv/overrides.md) | [settings](../reference/settings/overrides.md) |
| `Modbus` | [Modbus TCP](../integrations/modbus.md) | [settings](../reference/settings/modbus.md) |
| `EnergyFlow` | [Energy flow](../energy-flow/index.md) | [settings](../reference/settings/energyflow.md) |
| `HomeAssistant` | [Home Assistant](../destinations/home-assistant.md) | [settings](../reference/settings/homeassistant.md) |
| `Prometheus` | [Prometheus](../destinations/prometheus.md) | [settings](../reference/settings/prometheus.md) |
| `EmonCMS` | [EmonCMS](../destinations/emoncms.md) | [settings](../reference/settings/emoncms.md) |
| `History` | [History](../system/history.md) | [settings](../reference/settings/history.md) |
| `Logging`, `Debug` | [Logging](../system/logging.md) | [logging](../reference/settings/logging.md), [debug](../reference/settings/debug.md) |
| `Gui` | [GUI and authentication](../system/gui.md) | [settings](../reference/settings/gui.md) |
| `Operator` | [Updates and restarts](../deployment/updates.md#automatic-updates) | [settings](../reference/settings/operator.md) |
| `Api` | [REST API](../reference/rest-api.md) | [settings](../reference/settings/api.md) |
| `Health` | [Health checks](../reference/health.md) | [settings](../reference/settings/health.md) |
| `PlanStorage` | [Floor plans](../energy-flow/floor-plans.md#plan-storage) | [settings](../reference/settings/planstorage.md) |
| `Cache` | [Totals and counters](../energy-flow/totals.md#where-daily-totals-are-stored) | [settings](../reference/settings/cache.md) |
| `Plugins` | [Writing plugins](../development/writing-plugins.md) | [settings](../reference/settings/plugins.md) |

## Examples

- [Minimal](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Configuration/minimum-configuration-example.yaml)
- [Recommended](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Configuration/recommended-configuration.yaml)
- [Full spec](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Configuration/config.spec.yaml)
