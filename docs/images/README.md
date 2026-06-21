# Screenshots

Doc/README screenshots, stored as **WebP** (lossless, metadata stripped). Capture as PNG, then convert
with `cwebp -lossless` (see the conversion script in the repo history). Landscape; crop to the relevant
panel; the dark theme matches the GUI.

Used across the README and `docs/`:

| Filename | What it shows | Used in |
| --- | --- | --- |
| `gui-live-data.webp` | GUI **Live Data** (Grouped) — the headline shot. | README |
| `gui-config.webp` | GUI **configuration** form (structured form + nav). | README |
| `gui-control.webp` | GUI **Control** tab — per-outlet actions + group actions. | README |
| `gui-paths.webp` | GUI **Paths** tab — generated MQTT/Prometheus/EmonCMS paths. | README |
| `gui-pdu.webp` | GUI **PDU** config section. | Configuration |
| `gui-homeassistant.webp` | GUI **HomeAssistant** config (incl. group-member templates). | Configuration |
| `gui-overrides.webp` | GUI **Overrides** editor (live-data driven). | Configuration |
| `overrides-oneview-groups.webp` | GUI Overrides — OneView **groups** list. | Aggregation |
| `gui-prometheus.webp` | GUI **Prometheus** config (metric-name template + Pushgateway). | Configuration |
| `gui-emoncms.webp` | GUI **EmonCMS** config. | Configuration |
| `gui-oidc.webp` | GUI **authentication / OIDC** settings. | Configuration |
| `gui-export.webp` | GUI **Export** view (config/CR, secrets redacted). | KubernetesCRD |
| `gui-diagnostics.webp` | GUI **Diagnostics** page (non-k8s). | Configuration |
| `gui-diagnostics-kubernetes.webp` | GUI **Diagnostics** in k8s — RpduConfig source + pod logs. | KubernetesCRD |
| `mqtt-explorer.webp` | Published MQTT topic tree (MQTT Explorer). | Configuration |
| `emoncms-inputs.webp` | EmonCMS **Inputs** populated by rPDU2MQTT. | README, Configuration |
| `emoncms-graph.webp` | EmonCMS **feed graph** (power over time). | Configuration |
| `home-assistant-bridge.webp` | The HA **bridge** device + all connected devices. | README, Configuration |
| `home-assistant-pdu.webp` | An HA **PDU** device — sensors + connected outlets/groups. | Aggregation |
| `home-assistant-outlet.webp` | An HA **outlet** device — switch, sensors, delays, power-on. | README |
| `home-assistant-group.webp` | An HA **OneView group** device — rollups, member switches, group actions. | README, Aggregation |
| `home-assistant-automation.webp` | HA **device-trigger** automation using a PDU entity. | Configuration |
| `home-assistant-history.webp` | An HA sensor **history** graph (power over time). | README |

Nice-to-have later: **`grafana.webp`** (a Grafana/Prometheus dashboard).
