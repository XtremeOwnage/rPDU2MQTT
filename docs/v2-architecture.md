# Version 2.0 Architecture (design)

**Status:** draft for review · **Tracking:** #127 · **Audience:** maintainers/contributors

This is the design for the Version 2.0 refactor. It captures the target architecture, the decisions
behind it, and an **incremental** migration plan that keeps v1.x working at every step. Nothing here is
built yet — it's the plan to review and steer before code churn.

## Goals (from #127)

1. **Multiple PDU instances** — connect to many PDUs, not one. Instances can be **added/removed from the
   GUI and loaded/unloaded at runtime** without a restart.
2. **Strict producer/consumer separation** — sources (PDUs, later MQTT inputs, inverters, etc.) are
   decoupled from sinks (MQTT/HA discovery, Prometheus, EmonCMS, future energy-flow mapping).
3. **Three components** — User Interface · Middle tier / API (config + cached data) · Automation / data
   processing (polls sources, moves data).
4. **REST API + Swagger** — a documented HTTP API for integration.
5. Enables later v2.0 features: energy-flow mapping into Home Assistant, extra producers (Tigo #130,
   inverter/transfer-switch streams), Sankey (#97).

## Decisions

- **Runtime model: Microsoft Orleans** (grains + streams, with Redis for persistence). Chosen over
  in-process `System.Threading.Channels`. Orleans gives us a natural unit of isolation per PDU instance
  (a grain), built-in lifecycle (activate/deactivate ≈ load/unload), streaming for producer→consumer
  fan-out, and an optional path to running distributed. (Trade-off: more concepts + infra than Channels;
  see *Risks*.)
- **Persistence: Redis** for grain state + the streaming provider, with an **in-memory/localhost default**
  so a single-node homelab deploy works with zero extra infra; Redis is opt-in for durability/distribution.
- **Design-doc-first**, then incremental PRs that each keep the app shippable.

## Current architecture (v1.x) and why it must change

```
Program.cs ─ Host ─ DI singletons: Config, IHiveMQClient, PDU, PduApiHandler
                     hosted services (all share the one PDU + broker):
                       MQTTPublishingService ─┐
                       PrometheusExportService ├─ each calls PDU.GetRootData_Public() (shared cache)
                       EmonCmsExportService    │
                       HomeAssistantDiscovery ─┘
                     GuiService (embedded web UI + REST-ish endpoints)
```

Limitations for v2.0:
- **Single instance everywhere** — `Config.PDU`, one `PDU` singleton, one MQTT client, wired once at
  startup. No notion of N sources.
- **No producer/consumer boundary** — consumers reach into the shared poll cache; there's no bus, so you
  can't add/remove sources or sinks independently, or at runtime.
- **One process, one project** — UI, API, and data processing are intermixed.

## Target architecture (v2.0)

### Component / project split

| Project | Role (#127 component) | Contents |
| --- | --- | --- |
| `rPDU2MQTT.Core` | shared | Contracts, DTOs (the snapshot/reading model), config schema, grain interfaces. No infra. |
| `rPDU2MQTT.Grains` | Automation / data processing | Orleans grains + the silo: source pollers, sink consumers, the instance manager. |
| `rPDU2MQTT.Api` | Middle tier / API | REST API + Swagger; reads/writes configuration; exposes cached data + control; talks to grains as an Orleans client. |
| `rPDU2MQTT.Web` | User Interface | The GUI (today's embedded web app), talking only to the API. |
| `rPDU2MQTT.Tests` | — | Unit/integration tests. |

> Packaging: these can still ship as a **single container** that co-hosts the silo + API + UI for the
> simple case, and be split across processes when running distributed. The project boundaries enforce the
> separation regardless of how it's deployed.

### Grains & streams

- **`IPduInstanceGrain`** (one activation per configured PDU) — owns the connection/session to a single
  PDU, polls on its interval, and **publishes `PduSnapshot` to an Orleans Stream** (one stream per
  instance, plus a broadcast stream). Activation = "load"; deactivation = "unload".
- **`IInstanceManagerGrain`** — the registry: add/remove/list source instances, start/stop them at
  runtime, and persist the set (Redis). Drives live add/remove from the GUI.
- **Consumer grains / services** — subscribe to the snapshot stream(s): `MqttSinkGrain`,
  `PrometheusSink`, `EmonCmsSink`, `HomeAssistantDiscoverySink`. Each is independent; adding/removing a
  sink doesn't touch the producers.
- **Streaming provider** — Orleans Streams over the chosen provider (memory by default; Redis/another for
  durability). This *is* the producer/consumer bus.

```
IInstanceManagerGrain ──manages──> IPduInstanceGrain (×N)
                                        │ polls each PDU
                                        ▼
                                 Stream<PduSnapshot>  ──fan-out──> MqttSink
                                                                   PrometheusSink
                                                                   EmonCmsSink
                                                                   HomeAssistantDiscoverySink
                                                                   (future) EnergyFlowMapper, Sankey…
```

### Configuration model

- `Config.PDU` (single) → **`Config.Pdus`**: a keyed collection of named PDU instances (each with its own
  connection, poll interval, credentials, overrides).
- Sinks (MQTT/Prometheus/EmonCMS/HA) become **consumer configs**, decoupled from any single source.
- The **CRD / GUI** gain add/remove for instances; the instance manager applies changes live.
- **Back-compat:** a v1 single-`PDU` config is auto-migrated to a one-entry `Pdus` map on load, so
  existing deployments keep working.

### REST API + Swagger

- `rPDU2MQTT.Api` exposes the operations the GUI already needs (config CRUD, live data, control, paths,
  diagnostics) as a documented REST API with Swagger/OpenAPI, plus instance add/remove/start/stop. The UI
  becomes a pure client of this API.

## Migration plan (incremental — each step ships)

1. **Introduce Orleans, co-hosted** — add a silo to the existing host (localhost clustering, in-memory
   storage/streams). No behavior change yet.
2. **Move polling into `IPduInstanceGrain`** — one grain wrapping today's single PDU; it publishes
   `PduSnapshot` to a stream. Existing services keep working (temporary shim reading the latest snapshot).
3. **Move consumers onto the stream** — convert MQTT/Prometheus/EmonCMS/HA to stream subscribers, one at
   a time, removing the shared-cache coupling.
4. **Multi-instance config + `IInstanceManagerGrain`** — `Config.Pdus`, with v1 auto-migration; add/remove
   instances (still restart-applied at first).
5. **Live add/remove** — manager starts/stops grains at runtime; GUI wired up.
6. **Project split + REST API/Swagger** — extract `Core`/`Grains`/`Api`/`Web`; UI talks to the API.
7. **Redis option** — opt-in persistence/streaming provider for durability/distribution.

Later (separate issues, built on this): energy-flow mapping (#128/#129), Tigo producer (#130),
Sankey (#97).

## Risks / open questions

- **Complexity & footprint** — Orleans adds a silo, grain lifecycle, and streaming concepts; the single
  binary grows. Mitigation: co-host + in-memory defaults so simple deploys need no Redis.
- **Redis dependency** — only when durability/distribution is enabled; keep it optional.
- **Docker/Helm** — one image co-hosting silo+API+UI for the simple path; chart gains optional Redis +
  (eventually) separate Deployments for distributed mode.
- **Config breaking change** — `PDU` → `Pdus`; covered by auto-migration, but the CRD schema + examples
  change. Needs a clear upgrade note at the v2.0 release.
- **Scope** — this is several PRs. Each migration step above is its own reviewable change.

## Not in scope here

- The actual energy-flow mapping / Sankey / Tigo features (separate v2.0 issues).
- Multi-tenant operator behavior (provisioning Deployments).
