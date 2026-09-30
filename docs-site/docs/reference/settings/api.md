---
title: API
---

# API

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Read-only REST API + OpenAPI/Scalar docs

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Api` | object |  | Read-only REST API + OpenAPI/Scalar docs |
| `Api.Enabled` | bool | `false` | Expose a read-only REST API (/api/v1/*) with OpenAPI + Scalar docs on its own port. Place it on a trusted network — it is unauthenticated, like the health endpoints. |
| `Api.Port` | int | `8082` | Port the REST API + docs listen on. |
| `Api.ApiKey` | string (secret) |  | Optional API key enabling the write/control endpoints (or set RPDU2MQTT_API_KEY). When unset, the API is read-only; when set, control requests must send a matching 'X-Api-Key' header. Reads stay open (trusted-network). |
