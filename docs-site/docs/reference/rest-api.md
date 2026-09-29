---
title: REST API
---

# REST API

A read-only REST API with OpenAPI + a [Scalar](https://scalar.com/) docs UI, hosted on its own port
and independent of the GUI. Off by default; intended for monitoring/automation on a **trusted
network** (it is unauthenticated, like the health endpoints).

```yaml
Api:
  Enabled: false        # default
  Port: 8082            # default
  ApiKey: ""            # optional; set to enable the write/control endpoints (see below)
```

`ApiKey` can also be supplied out of band as **`RPDU2MQTT_API_KEY`** (or `RPDU2MQTT_API_KEY_FILE`
pointing at a file, e.g. a Docker/Kubernetes secret), like the other credentials. With the Kubernetes
config source this is **required** rather than optional: the API key is stripped from the `RpduConfig`
CR along with every other secret, so it has to come from the environment.

| Endpoint | Description |
| --- | --- |
| `GET /api/v1/instances` | Configured PDU instances (id, primary, host, poll interval, actions). |
| `GET /api/v1/health` | Uptime, MQTT connectivity, last poll. |
| `GET /api/v1/snapshots` | Latest snapshot timestamp/age per instance. |
| `GET /api/v1/readings` | Flattened measurements from the latest snapshot(s); filter with `?instance=`. |
| `GET /openapi/v1.json`, `/scalar/v1` | OpenAPI document + interactive docs UI. |

Browsing to the API port's root (`/`) redirects to `/scalar/v1`. The GUI's **Api** page also links
straight to these URLs. Because the API listens on its own port, those links only resolve if that port
is reachable from your browser — in Kubernetes, expose it via the chart's `service: api` route (see
[the chart README](../deployment/helm.md)).

## Control endpoints (opt-in)

Outlet/group control is **disabled unless `Api.ApiKey` is set**. When set, write requests must send a
matching `X-Api-Key` header, the target instance must exist, and that instance must have
`ActionsEnabled: true`.

| Endpoint | Body | Description |
| --- | --- | --- |
| `POST /api/v1/instances/{id}/outlets/{deviceId}/{index}/control` | `{ "action": "on\|off\|reboot\|resetStats" }` | Control one outlet on instance `id`. |
| `POST /api/v1/instances/{id}/groups/{groupKey}/control` | `{ "action": "on\|off\|reboot" }` | Control every outlet in a OneView group. |

```bash
curl -X POST -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"action":"reboot"}' \
  http://rpdu2mqtt:8082/api/v1/instances/default/outlets/DEVICE/0/control
```
