# rPDU2MQTT — Improvements & Known Issues

A backlog of potential improvements, problems, and things needing attention.
Grouped by priority. None of these are started yet.

## 🔴 Bugs / correctness

- [ ] **Retained-message cleanup** — the bridge should be able to purge stale retained
  topics from the broker (legacy `homeassistant/<platform>/…` configs, and entities/outlets
  that have been removed or disabled). Today nothing it publishes is ever un-published, so
  removed items linger forever.
- [ ] **`JsonAttributes` flatten landmine** — `baseEntity.JsonAttributes` still uses the
  `FlattenNullableObjectToParentObjectConverter` that produced malformed JSON for availability.
  It's null today so harmless, but it will break discovery the moment it is populated. Remove it
  or convert to direct properties.
- [ ] **No-override naming NRE** — in `EntityWithName_Overrides`, the *no-override* branch calls
  `DefaultNameFunc(entity).FormatName()`, which throws if an entity has a null name and no
  override (sibling of the display-name bug already fixed).
- [ ] **Nullable derefs in `PDU.cs`** — two `CS8602` warnings (~L182/L193): `parent` is
  dereferenced without a null guard.
- [ ] **`Debugger.Break()` fallbacks** — `PDU.processRecursive` (unknown entity type) and
  `EnumToPropertyNameConverter` silently break under a debugger and do nothing in production.
  Replace with real logging.

## 🟡 Robustness / quality

- [ ] **No graceful shutdown** — `baseMQTTService.StopAsync` is a no-op (`//Do Something?`); it
  doesn't stop the timer loop or disconnect MQTT cleanly, so shutdown relies on the LWT firing.
- [ ] **Sync-over-async** — `Task.Run(() => timerTaskExecution(ct).Wait())` blocks a thread-pool
  thread on `.Wait()`.
- [ ] **~95 `CS8618` warnings** — decide a strategy: scoped `NoWarn`/`.editorconfig` for the
  model namespaces, or annotate the DTO properties.
- [ ] **Plaintext credentials** — there is already a `# TODO: Move to external secret management`
  in `config.yaml`; support env-var / secret-file injection.
- [ ] **No tests** — no test project exists. Converters, naming/overrides, and discovery payload
  shape are good candidates (would have caught the flatten bug).

## 🟢 Features / nice-to-have

- [x] **Contextual default device names** — outlet device names are now prefixed with their PDU
  (e.g. "Rack-PDU-1 Dell: r730XD") so they're unambiguous across multiple PDUs.
- [x] **Device relationships / hierarchy** — verified: each outlet's `via_device` points to its
  PDU, and the PDU devices publish full info and own their outlets. Remaining (optional): the
  OneView aggregation root is still a bare stub (it has no entities of its own); naming it via
  device-discovery is unverified, so left as-is.
- [~] **Outlet on/off control** — implemented (opt-in via `ActionsEnabled`): a `switch` entity
  per outlet, a command-topic subscriber (`OutletCommandService`), and `PduApiHandler` token
  auth + `SetOutletStateAsync`. TWO follow-ups: (1) the config key is `ActionsEnabled`, but the
  sample/your config uses `Enable_Actions` — reconcile the key. (2) the PDU control
  endpoint/payload is from the Geist/Vertiv spec and is UNVERIFIED against live hardware.
- [ ] **Alarm integration** — the PDUs expose alarm functionality (there's already an `Alarm`
  model on measurements/devices). Surface these as HA entities (e.g. `binary_sensor` /
  problem device_class, or an alarm panel) so PDU alarms show up in HA.
- [ ] **`expire_after` / QoS tuning** — `expire_after` is hardcoded to 300s (can falsely mark
  entities unavailable with long poll intervals); state data publishes at QoS 0 (can be dropped).

## ⚙️ Ops

- [ ] **Branch / remote** — this session's commits are on a local `working-branch` with no
  upstream. If `v0.4.0` was intended, move/push the commits there.

## 🧭 Exploratory

- [ ] **Simpler configuration format** — evaluate a much simpler config file format than the
  current YAML schema (less nesting / boilerplate, easier for users to author).


Need to cleanup Github workflows. Workflows are not the best. need release workflows.... etc..

Need better readme and documentation. Need more thorough documentation. Needs to not appear overly AI generated.

I think this uses dockerhub??? Need to use GHCR instead....