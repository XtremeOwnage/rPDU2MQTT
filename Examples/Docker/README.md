# Deploying `rpdu2mqtt` with plain Docker

The simplest way to run the service — a single `docker run`. (Prefer [Docker Compose](../Docker-Compose/README.md) for anything long-lived.)

## 1. Create a config file

Create a `config.yaml` next to where you'll run the command. See the
[Configuration guide](../../docs/Configuration.md) and the
[examples](../Configuration/) (`minimum-configuration-example.yaml` is a good start).

## 2. Run it

```bash
docker run -d \
  --name rpdu2mqtt \
  --restart unless-stopped \
  -v "$(pwd)/config.yaml:/config/config.yaml:ro" \
  -e RPDU2MQTT_MQTT_PASSWORD="change-me" \
  -e RPDU2MQTT_PDU_PASSWORD="change-me" \
  -p 8080:8080 \
  ghcr.io/xtremeownage/rpdu2mqtt:stable
```

- `-v .../config.yaml:/config/config.yaml:ro` — mount your config (drop `:ro` to let the GUI save edits).
- `-e RPDU2MQTT_*` — keep credentials out of the file (see [Credentials & secrets](../../docs/Configuration.md#credentials-via-environment--secrets-optional)); `*_FILE` variants are supported for Docker secrets.
- `-p 8080:8080` — only needed if `Gui.Enabled`. Add `-p 9184:9184` for the Prometheus exporter and `-p 8081:8081` for health checks if you enable them.

## 3. Verify

```bash
docker logs -f rpdu2mqtt
```

You should see it connect to MQTT and start publishing. With `HomeAssistant.DiscoveryEnabled`, the devices appear in Home Assistant automatically.
