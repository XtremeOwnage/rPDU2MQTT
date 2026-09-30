---
title: REST API
---

# REST API

Read-only REST API with OpenAPI and a [Scalar](https://scalar.com/) docs UI, on its own port. Off by default. Config file only. Reads are unauthenticated.

```yaml
Api:
  Enabled: false        # default
  Port: 8082            # default
  ApiKey: ""            # optional; set to enable the write/control endpoints (see below)
```

`ApiKey` can also come from `RPDU2MQTT_API_KEY` or `RPDU2MQTT_API_KEY_FILE`. With the Kubernetes config source it must come from the environment.

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/instances` | Configured PDU instances (id, primary, host, poll interval, actions). |
| `GET /api/v1/health` | Uptime, MQTT connectivity, last poll. |
| `GET /api/v1/snapshots` | Latest snapshot timestamp/age per instance. |
| `GET /api/v1/readings` | Flattened measurements from the latest snapshot(s); filter with `?instance=`. |
| `GET /openapi/v1.json`, `/scalar/v1` | OpenAPI document + interactive docs UI. |

`/` redirects to `/scalar/v1`. In Kubernetes, route to it with `service: api` ([Helm chart](../deployment/helm.md#exposing-the-rest-api)).

## Control endpoints (opt-in)

Disabled unless `Api.ApiKey` is set. Requests need a matching `X-Api-Key` header, and the instance needs `ActionsEnabled: true`.

| Endpoint | Body | Description |
| --- | --- | --- |
| `POST /api/v1/instances/{id}/outlets/{deviceId}/{index}/control` | `{ "action": "on\|off\|reboot\|resetStats" }` | Control one outlet on instance `id`. |
| `POST /api/v1/instances/{id}/groups/{groupKey}/control` | `{ "action": "on\|off\|reboot" }` | Control every outlet in a OneView group. |

```bash
curl -X POST -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"action":"reboot"}' \
  http://rpdu2mqtt:8082/api/v1/instances/default/outlets/DEVICE/0/control
```
