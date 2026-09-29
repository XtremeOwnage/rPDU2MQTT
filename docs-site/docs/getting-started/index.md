---
title: Getting started
---

# Getting started

rPDU2MQTT is one process that reads energy data from your PDUs and other sources, arranges it into a
hierarchy, and publishes it to MQTT, Home Assistant, Prometheus and EmonCMS.

1. **[Installation](installation.md)** — the container image, the Helm chart, or a build from source.
2. **[Quick start](quickstart.md)** — a minimal `config.yaml`, the first run, and the GUI.
3. **[Upgrading to 2.0](upgrading-to-2.0.md)** — what changed for existing 1.x installs.

## What you need

- An **MQTT broker** reachable from wherever rPDU2MQTT runs.
- For the PDU bridge, a **Vertiv/Geist rack PDU** reachable over its web/JSON API (for a OneView cluster,
  the master node). A PDU is optional once other sources feed the [energy flow](../energy-flow/index.md).
- A **`config.yaml`**. See [Configuration](../configuration/index.md).

## The mental model

- **Sources** produce readings: PDU instances under `Pdus`, and node bindings under `EnergyFlow.Nodes`
  (MQTT, Modbus TCP, EmonCMS, Home Assistant, derived).
- **The energy flow** joins those readings into one graph of nodes and links, rolled up per metric.
- **Destinations** consume them: MQTT (with Home Assistant discovery), Prometheus and EmonCMS.
- **The GUI, API and health endpoints** each listen on their own port (8080, 8082 and 8081 by default).
