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
    [x] `IStatusProvider` — an integration decides what its own health means, with a shared default
        (off / misconfigured / whatever it last did). The verdict used to be a branch per integration in
        StatusReporter, which a plugin could not participate in at all.
    [x] `IntegrationStatusGrain` — the board card for anything without a bespoke grain, so a plugin is no
        longer simply absent (indistinguishable from one that failed to load).
    [x] Microsoft.Extensions health checks: every integration becomes a standard `IHealthCheck`, served at
        `/health/integrations`, tagged so a readiness probe is NOT failed by a degraded optional exporter.
        The adapter lives in Engine so a plugin author never sees the health-check package.
    [x] `/api/integrations/{id}/{action}` replaces the per-destination test endpoints (probe is derived).
    [x] Startup banner built from the registry. Fixed while verifying: it reported a switched-OFF EmonCMS
        as "DISABLED (misconfigured)" because the fault was read without checking Enabled first.
    [ ] The five bespoke status grains stay for now — each encodes a real verdict rule about its own
        subject, and replacing them with the generic one would lose reasoning rather than share it. They
        should adopt `IStatusProvider` instead, one at a time.
    [x] Generic action buttons: `integrationActionBar()` renders whatever an integration says it can do,
        naming none of them. Destructive actions confirm, and say what they will remove, first. The
        hand-wired per-destination functions stay until every built-in is converted onto the contracts.
    [x] `DestinationRequirements.EmonCms` retired — the rule lives on `EmonCmsIntegration.Misconfigured`,
        which is the only place a plugin can put one. Its test moved onto the live rule; it had been
        passing against a static helper the production path no longer called.
    [x] `IntegrationFaultReporter` records every enabled-but-unusable integration into the SAME
        `ConfigurationFaults` the board and GUI read. (A DI factory would have replaced the instance
        already holding the logging-sink faults — caught before committing.)
    [x] Verified: EmonCMS enabled with no URL logs an error, reads Unhealthy on /health/integrations, and
        the bridge keeps serving.

5. Nav and grouping from the schema
    [x] `group` on `SchemaNode`, set from the integration's own `IntegrationGroup`. A plugin now lands in
        Destinations rather than among the logging and diagnostics pages.
    [x] Plugin sections bind to `Config.Plugins[id]` — Config was compiled before the plugin existed —
        while rendering and change-tracking identically to a built-in.
    [x] Fixed while here: `build()` pushed ungrouped sections into the module-level `NAV_GROUPS` constant,
        so every rebuild of the form appended them again and saving twice listed a page three times.
    [ ] `NAV_GROUPS` / `NAV_ICONS` stay for the built-ins: they interleave schema sections with the visual
        editors (Flow, Nodes, Trends), which have no schema section to hang a group off. Inverting that is
        its own change.
    [ ] A GUI check pinning "a new destination needs zero TypeScript".

6. Sources onto the contracts
    [ ] Per-type binding config nested under the source type; flat form honoured on load forever.
    [ ] Client registry for the bespoke editors (topic picker, register scanner); delete `SOURCE_TYPES`.
    [ ] MQTT source.
    [ ] Modbus source, keeping the single-owner lease that stops RS485 gateway contention.

7. Devices
    [ ] `IDeviceSource` + `IDeviceControl`; Vertiv rPDU moved onto them.
    [ ] Single-owner lease as a declared capability, not something a plugin author writes.

8. External plugins (built — the earlier "in-tree only" call was reversed)
    [x] `PluginLoader` — scans `plugins/` (or `RPDU2MQTT_PLUGINS`), one `AssemblyLoadContext` each, host
        types shared. A plugin that will not load is reported and skipped.
    [x] `IConfigurablePlugin` + `PluginConfigBinder` — a plugin declares a settings class; its section is
        stored under `Config.Plugins[id]` and bound on load.
    [x] `Config.Plugins` is `Dictionary<string, object?>`, NOT JsonNode: YamlDotNet cannot construct a
        JsonNode, and typing it that way made any config with a Plugins section fail to parse — taking the
        whole bridge down rather than one plugin. Caught on the rig, fixed, CRDs regenerated.
    [x] YAML scalars are re-typed on the way to JSON (`"true"` -> true, `"10"` -> 10), or every bool and
        number silently falls back to its default.
    [x] `Examples/Plugins/HelloWorld` — a working out-of-tree destination in ~60 lines, referencing only
        Core. Verified end to end: loaded from a DLL, bound its own YAML config, received the ExportPass
        and wrote every reading and tier to a file.
    [x] Plugin config pages render. The live `/api/schema` (GuiService, not the CLI emitter) now serves
        `ConfigSchema.Build(pluginSections)`, so a plugin's settings class becomes a page with typed
        inputs, defaults and descriptions — verified end to end with HelloWorld.
    [x] `GET /api/integrations` lists every integration with its capabilities and actions.
    [x] `POST /api/integrations/{id}/{action}` invokes any of them. Verified: the plugin's own `peek`
        action and a built-in derived `probe` both round-trip, and an unknown action is refused by name.
    [x] Nav grouping for plugin sections — verified: helloworld lands in Destinations.
    [x] The GUI renders a plugin's action buttons from `/api/integrations`.

9. Extend — only once everything above is converted
    [ ] EmonCMS + Prometheus as value sources, via the `IFlowHistory` → `IFlowValueSource` adapter.
    [ ] Home Assistant as a value source (entity states).
    [ ] Home Assistant as a history provider (recorder/statistics).

Notes
    - Branched off `fix/export-flow-nodes-and-tag-picker` (#386), which carries `FlowTiers`. Rebase
      `--onto origin/main` once that squash-merges.
    - Docs to update before this branch opens a PR: `docs/v2-architecture.md` pointer, `README.md`
      integration list, and a `docs/v4-plugins.md` written from `PLUGINS.md` if it outgrows the root file.
