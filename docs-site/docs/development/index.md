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

## Pages

- [How data flows](data-flow.md)
- [Writing plugins](writing-plugins.md)
- [Changelog](../changelog.md)

## Building these docs

```bash
# regenerate the settings reference
dotnet rPDU2MQTT/bin/Release/net10.0/rPDU2MQTT.dll --emit-schema > /tmp/schema.json
python3 docs-site/generate-settings.py /tmp/schema.json

# build (or serve)
netdocs build --config docs-site/appsettings.json
```

The `Docs` workflow builds the site and publishes it to GitHub Pages from `main`.
