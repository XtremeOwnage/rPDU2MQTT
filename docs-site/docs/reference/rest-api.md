---
title: REST API
---

# REST API

Read-only REST API with OpenAPI and a [Scalar](https://scalar.com/) docs UI, on its own port. Off by default. Config file only. Reads are unauthenticated.

```yaml
Api:
  Enabled: false        # default
  Port: 8082            # default
  ApiKey: ""            # optional; set to enable the write/control endpoints and /mcp (see below)
  McpEnabled: false     # default; see "MCP endpoint" below
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

## MCP endpoint (opt-in)

A read-only [Model Context Protocol](https://modelcontextprotocol.io/) server at `/mcp` on the API port
(streamable HTTP, stateless), so an AI assistant such as Claude can query the bridge.

```yaml
Api:
  Enabled: true
  ApiKey: "a-long-random-string"   # required for /mcp
  McpEnabled: true
```

- Stays off, with a warning, until `Api.ApiKey` is set.
- Auth: `Authorization: Bearer <key>`, `X-Api-Key: <key>`, or `?key=<key>` in the URL.
- Tools: `list_instances`, `get_health`, `get_status`, `list_snapshots`, `get_readings`, `get_flow`,
  `get_history` (needs `History.Enabled`). None of them change state.
- The key also unlocks the control endpoints. `/api/v1` reads stay unauthenticated, so when exposing
  `/mcp` publicly, route only `/mcp` through the reverse proxy.
- Helm: `httpRoute.mcp: true` adds a `/mcp` rule to the API Service on the chart's HTTPRoute.

Claude (claude.ai, desktop, mobile): **Settings > Connectors > Add custom connector**, URL
`https://<your-host>/mcp?key=<key>`.

Claude Code:

```bash
claude mcp add --transport http rpdu2mqtt https://<your-host>/mcp --header "Authorization: Bearer <key>"
```
