---
title: Getting started
---

# Getting started

1. [Installation](installation.md): container, Helm chart, or source.
2. [Quick start](quickstart.md): minimal config, then set everything else in the GUI.
3. [Configuration](configuration.md): where settings live.
4. [Upgrading to 2.0](upgrading-to-2.0.md): changes for 1.x installs.

## Requirements

- An MQTT broker.
- Optional: a Vertiv / Geist rack PDU reachable over HTTP (the master node for a OneView cluster). Other sources can feed the [energy flow](../energy-flow/index.md) without a PDU.

## Ports

| Listener | Default port |
| --- | --- |
| GUI | 8080 |
| Health | 8081 |
| REST API | 8082 |
| Prometheus `/metrics` | 9184 |
