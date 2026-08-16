Branch feat/v4-plugin-architecture. Plan: [PLUGINS.md](PLUGINS.md).

One branch, not one PR per slice. Every numbered item leaves the tree green: `dotnet build` (0 warnings),
`dotnet test`, and the GUI checks that run inside the build. Commit SHAs land beside each heading as it
finishes.

1. Contracts + registry
    [x] `IIntegration` — a vendor's identity: `Id`, `DisplayName`, `Group`, `Enabled`, `Misconfigured`, probe.
    [x] `IMeasurementDestination` — receives an `ExportPass`; declares its own tag filter and whether its
        output is per-process (Prometheus) or cluster-wide (everything else).
    [x] `IMeasurementHistory` — renamed from `IFlowHistory`; node-addressed, so it answers for an outlet
        exactly as for a virtual tier.
    [x] `IConfigurationPublisher` — pushing structure to the far end is its own direction of travel, not a
        footnote on the destination. Owns its sweep.
    [x] `IIntegrationApi` + `IntegrationAction` — transport-free actions. No ASP.NET in Core.
    [x] `IntegrationActions.For()` — capabilities imply their actions (`probe`, `publish`, `sweep`); the
        API declaration is only for what nothing else implies.
    [x] `ExportPass` — snapshot + readings + flow tiers + timestamp, built once per poll. Readings carry
        their instance id, which a merged snapshot would otherwise lose.
    [x] `IntegrationRegistry` — reflection over the Engine assembly, no hand-maintained list.
    [x] `IntegrationStatus` — one status per id, replacing the bespoke holders.
    [x] `ISingleOwnerLease` — the one coordination hook, `SoleOwnerLease` for single-process.
    [x] `DestinationHost` — builds the pass once, fans it out, records status per integration.
    [x] `INodeProvider` — "what have you got that I could model?" Discovery only; never writes config.
        (No `INodeExporter`: publishing what a node *is* is `IConfigurationPublisher`, publishing what it
        *reads* is `IMeasurementDestination`. A third name would be a synonym.)
    [x] `FlowNodeId` — one spelling of `pdu:{device}` / `outlet:{device}:{key}`, and every reading carries
        its own `NodeId`. Eight places rebuilt those strings; two disagreed on 0- vs 1-based.
    [ ] Grain-backed `ISingleOwnerLease` for real clusters (single-process default works today).
    [ ] `INodeProvider` implemented by MQTT (topic index) and Modbus (register scan) when they convert.

2. Prometheus onto the contracts (the proving case)
    [x] `PrometheusIntegration` implements `IMeasurementDestination` + `IMeasurementHistory` — one vendor,
        two capabilities, one config section.
    [x] `PrometheusExportService` deleted; registration replaced by `DestinationHost`.
    [x] `/metrics` output verified identical before and after — 9 series, exact diff, A/B against
        the pre-conversion binary on one rig. (The energy store lives beside the binary, so both stores
        have to be wiped or the comparison is against a different day's state.)
    [ ] Its banner line and status branch deleted from the host.
    [ ] Route `/api/integrations/{id}/{action}` in `GuiService`, replacing the bespoke test endpoint.

3. The other destinations
    [x] EmonCMS — destination + history + configuration publisher (feed provisioning + sweep). Three
        capabilities on one vendor, one config section. `EmonCmsExportService` deleted.
    [x] `IMessagePublisher` — publishing to the broker without inheriting `baseMQTTService`'s whole hosting
        model. EmonCMS's MQTT transport needed it; HA discovery will too.
    [x] MQTT energy-flow export — `IMeasurementDestination` (tier state topics) + `IConfigurationPublisher`
        (the HA discovery documents describing those topics). `EnergyFlowMqttExportService` deleted.
    [x] Home Assistant Energy Dashboard — pure `IConfigurationPublisher`; it never sends a reading, which is
        the clearest case for that contract existing. `HaEnergyDashboardService` deleted.
    [x] `ConfigurationPublisherHost` — publishers run on their own slow cadence, always leader-gated.
    [ ] `MQTTPublishingService` (names/states/alarms/outlet config) stays for now: it publishes the PDU's
        whole object model through ~30 `basePublishingService` helpers, not an ExportPass. Needs its own step.
    [ ] `HomeAssistantDiscoveryService` (native PDU discovery) — same reason; it is coupled to
        `DiscoveryCoordinator` and the publishing helpers.

4. Generic health, test and faults
    [ ] One component status grain keyed by plugin id; delete the five bespoke ones.
    [ ] One `/api/test/{id}` endpoint; delete the per-destination endpoints.
    [ ] One generic Test button; delete the wired list in `actions.ts`.
    [ ] Required fields from attributes on the config class; retire `ConfigurationFaults` per-integration
        methods.
    [ ] Startup banner built from the registry.

5. Nav and grouping from the schema
    [ ] `group` + `icon` on `SchemaNode`.
    [ ] Delete `NAV_GROUPS` / `NAV_ICONS` from `config-form.ts`.
    [ ] A new destination needs zero TypeScript — pin it with a GUI check.

6. Sources onto the contracts
    [ ] Per-type binding config nested under the source type; flat form honoured on load forever.
    [ ] Client registry for the bespoke editors (topic picker, register scanner); delete `SOURCE_TYPES`.
    [ ] MQTT source.
    [ ] Modbus source, keeping the single-owner lease that stops RS485 gateway contention.

7. Devices
    [ ] `IDeviceSource` + `IDeviceControl`; Vertiv rPDU moved onto them.
    [ ] Single-owner lease as a declared capability, not something a plugin author writes.

8. Extend — only once everything above is converted
    [ ] EmonCMS + Prometheus as value sources, via the `IFlowHistory` → `IFlowValueSource` adapter.
    [ ] Home Assistant as a value source (entity states).
    [ ] Home Assistant as a history provider (recorder/statistics).

Notes
    - Branched off `fix/export-flow-nodes-and-tag-picker` (#386), which carries `FlowTiers`. Rebase
      `--onto origin/main` once that squash-merges.
    - Docs to update before this branch opens a PR: `docs/v2-architecture.md` pointer, `README.md`
      integration list, and a `docs/v4-plugins.md` written from `PLUGINS.md` if it outgrows the root file.
