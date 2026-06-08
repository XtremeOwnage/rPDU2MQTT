# Configuration Format — Evaluation

Evaluation of whether to adopt a simpler configuration format than the current YAML.

## Current state

- YAML, parsed with YamlDotNet (`YamlConfigLoader`).
- Strongly-typed schema with defaults, required-member enforcement, and case-insensitive keys.
- Secrets can now come from the environment (`RPDU2MQTT_*` / `*_FILE`), so they no longer
  need to live in the file.

## Where it actually hurts

1. **Override nesting is verbose.** `Overrides.Devices.<id>.Outlets.<n>.ID/Name/Enabled` is several
   levels deep, and outlet keys are numbers. This is the bulk of a real config.
2. **Repeated `Connection` blocks** for MQTT and PDU.
3. **Not obvious what the minimum is.** Most keys have sensible defaults, but that isn't visible.

## Options considered

| Option | Pros | Cons |
| --- | --- | --- |
| A. Keep YAML, reduce required surface + flatten overrides | No breaking change, no new deps, biggest pain (overrides) addressed | Still YAML |
| B. Switch to TOML | Flatter, less indentation-sensitive | Breaks every existing config; new dependency; marginal gain |
| C. Env-vars only | Great for simple/container setups | Can't express per-outlet overrides cleanly |

## Recommendation: Option A (incremental), not a format switch

Switching formats (B) breaks all existing users and adds a dependency for little real benefit —
YAML isn't the problem, the *shape* is. Recommended, in priority order:

1. **Document the minimal config.** Today the smallest working file is essentially:

   ```yaml
   Mqtt:
     Connection: { Host: "mqtt.example.com" }
   Pdu:
     Connection: { Host: "pdu.example.com" }
   ```
   (credentials via env; everything else defaulted). Make this the first example in the docs.

2. **Flatten outlet overrides.** Allow a single map keyed by `"<deviceId>:<outlet>"`, e.g.:

   ```yaml
   Overrides:
     Outlets:
       "A0AE...:11": { ID: crs504, Name: "CRS504" }
   ```
   alongside the existing nested form (parse both; nested stays supported). This removes the
   deepest level of nesting where configs spend most of their lines.

3. **Allow inline `Connection` shorthand** like `Host: "host:port"` to collapse the common case.

## Suggested next step

Land (1) as a docs change now (cheap, high value). Treat (2)/(3) as a follow-up feature with a
compatibility shim so existing configs keep working. Do **not** pursue a wholesale format switch.
