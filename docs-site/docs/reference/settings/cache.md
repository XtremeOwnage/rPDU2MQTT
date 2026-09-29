---
title: Cache
---

# Cache

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Cache` | object |  |  |
| `Cache.Enabled` | bool | `false` | Use a Redis/Valkey instance for shared, durable state (today: the energy accumulator). |
| `Cache.Connection` | string | `localhost:6379` | Redis/Valkey endpoint, host:port. A full StackExchange.Redis connection string also works, e.g. "valkey:6379,ssl=false". |
| `Cache.Password` | string (secret) |  | Password, if the instance requires one. Leave blank for an unauthenticated instance on a trusted network. |
| `Cache.KeyPrefix` | string | `rpdu2mqtt:` | Prefix for every key written, so the instance can be shared with other applications. |
| `Cache.ConnectTimeoutSeconds` | int | `5` | Seconds to wait when connecting before falling back to local state. |
