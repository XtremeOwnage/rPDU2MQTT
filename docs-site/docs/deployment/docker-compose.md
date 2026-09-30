---
title: Docker Compose
---

# Docker Compose

`docker-compose.yaml` ([example](https://github.com/XtremeOwnage/rPDU2MQTT/blob/main/Examples/Docker-Compose/docker-compose.yaml)):

```yaml
services:
  rpdu2mqtt:
    image: ghcr.io/xtremeownage/rpdu2mqtt:stable
    container_name: rpdu2mqtt
    restart: unless-stopped
    volumes:
      - ./config.yaml:/config/config.yaml
      - ./history:/data/history
    environment:
      RPDU2MQTT_HISTORY_DIRECTORY: /data/history
      RPDU2MQTT_MQTT_USERNAME: rpdu2mqtt
      RPDU2MQTT_MQTT_PASSWORD: "change-me"
      RPDU2MQTT_PDU_USERNAME: hass
      RPDU2MQTT_PDU_PASSWORD: "change-me"
    ports:
      - "8080:8080"   # GUI
      - "9184:9184"   # Prometheus /metrics

  # Optional: durable daily totals. Set Cache.Enabled: true and Cache.Connection: valkey:6379.
  valkey:
    image: valkey/valkey:8-alpine
    restart: unless-stopped
    command: ["--appendonly", "yes", "--dir", "/data"]
    volumes:
      - valkey-data:/data

volumes:
  valkey-data:
```

```bash
docker compose up -d
docker compose logs -f
```

Without Valkey, daily totals are kept in `energy-totals.json` beside the binary.
