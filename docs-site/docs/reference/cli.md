---
title: Command line
---

# Command line

rPDU2MQTT is started as `dotnet rPDU2MQTT.dll` (the container's entry point). It takes a few
arguments, and reads the same settings from environment variables.

| Argument | What it does |
| --- | --- |
| `--emit-schema` | Print the configuration schema the GUI renders from, as JSON, and exit. The [settings reference](settings/index.md) is generated from it. |
| `--emit-crd` | Print the generated `RpduConfig` CustomResourceDefinition, as YAML, and exit. |
| `--role <roles>` | Which roles this process runs. Same as `RPDU2MQTT_ROLE`. |

## Roles

`--role` (or `RPDU2MQTT_ROLE`) takes one role or a list separated by commas, spaces or semicolons,
for example `api,ui`. Unset, or nothing recognised, runs everything.

| Value | Role |
| --- | --- |
| `all` | Everything (the default). |
| `worker`, `engine`, `data` | Polls sources and publishes. |
| `api` | The REST API. |
| `ui`, `gui`, `web` | The web GUI. |
| `operator`, `op` | The Kubernetes operator. |

The Helm chart sets roles for you when `split` is enabled; see [Helm chart](../deployment/helm.md).

## Regenerating the settings reference

```bash
dotnet rPDU2MQTT.dll --emit-schema > schema.json
python3 docs-site/generate-settings.py schema.json
```
