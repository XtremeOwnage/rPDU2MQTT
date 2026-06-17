# rPDU2MQTT — Improvements & Known Issues

## ✅ Done

### Correctness
- [x] **Retained-message cleanup** — stale `homeassistant/device/<id>/config` topics are cleared
  when a device disappears between discovery runs.
- [x] **`JsonAttributes` flatten landmine** — removed the broken flatten converter + unused types.
- [x] **No-override naming NRE** — falls back to the identifier instead of throwing.
- [x] **Nullable derefs in `PDU.cs`** — explicit null guards added.
- [x] **`Debugger.Break()` fallbacks** — replaced with warning logs.

### Robustness / quality
- [x] **Graceful shutdown** — `StopAsync` cancels the loop and drains it.
- [x] **Sync-over-async** — timer loop runs without `Task.Run(...).Wait()`.
- [x] **Build warnings** — all eliminated (0); CS8618 scoped via `.editorconfig`.
- [x] **Credentials out of config** — env vars `RPDU2MQTT_*` / `*_FILE` (Docker secrets).
- [x] **.NET 10** + dependency refresh.

### Features
- [x] **Contextual default device names** — outlet names prefixed with their PDU.
- [x] **Device hierarchy** — PDU→outlet ownership via `via_device`.
- [x] **Outlet on/off control** — opt-in via `ActionsEnabled` (switch entities + command subscriber +
  PDU control), verified on live hardware incl. the OneView cluster (proxy-port routing).
- [x] **Alarm integration** — device + outlet `problem` binary_sensors from the PDU alarm state.
- [x] **`expire_after` / QoS tuning**.
- [x] **Configuration GUI (#69/#70)** — embedded web GUI: password-protected, structured form
  generated from the config model, live-data view, MQTT/PDU tests, YAML/CR export, saves config.
- [x] **GUI/CRD help text (#75)** — friendly field labels + descriptions; `ActionsEnabled` shown as
  **"Enable Write Actions"**; write-actions confirmed gated (no switches when disabled).
- [x] **Per-entity Make/Model override (#76)** — `Overrides.*.Make/Model` (e.g. Dell / PowerEdge);
  also fixed the GUI outlet index to 1-based.
- [x] **HA device info (#86)** — PDU device shows MAC + IP (`connections`); outlet device shows the
  outlet number (`serial_number`).
- [x] **MQTT Last-Will / availability toggle (#87)** — `MQTT.LastWill`; when off, entities rely on
  `SensorExpireAfterSeconds` (`expire_after`).
- [x] **OneView group rollup sensors (#84)** — per-group aggregates + the cluster-wide **Total**
  (pduTotal). NOTE: group **member/master switches are NOT possible** — the OneView API exposes only
  aggregate measurements with no member-outlet list (see [Aggregation.md](docs/Aggregation.md)).
- [x] **Prometheus exporter + Pushgateway push (#73)** — independent `Exporter` / `Pushgateway` toggles.

### Ops / deployment
- [x] **GHCR publishing** — `main`→`:stable`, branches→`:dev`, tags→`:<version>`.
- [x] **Helm chart (#71)** — config ConfigMap, credentials Secret, Deployment, optional GUI
  Service/Ingress, metrics Service + Prometheus Operator `ServiceMonitor`.
- [x] **Kubernetes CRD config source (#71)** — optional `RpduConfig` CRD (writable, GUI Save works,
  status subresource, generated schema). See [KubernetesCRD.md](docs/KubernetesCRD.md).
- [x] **Deployment Guide + config docs (#85)** — compose / Helm / CRD / unRAID, secrets, verifying.
- [x] **Simpler config format** — evaluated; see [ConfigFormatEvaluation.md](docs/ConfigFormatEvaluation.md).

## 🚧 Planned (batched — roughly in order; each is one PR)

### Batch A — Outlet operations & config (write actions)
All PDU outlet control/config surfaced as HA entities, gated by **Enable Write Actions**. Shared
control + discovery + command-subscriber path, so they synergize.
- [ ] **Reboot button** (outlet / device).
- [ ] **Reset Statistics button** (outlet / device) — exposed by the PDU as an operation, like reboot.
- [ ] **Configurable On / Off / Reboot delays** — HA `number` entities.
- [ ] **Power-On Action** — HA `select` (dropdown).
- Refs: image-3, image-4, image-5. ⚠️ Write actions — needs verification on real hardware.

### Batch B — Alarm configuration
- [ ] View/configure PDU **alarm thresholds + actions** via the GUI and MQTT.
- Synergy: builds on the write-action/control plumbing from Batch A + the GUI.

### Batch C — GUI enhancements
- [ ] Improve the **Live Data** view (richer layout) — ref image-6.
- [ ] Show the **actual generated HA / Prometheus topics + metric types**, and how overrides affect
  them (a "what will be published" preview).
- Synergy: both are GUI visibility features in the embedded app.

### Batch D — Diagnostics & health
- [ ] **GUI Diagnostics/Status page**: uptime, app + container version, **Restart** button (kills the
  app so the container restarts), and — when running in Kubernetes — view logs/events.
- [ ] **Health-check endpoints** (liveness + readiness) and **Helm probe support** (optional, default on).
- Synergy: operational visibility lives together; the health endpoints pair with the Helm probes.

### Batch E — Helm / Kubernetes networking
- [ ] **NetworkPolicy** support (optional).
- [ ] **HTTPRoute** (Gateway API) support.
- Synergy: chart networking add-ons; pairs with Batch D's k8s work.

### Batch F — Tests & docs polish (do last)
- [ ] Expand **unit tests** (spec/CRD generation, mapping); evaluate Helm chart tests / a
  `helm template` + `kubectl --dry-run` smoke job in CI.
- [ ] **README + screenshots** — Home Assistant, EmonCMS, Prometheus, and the GUI in use (commit the
  `image-*.png` assets the TODO references).
- Synergy: quality + presentation; last so screenshots reflect the final UI.

## 📌 Misc
- [ ] **Release** — tag a version (v0.4.x) once the above land; consider a dedicated GitHub Release
  workflow (changelog/artifacts) beyond the container build.
