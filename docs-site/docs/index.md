---
title: rPDU2MQTT
description: Whole-house energy monitoring. Solar, battery, grid, breaker panels, circuits, outlets and floor plans, published to MQTT, Home Assistant, Prometheus and EmonCMS.
---

# rPDU2MQTT

Whole-house energy monitoring, from the solar array to the outlet. Configured in a web GUI.

- Reads PDUs, MQTT, Modbus TCP, EmonCMS and Home Assistant.
- Builds one hierarchy: grid, solar, battery, inverter, panels, breakers, circuits, devices, outlets.
- Publishes to MQTT, Home Assistant (including the Energy Dashboard), Prometheus and EmonCMS.

[Install](getting-started/installation.md){ .md-button .md-button--primary } [Quick start](getting-started/quickstart.md){ .md-button }

![Overview: solar, grid, battery and home, with today's totals](assets/screenshots/home-overview.webp)

## Energy flow

Every node, every metric, live. Sankey, sunburst or treemap.

![Sankey diagram: solar and grid through the inverter and main panel to circuits and PDU outlets](assets/screenshots/home-sankey.webp)

=== "Treemap"

    ![Treemap of the house load](assets/screenshots/home-treemap.webp)

=== "Sunburst"

    ![Sunburst of the house load](assets/screenshots/home-sunburst.webp)

[Energy flow](energy-flow/flow.md)

## Breaker panels

The panel schedule as it is in the box: slot, breaker, wire, gauge, rating and live load per circuit.

![Panel schedule with live watts per breaker](assets/screenshots/home-panel.webp)

[Panels and circuits](energy-flow/panels.md)

## Floor plans and circuit mapping

Rooms, doors and windows, outlets, lights and appliances, and the cable runs between them. Rooms are shaded by what they draw.

![Floor plan with circuits drawn from the panel to each outlet and appliance](assets/screenshots/home-floor-plan.webp)

Click an item for its circuit, meter and wiring.

![Floor plan with the fridge selected](assets/screenshots/home-floor-plan-item.webp)

Draw rooms, place items and route wires in the editor.

![Floor plan editor](assets/screenshots/home-floor-plan-edit.webp)

[Floor plans](energy-flow/floor-plans.md)

## Vertiv / Geist rack PDUs

Per-outlet power, energy, current and voltage. Outlet on, off and reboot from the GUI or Home Assistant. OneView cluster roll-ups and group actions.

![PDU Control page](assets/screenshots/pdu-control.webp)

[Vertiv rPDU](vertiv/index.md)

## Everything in the GUI

Every setting has a page. No YAML needed.

=== "MQTT"

    ![MQTT settings page](assets/screenshots/mqtt.webp)

=== "Home Assistant"

    ![Home Assistant settings page](assets/screenshots/home-assistant.webp)

=== "Nodes"

    ![Node editor](assets/screenshots/node-editor-ev.webp)

=== "Trends"

    ![Trends page](assets/screenshots/trends.webp)

## Sources and destinations

| Sources | Destinations |
| --- | --- |
| Vertiv / Geist PDUs (HTTP API) | MQTT |
| MQTT topics (Solar Assistant, IotaWatt, ESPHome, Tasmota, …) | Home Assistant discovery and Energy Dashboard |
| Modbus TCP registers | Prometheus (`/metrics`, Pushgateway) |
| EmonCMS feeds | EmonCMS |
| Home Assistant entities | Local history store |
| Plugins | Plugins |

## Deployment

Docker, Docker Compose, Helm chart, Argo CD, optional `RpduConfig` custom resource. [Deployment](deployment/index.md)

## Help

- [Discord](https://static.xtremeownage.com/discord) (tag **@XtremeOwnage**)
- [GitHub issues](https://github.com/XtremeOwnage/rPDU2MQTT/issues/new/choose)

!!! note "Screenshots"
    Screenshots are rPDU2MQTT 2.0.0 running against simulated devices.
