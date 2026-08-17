# v4 — Integrations as plugins

Sources, destinations and devices are already plugins in everything but registration. One of them proves
it: history backends have had a clean contract since #372. This is the plan for extending that pattern to
the rest, and deleting the hand-maintained lists that stand in for it today.

Tracked in [ToDo.md](ToDo.md). What shipped and why: [docs/v4-plugins.md](docs/v4-plugins.md).
Author guide: [Examples/Plugins/README.md](Examples/Plugins/README.md). Prior notes:
[v2](docs/v2-architecture.md), [v3](docs/v3-orleans-migration.md).

## The precedent

`IMeasurementHistory` (Core, was `IFlowHistory`) is the shape to copy. Four members: an `Id` that matches the config value, a read, a
range read with a default implementation, and a probe for the Status board. Two implementations. A router
that picks between them from live config. Adding a third backend means writing one class — nothing else in
the tree learns its name.

Two properties make it work, and both are deliberate:

- It carries its own **identity**, so config selects an implementation instead of a `switch` selecting a
  code path.
- It carries its own **health probe**, so the Status board needs no per-backend branch.

Every problem below is what happens where that pattern is absent.

## What one integration costs today

The edit list for adding a destination — say InfluxDB — before this work:

| File | Why |
| --- | --- |
| `InfluxConfig.cs` | new |
| `InfluxExportService.cs` | new |
| `Config.cs` | property |
| `ServiceConfiguration.cs` | register + role gate |
| `ConfigurationFaults.cs` | required-field check |
| `StartupSummary.cs` | banner line |
| `StatusReporter.cs` | component report |
| `GuiService.cs` | test endpoint |
| `web/src/actions.ts` | test button |
| `config-form.ts` | nav group + icon |
| `crd.yaml` ×2, `schema.fixture.json` | regenerate |

Thirteen. Sources are worse — sixteen files name `modbus`, including seven TypeScript modules, a hardcoded
`SOURCE_TYPES` list and per-type field rendering in the node editor.

The count is the argument. Nothing here is badly written; there is simply no seam, so every integration is
filed by hand into fourteen places and any one of them can be forgotten. That is not hypothetical: the
EmonCMS export shipped without its flow-node half for its entire existence, because "send the hierarchy
too" was something each destination remembered separately (#386).

**Target: two files.** One config class, one integration class, in one folder.

## Shape: a plugin is a vendor, and declares capabilities

Not one interface per plugin. A plugin is a vendor — EmonCMS, Home Assistant, Prometheus — and it
implements whichever capability interfaces it supports. The codebase already thinks this way:
`IOutletControl` and `IConfigSource` are separate seams from `IFlowValueSource`.

| Capability | Carries | Today |
| --- | --- | --- |
| `IMeasurementSource` | polls hardware into snapshots | vertiv only |
| `IMeasurementDestination` | receives readings + flow tiers | 5 hand-registered services |
| `IMeasurementHistory` | reads stored values back, by node | **done** — the template (was `IFlowHistory`) |
| `IConfigurationPublisher` | pushes *structure* to the far end, and sweeps what it no longer owns | HA discovery, HA energy, EmonCMS feeds |
| `IValueSourcePlugin` | supplies live values for bindings naming its type | plugin-only; mqtt/modbus unchanged |
| `IDeviceSourcePlugin` | polls hardware into a snapshot | plugin-only; the Vertiv poller unchanged |
| `IStatusProvider` | says what its own health means | default derivation covers the rest |
| `INodeProvider` | offers nodes it knows about, for the operator to adopt | topic index, Modbus scan, node templates |
| `IIntegrationApi` | bespoke actions, exposed over the API and the GUI | ~20 hand-written endpoints |
| `IFlowValueSource` | supplies `(node, metric) → value` | mqtt, modbus — unchanged, already a seam |

**"Measurement", not "energy".** A PDU reports temperature, humidity and CO2 alongside power, and Home
Assistant discovery carries every one of them, so naming these for energy would have been wrong on the day
they were written — even though the energy hierarchy is the part that motivated them.

`HistoricalFlowValueSource` already adapts an `IMeasurementHistory` answer into an `IFlowValueSource`, so
"EmonCMS as a source" and "Prometheus as a source" are the existing history providers plus a generalised
adapter — not new implementations.

### Nodes: discovering them, and addressing them

