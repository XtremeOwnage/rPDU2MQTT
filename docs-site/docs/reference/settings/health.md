---
title: Health
---

# Health

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

HTTP health-check endpoints

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Health` | object |  | HTTP health-check endpoints |
| `Health.Enabled` | bool | `true` | Expose HTTP health-check endpoints: /healthz (liveness) and /readyz (readiness). |
| `Health.Port` | int | `8081` | Port the health-check endpoints listen on. |
