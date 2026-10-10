---
title: Docker
---

# Docker

```bash
docker run -d \
  --name rpdu2mqtt \
  --restart unless-stopped \
  -v "$(pwd)/config.yaml:/config/config.yaml" \
  -e RPDU2MQTT_MQTT_PASSWORD="change-me" \
  -e RPDU2MQTT_PDU_PASSWORD="change-me" \
  -p 8080:8080 \
  ghcr.io/xtremeownage/rpdu2mqtt:stable
```

| Option | Purpose |
| --- | --- |
| `-v …:/config/config.yaml` | Config file. Add `:ro` to block GUI Save |
| `-e RPDU2MQTT_*` | Secrets. See [Environment variables](../system/environment-variables.md) |
| `-p 8080:8080` | GUI |
| `-p 9184:9184` | Prometheus exporter |
| `-p 8081:8081` | Health checks |

Mount a volume for local history and set `History.LocalPath` or `RPDU2MQTT_HISTORY_DIRECTORY` to it.

```bash
docker logs -f rpdu2mqtt
```