`INodeProvider` answers "what have you got that I could model?" — the broker topic index, a Modbus register
scan, a device template, and eventually Home Assistant enumerating entities. It is **discovery only**:
offering a node is not creating one, and it must never write configuration. What gets adopted, what it is
called and where it hangs are the operator's; discovery that quietly added nodes would rewrite a hand-built
diagram every poll.

There is no separate `INodeExporter`. Publishing what a node *is* to a far end is
`IConfigurationPublisher` — that is exactly what HA discovery and EmonCMS feed provisioning do — and
publishing what a node *reads* is `IMeasurementDestination`. A third name for one of those two would be a
synonym, not a capability.

Every reading now carries the node it belongs to. `FlowNodeId` is the one spelling of a derived node's id
(`pdu:{device}`, `outlet:{device}:{key}`), and `MeasurementReading.NodeId` is stamped where the device and
outlet key are both in hand. Eight places used to rebuild those strings, and two disagreed about whether the
outlet index was 0- or 1-based — a mismatch that produces no error, just a lookup that silently misses.

### Configuration is its own direction of travel

Publishing configuration is not a footnote on sending measurements, and treating it as one (an optional
`Reconcile` on the destination) was wrong. HA discovery publishes an entity document per device; the Energy
Dashboard sync writes dashboard configuration over HA's WebSocket API; EmonCMS provisions feeds and sets
each input's processlist. None of those send a reading. They run on their own slow cadence, they are what an
operator triggers by hand, and their failure mode differs: a missing measurement is a gap, but missing
configuration means every measurement after it lands somewhere wrong or nowhere at all.

Sweeping belongs with it. Configuration outlives what it described — a renamed node, a deleted PDU — and the
retained discovery document or orphaned feed stays behind claiming to be current. Whoever publishes is the
only thing that knows what it would publish today, so it owns the clean-up.

### Actions, and how a plugin reaches the API

Roughly half the GUI's endpoints are integration-specific — `/api/emoncms/provision-feeds`,
`/api/modbus/scan`, `/api/mqtt/topics`, `/api/ha/orphans/clear` — each hand-written into `GuiService` and
hand-wired to a button in `actions.ts`. A plugin declares actions instead, and the host exposes every one of
them on `/api/integrations/{id}/{action}`.

Two rules make this small:

- **Transport-free.** An action is a name, a description, an effect (read / write / destructive) and a
  handler taking arguments and returning an object. No `HttpContext`, no route strings, no ASP.NET in Core —
  the same rule that keeps the pipeline contracts framework-free. The identical declaration can be surfaced
  as a REST route, a GUI button, or an MQTT command without the integration knowing which called it.
- **Capabilities imply their actions.** Implementing `IConfigurationPublisher` *is* saying "I can publish and
  sweep", so `publish` and `sweep` appear on the API and in the GUI with no further wiring, exactly as the
  health probe becomes `probe` for free. `IIntegrationApi` is only for what nothing else implies — browsing
  broker topics, scanning a Modbus register block.

### `ExportPass`

One immutable object, built once per poll and handed to every destination. This is the part that pays for
itself immediately: `FlowTiers` already computes the tier set, so making it the *argument* means a new
destination cannot forget the hierarchy and an existing one cannot quietly drift from the others.

## Coordination stays out of the contracts

A plugin never learns how the host coordinates anything. That was true when coordination was Orleans, and
it stayed true when Orleans was removed — which is the test that mattered: the contracts did not move.

Two hooks exist for it, both plain interfaces in `Core`:

| Hook | For | Backed by |
| --- | --- | --- |
| `ISingleOwnerLease` | "one owner of this key" — the RS485 gateway-contention fix | `SoleOwnerLease` (this process owns what it can see) |
| `LeaderState` | run-once work: publishers, exporters, discovery | set true at startup; one process, one leader |

Both are the same arrangement: a plain type in `Core`, whatever keeps it true supplied by the host, and
Engine services that read it without knowing what does. A clustered build would replace those two files and
nothing else — no integration, no contract, no config.

## Constraints

**External plugins load at runtime.** An earlier draft of this plan ruled that out; building the contracts
showed the objection was mostly wrong, and it is now implemented. The GUI's form is drawn from a schema
generated by *reflection at startup*, not compiled into the bundle — so a plugin's settings class becomes a
rendered page with typed inputs, descriptions and defaults, with no TypeScript shipped by the plugin. Its
actions reach the API the same way, because routes are derived from the capabilities it declares.

