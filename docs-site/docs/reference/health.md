---
title: Health checks
---

# Health checks

On by default, on their own port. Config file only.

```yaml
Health:
  Enabled: true
  Port: 8081
```

| Endpoint | Returns |
| --- | --- |
| `GET /healthz` | `200 OK` while the process runs |
| `GET /readyz` | `200 READY` when MQTT is connected and the PDU was polled recently; else `503 NOT READY: <reason>` |
| `GET /health/integrations` | JSON status of each integration. Does not affect readiness |

The Helm chart uses `/healthz` and `/readyz` as liveness and readiness probes (`healthProbes.enabled`, default on).
