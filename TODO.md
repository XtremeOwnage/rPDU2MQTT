# rPDU2MQTT — Improvements & Known Issues

## ✅ Done

### Correctness
- [x] **Retained-message cleanup** — stale `homeassistant/device/<id>/config` topics are cleared
  when a device disappears between discovery runs (component removals are handled by republishing).
- [x] **`JsonAttributes` flatten landmine** — removed the broken flatten converter and the unused
  `JsonAttributes`/`JsonAttributeSettings` types.
- [x] **No-override naming NRE** — falls back to the identifier instead of throwing.
- [x] **Nullable derefs in `PDU.cs`** — explicit null guards added.
- [x] **`Debugger.Break()` fallbacks** — replaced with warning logs.

### Robustness / quality
- [x] **Graceful shutdown** — `StopAsync` cancels the loop and drains it.
- [x] **Sync-over-async** — timer loop runs without `Task.Run(...).Wait()`.
- [x] **Build warnings** — all eliminated (0); CS8618 scoped via `.editorconfig`.
- [x] **Credentials out of config** — env vars `RPDU2MQTT_*` / `*_FILE` (Docker secrets).
- [x] **Tests** — xUnit project with helper/converter tests.

### Features
- [x] **Contextual default device names** — outlet names prefixed with their PDU.
- [x] **Device hierarchy** — verified PDU→outlet ownership via `via_device`.
- [x] **Outlet on/off control** — opt-in via `ActionsEnabled` (`switch` entities + command
  subscriber + PDU control). NOTE: PDU control endpoint is from the Geist/Vertiv spec and is
  **unverified against live hardware**.
- [x] **Alarm integration** — device + outlet `problem` binary_sensors from the PDU alarm state.
- [x] **`expire_after` / QoS tuning** — `expire_after` derived from `PollInterval`; state at QoS 1.

### Ops
- [x] **GHCR publishing** — workflow fixed (built-in BuildKit, no Docker Hub dependency) with
  tagging: `main`→`:stable`, other branches→`:dev`, release tags→`:<version>`. (Already publishes
  to GHCR, not Docker Hub.)
- [x] **Simpler config format** — evaluated; see [ConfigFormatEvaluation.md](ConfigFormatEvaluation.md)
  (recommendation: incremental YAML improvements, not a format switch).

## 📌 Open

- [ ] **Push / release** — this session's commits live on local `working-branch`. Push it (builds
  `:dev`) and tag `v0.4.0` to publish a release image.
- [ ] **Outlet control — verify PDU endpoint** against live hardware before relying on it.
- [ ] **Release workflow** — consider a dedicated GitHub Release workflow (changelog/artifacts)
  beyond the container build.
- [ ] **README & documentation** — make the README more thorough and less AI-generated in tone.
