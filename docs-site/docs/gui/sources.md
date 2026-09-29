---
title: Sources pages
---

# Sources pages

## Vertiv rPDU

PDU instances to bridge, keyed by instance name: connection, credentials, poll interval, write
actions, Home Assistant model/manufacturer remapping and EmonCMS tags. **Open default ↗** opens the
PDU's own web UI. See [PDUs](../configuration/pdus.md).

![Vertiv rPDU page](../assets/screenshots/vertiv-rpdu.webp)

## Overrides

Names, ids and enabled state for the bridge, each device, each outlet, each measurement type and each
OneView group, listed from the live PDU data. See [Overrides](../configuration/overrides.md).

![Overrides page](../assets/screenshots/overrides.webp)

## Live Data

Current measurements pulled from the PDUs on each poll. **Grouped (by outlet)** gives one row per
outlet or entity with a column per measurement and the outlet state; the flat view gives one row per
reading. Both filter, and the **Live** toggle keeps it updating.

![Live Data page, grouped by outlet](../assets/screenshots/live-data.webp)

## PDU Control

Turn outlets on or off, reboot them, reset their statistics, or rename them on the PDU. Needs
`ActionsEnabled` and PDU credentials on the instance; OneView groups get group-wide actions here too.

![PDU Control page](../assets/screenshots/pdu-control.webp)

## Paths

The MQTT topic, Prometheus metric and EmonCMS key generated for each measurement, reflecting your
overrides. Click any value to copy it. See [MQTT topics](../reference/mqtt-topics.md).

![Paths page](../assets/screenshots/paths.webp)
