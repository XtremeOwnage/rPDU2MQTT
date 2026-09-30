---
title: Quick start
---

# Quick start

## 1. Minimal config

`config.yaml`. Feature switches (`Gui.Enabled`, `HomeAssistant.DiscoveryEnabled`) are only set in the file.

```yaml
Mqtt:
  Connection:
    Host: "mqtt.lan"
    Port: 1883

Pdus:
  default:
    Connection:
      Host: "pdu.lan"
      Port: 80

Gui:
  Enabled: true
  Port: 8080
  AuthType: Basic
  Username: admin
  Password: "change-me"

HomeAssistant:
  DiscoveryEnabled: true
```

## 2. Run

```yaml
services:
  rpdu2mqtt:
    image: ghcr.io/xtremeownage/rpdu2mqtt:stable
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./config.yaml:/config/config.yaml   # writable, so the GUI can save
```

```bash
docker compose up -d
```

Browse to `http://<host>:8080` and sign in.

## 3. MQTT

**Integrations › MQTT**. Set credentials and press **Test MQTT connection**. **Save**.

![MQTT settings page](../assets/screenshots/mqtt.webp)

Details: [MQTT](../integrations/mqtt.md).

## 4. PDU

**Sources › Vertiv rPDU**. Check host and port, set credentials. Turn on **Enable Write Actions** for outlet control. **Save**.

![Vertiv rPDU page](../assets/screenshots/vertiv-rpdu.webp)

Details: [Vertiv rPDU](../vertiv/index.md).

## 5. Home Assistant

**Destinations › Home Assistant**. Check **Discovery Topic** matches Home Assistant's prefix. **Save**, then **Republish discovery**.

![Home Assistant settings page](../assets/screenshots/home-assistant.webp)

Details: [Home Assistant](../destinations/home-assistant.md).

## 6. Energy flow

**Energy Flow › Nodes**. Add nodes for grid, solar, battery, panels and circuits, and bind each to a source.

![Nodes page](../assets/screenshots/nodes.webp)

Details: [Nodes](../energy-flow/nodes.md), [Panels](../energy-flow/panels.md), [Floor plans](../energy-flow/floor-plans.md).

## 7. Check

**System › Status**. Every card green, or grey for not configured.

![Status page](../assets/screenshots/status.webp)

- MQTT: readings under `rPDU2MQTT/`. See [MQTT topics](../reference/mqtt-topics.md).
- Health: `http://<host>:8081/healthz` returns `OK`. See [Health checks](../reference/health.md).
