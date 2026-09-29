---
title: Web GUI tour
---

# Web GUI tour

The embedded GUI configures the bridge, shows what it is reading, controls outlets and draws the energy
flow. It is off by default; turn it on with `Gui.Enabled` (see [Configuration GUI](../configuration/gui.md)).

!!! note "Demo data"
    These screenshots are rPDU2MQTT 2.0.0 in dark mode, running against a simulated Vertiv PDU (ten
    outlets), simulated Solar Assistant and IotaWatt topics on a local Mosquitto broker, and 30 days of
    generated history. The house, its numbers and its floor plan are made up.

![Overview page](../assets/screenshots/overview.webp)

## Layout

- **Header:** the **Jump to…** search (Ctrl+K), the **Live** and **MQTT** connection indicators, the
  light/dark toggle and the running version.
- **Sidebar:** pages grouped by where data comes from and goes to. A page for a feature that is off
  stays hidden until the feature is turned on.

| Group | Pages |
| --- | --- |
| — | [Overview](#overview) |
| Sources | [Vertiv rPDU, Overrides, Live Data, PDU Control, Paths](sources.md) |
| Energy Flow | [Energy, Nodes, Groups, Balance, Tags, Flow, Roll-up, Hierarchy, Settings, Trends, Node Trends, Circuit Finder, Panel Schedule, Floor Plans, Node Data](energy-flow.md) |
| Integrations | [MQTT, MQTT Import, Modbus TCP](integrations-and-destinations.md#integrations) |
| Destinations | [Home Assistant, HA Energy Mapping, Prometheus, EmonCMS](integrations-and-destinations.md#destinations) |
| System | [History, Logging, GUI, Status, Export, Diagnostics](system.md) |

## Overview

What the system is doing now, what it has done today, and anything that needs attention. The banner
sums up component health and links to the Status board. The flow diagram shows solar, grid, battery
and home power; the cards below give today's solar produced, grid imported and exported, home used and
self-sufficiency, then the last 24 hours. Nothing on the page is estimated: a figure nothing measured
is shown as a dash.

Which nodes count as solar, grid, battery and home is set on the [Balance](energy-flow.md#balance)
page.