Writing one: reference `rPDU2MQTT.Core`, implement `IIntegration` plus whichever capabilities apply, drop
the DLL in `plugins/`. Core is the whole SDK — contracts, config model, flow engine, helpers — and it
references no ASP.NET and no MQTT client, so a plugin inherits none of them. A worked example
lives in [Examples/Plugins/HelloWorld](Examples/Plugins/HelloWorld); it is a real destination in about
sixty lines.

Each plugin gets its own `AssemblyLoadContext`, so two can depend on different versions of the same library.
Types the host already has resolve to the host's copy — a plugin loading its own `rPDU2MQTT.Core` would
implement an interface the runtime considers a different type, and the cast would fail unactionably. A
plugin that will not load is reported and skipped: a third-party DLL must never stop the bridge starting.

The one real limit is the **CRD**. It is a compile-time contract published to the API server and cannot
describe a type that exists only on one operator's machine; generating a different CRD per install would be
worse than not describing those fields. Plugin settings therefore live under the open `Plugins` map, keyed
by plugin id, and are bound to the plugin's own settings class on load.

**Config stays typed.** A `Dictionary<string, JsonNode>` bag would cost the schema-driven GUI, the CRD,
YAML validation and the change-review diff to save one property declaration. Each plugin keeps a typed
config class and a property on `Config`; the win is that the property is the *only* thing that changes.

**The GUI needs its own small registry.** Schema-driven pages already render themselves. What doesn't:
`NAV_GROUPS`/`NAV_ICONS` hardcode the sections, `SOURCE_TYPES` hardcodes binding kinds, and the node editor
renders per-type fields inline. The schema grows `group`/`icon`, and the client keeps one registry keyed by
plugin id for the genuinely bespoke bits (topic picker, register scanner).

## Convert, then extend

Nine conversions and five new integrations were proposed together. They stay apart — shipping a new
integration inside the conversion makes a failure unattributable.

**Convert (existing behaviour, tests are the net):** Vertiv rPDU device + control · MQTT source +
destination · Modbus source · EmonCMS destination + history · Prometheus destination + history · Home
Assistant discovery + energy destinations.

**Extend (afterwards, one file each):** EmonCMS/Prometheus as value sources (the adapter above) · Home
Assistant as a value source (entity states) · Home Assistant as a history provider (recorder/statistics).

Home Assistant as a *config provider* is a different axis and probably not what is wanted: `IConfigSource`
is "where the YAML lives and can we write it". "HA tells us what entities exist so we can build nodes from
them" is an import/discovery capability, and there is already a shape for it (`/api/mqtt/importable`, node
templates).

## Where this got to

Built and verified on this branch:

- Five integrations on the contracts — Prometheus, EmonCMS, MQTT energy flow, Home Assistant, and an
  out-of-tree example plugin. Four hosted services deleted.
- External plugins load from `plugins/` at runtime, with their own config page, actions, health and nav
  placement, and no TypeScript shipped by the plugin.
- A plugin can be a destination, a history provider, a configuration publisher, a value source, a device,
  a node provider, and expose its own API actions.
- Every integration appears in the .NET health model at `/health/integrations`.

Deliberately not done, each for a stated reason rather than for time:

- **MQTT and Modbus sources** stay as they are: they already work through `IFlowValueSource`.
- **The per-type binding migration** was dropped. Rewriting every node's wiring buys nothing for anyone
  already using mqtt/modbus and is the one change here that could lose an operator's configuration; a
  plugin gets an open `Settings` bag instead.
- **`NAV_GROUPS`** stays for the built-ins: it interleaves schema sections with the visual editors, which
  have no schema section to hang a group off.

## Order

Each step leaves the tree green and releasable.

1. **Contracts + Prometheus.** `IIntegration`, the capability interfaces, `ExportPass`, a reflection-based
   registry, and Prometheus moved onto them. Prometheus is the proving case because it is already
   destination *and* history, so one slice exercises multi-capability registration — and `/metrics` makes
   the before/after verifiable against a running binary.
2. **The other destinations.** EmonCMS, MQTT export, HA discovery, HA energy.
3. **Generic health, test and faults.** One status card keyed by plugin id; one `/api/test/{id}`; one
   generic Test button; required fields from attributes.
4. **Nav and grouping from the schema.** Delete `NAV_GROUPS`/`NAV_ICONS`.
5. **Sources.** Needs a config migration: the flattened per-type fields on `EnergyFlowSource` become a
   nested per-type object, with the flat form honoured on load forever.
6. **Devices.** Generalise the Vertiv poller, with the single-owner lease as a declared capability. This is
   what makes a second PDU vendor a contribution rather than a fork.
