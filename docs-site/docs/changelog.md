---
title: Changelog
---

# Changelog

Full release notes: [GitHub releases](https://github.com/XtremeOwnage/rPDU2MQTT/releases).

## 2.0.0 (2026-09-29)

### Architecture

- Multiple PDUs per install: `Pdus:` map of named instances. `PDU:` migrates to `Pdus.default`.
- In-process message bus and snapshot pipeline.
- REST API with OpenAPI and API key for control.
- Project split: Abstractions, Core, Engine, Api, Web.
- Roles: `worker`, `api`, `ui`, `operator`.
- Integrations as plugins.
- Kubernetes operator with update checks and self-update.
- Leader lease for graceful rollouts; Valkey cache.

### Energy flow

- Nodes with MQTT, Modbus TCP, EmonCMS, Home Assistant and derived sources.
- Sankey, sunburst and treemap views.
- Hierarchy editor, groups, tags, balance.
- Energy and Overview pages.
- Trends, Node Trends, Node Data.
- Daily totals (`energy_d`) and energy aggregation.
- Panel schedule, circuit finder, floor plans.

### Integrations

- Home Assistant Energy Dashboard sync.
- MQTT import and topic explorer.
- Modbus explorer and device templates.
- Local history store; copy history between backends.
- Cost charts.

### Upgrade notes

See [Upgrading to 2.0](getting-started/upgrading-to-2.0.md).

## 1.0.0 (2026-06-23)

Vertiv / Geist rPDU integration.

- .NET 10.
- Web GUI: configuration form, outlet control, Live Data, Paths, Diagnostics. Basic, OIDC or no authentication.
- Two-way control: outlet on/off/reboot, delays, power-on action, reset statistics; rename outlet, PDU and circuit labels.
- Home Assistant discovery improvements; MQTT Last Will.
- OneView roll-ups and group actions.
- Prometheus: scrape endpoint, Pushgateway, metric name template.
- EmonCMS: input name templates, MQTT transport.
- Helm chart, `RpduConfig` CRD, NetworkPolicy, HTTPRoute, Argo CD example.

### Upgrade notes

- Default MQTT topic in the chart and examples changed from `Rack_PDU` to `rPDU2MQTT`. Existing configs are unchanged.
- EmonCMS input names default to `{device}_{source}_{type}`, which creates new inputs. Set `EmonCMS.InputNameTemplate: ""` for the old names.

## 0.x

One-way MQTT publisher for a Vertiv / Geist PDU. Last release: [v0.3.5](https://github.com/XtremeOwnage/rPDU2MQTT/releases/tag/v0.3.5).
