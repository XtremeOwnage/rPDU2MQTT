---
title: Health checks
---

# Health checks

The bridge exposes lightweight HTTP health endpoints for container/orchestrator probes, enabled by
default on their own port:

```yaml
Health:
  Enabled: true   # default
  Port: 8081      # default
```

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | **Liveness** — the process is up (always `200 OK` while running). |
| `GET /readyz` | **Readiness** — `200` when MQTT is connected and the PDU has been polled recently; otherwise `503`. |

The Helm chart wires these as `livenessProbe` / `readinessProbe` automatically (toggle with
`healthProbes.enabled`, default on). For Docker Compose you can point a `healthcheck` at `/healthz`.
