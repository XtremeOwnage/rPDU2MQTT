---
title: Development
---

# Development

## Repository layout

| Project | What it holds |
| --- | --- |
| `rPDU2MQTT` | The host: startup, roles, config sources, restart handling. |
| `rPDU2MQTT.Abstractions` | The plugin contracts. No framework types appear here. |
| `rPDU2MQTT.Core` | Config models, the energy-flow graph, history storage, helpers. |
| `rPDU2MQTT.Engine` | Integrations and background services: PDU polling, MQTT, Home Assistant, exporters. |
| `rPDU2MQTT.Api` | The REST API. |
| `rPDU2MQTT.Web` | The GUI host, and its TypeScript under `web/src`, bundled to `wwwroot`. |
| `rPDU2MQTT.Tests` | Tests. |
| `charts/rpdu2mqtt` | The Helm chart. |
| `docs-site` | This documentation, built with [Netdocs](https://github.com/XtremeOwnage/Netdocs). |

## How it works

- [How data flows](data-flow.md) — sources to destinations, with diagrams.

## Plugins

- [Writing plugins](writing-plugins.md) — the author's guide, with the `HelloWorld` example.
- [Plugins plan](plugins-plan.md) — the working plan, including what was deliberately not done.

## Design history

Records of why each major version looks the way it does. They describe the reasoning at the time, not
necessarily the current code.

- [v2 architecture](design/v2-architecture.md)
- [v3 Orleans migration](design/v3-orleans-migration.md) (Orleans was removed again in v4)
- [v4 integrations as plugins](design/v4-plugins.md)

## Building these docs

```bash
# regenerate the settings reference after changing config models
dotnet rPDU2MQTT/bin/Release/net10.0/rPDU2MQTT.dll --emit-schema > /tmp/schema.json
python3 docs-site/generate-settings.py /tmp/schema.json

# build (or `serve`) with the Netdocs CLI
netdocs build --config docs-site/appsettings.json
```

The `Docs` workflow builds the site with the `XtremeOwnage/Netdocs` action and publishes it to GitHub
Pages from `main`.
