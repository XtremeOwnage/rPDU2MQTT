---
title: Live Data, PDU Control, Paths
---

# Live Data, PDU Control, Paths

## Live Data

**Sources › Live Data**. Every PDU reading. **Grouped** (by outlet) or **Flat** (one row per reading).

![Live Data page](../assets/screenshots/live-data.webp)

## PDU Control

**Sources › PDU Control**. Needs **Enable Write Actions** and PDU credentials.

![PDU Control page](../assets/screenshots/pdu-control.webp)

| Control | Action |
| --- | --- |
| Label (on PDU) + **Set** | Writes the PDU, circuit or outlet label to the PDU |
| **Reset** | Clears the label on the PDU |
| **On** / **Off** / **Reboot** | Outlet power |
| **Reset Stats** | Resets the outlet's energy counter |
| Group **All On** / **All Off** / **Reboot All** | OneView groups |

Each row shows the outlet's on / off / reboot delays and power-on action. The next poll shows the state the PDU reports.

## Paths

**Sources › Paths**. The MQTT topic, Prometheus metric and EmonCMS input for every measurement.

![Paths page](../assets/screenshots/paths.webp)

Topic layout: [MQTT topics](../reference/mqtt-topics.md).
