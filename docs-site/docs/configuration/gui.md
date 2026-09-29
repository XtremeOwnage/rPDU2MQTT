---
title: Configuration GUI
---

# Configuration GUI

An embedded web GUI can view, edit and test the configuration instead of hand-editing this file.
It is disabled by default. When enabled, browse to `http://<host>:<port>` and sign in with the
configured username/password (HTTP Basic auth).

```yaml
Gui:
  Enabled: false
  Port: 8080
  Username: "admin"
  AuthType: Basic         # Basic | Oidc | None
  Password: "change-me"   # required when AuthType is Basic
```

## Single Sign-On (OIDC)

The GUI authentication method is chosen with **`Gui.AuthType`** (`Basic`, `Oidc`, or `None`). Set it to
`Oidc` to authenticate against an OpenID Connect provider (Keycloak, Authentik, Authelia, Google,
Entra ID, etc.): unauthenticated visitors are redirected to the provider, and a **Logout** link
appears in the header.

```yaml
Gui:
  Enabled: true
  Port: 8080
  AuthType: Oidc
  Oidc:
    Authority: "https://keycloak.example.com/realms/home"
    ClientId: "rpdu2mqtt"
    ClientSecret: "..."          # prefer the env var / secret below
    Scopes: "openid profile email"
    CallbackPath: "/signin-oidc" # register <gui-url>/signin-oidc as the redirect URI
```


- Register the redirect URI `https://<your-gui-host>/signin-oidc` with your provider.
- Provide the client secret out-of-band via **`RPDU2MQTT_OIDC_CLIENT_SECRET`** (or its `_FILE` form)
  rather than in the config.
- The GUI honors `X-Forwarded-Proto`/`-Host`, so behind an Ingress/Gateway terminating TLS the
  redirect URI is built with the external `https` URL.
- In the GUI form, the **Authentication** dropdown greys out the fields that don't apply to the
  selected method.

## Disabling authentication

For a trusted, isolated network you can turn GUI authentication off entirely:

```yaml
Gui:
  Enabled: true
  AuthType: None   # ⚠️ no login — anyone who can reach the port has full access
```

**Only** use it where the GUI port is otherwise protected (e.g. a private network or a NetworkPolicy);
a warning is logged at startup.

## What the GUI does

Every page is shown in the [Web GUI tour](../gui/index.md). The GUI:
- Renders a **structured form for every option**, generated from the configuration model (so it stays
  in sync automatically), with inline descriptions, types, and the dynamic Overrides maps.
- **Tests** the running services — for example **Test MQTT connection** on the MQTT page, **Test
  connections** on Modbus TCP and **Test history backend** on History.
- **Home Assistant actions** — the Home Assistant section has "Republish discovery" and
  "Clear discovery" buttons. **Republish** first **reloads the saved config from the source** and
  re-reads the PDU, so discovery-affecting edits (overrides, names, templates) take effect without a
  full restart. Clear removes the retained discovery messages so the entities disappear from Home
  Assistant (until discovery runs again).
- **Live-driven Overrides** — the Overrides section is populated from the **live PDU data**: it lists
  the actual devices, outlets (by index), measurement types, and OneView groups currently being
  discovered, each with Name/ID/Enabled fields, so you can see exactly what an override targets
  instead of typing keys blind. Existing overrides for entities that are not currently discovered
  (e.g. disabled ones) are still shown so they can be re-enabled.
- **Live Data** — a read-only view of the current measurements being pulled from the PDU(s). The
  **Grouped** view pivots to one row per outlet/entity (grouped by device) with a column per
  measurement type and the outlet on/off state; a **Flat** view lists one row per reading. Both have a
  filter and a **Live** toggle.
- **Paths** — shows the generated **MQTT topic**, **Prometheus metric**, and **EmonCMS key** for each
  measurement (reflecting your overrides), with click-to-copy. Prometheus/EmonCMS columns appear only
  when those exporters are enabled.
- **Export** — renders the current form state (including unsaved edits) as the `config.yaml` that
  would be written, or as an `RpduConfig` manifest, with a Copy button, for pasting into a ConfigMap,
  source control, etc.
- **Saves** back to this config file (keeping a `config.yaml.bak` copy). Discovery-affecting edits
  (overrides, names, templates) can be applied by pressing **Republish discovery** (it reloads the
  config); connection-level changes (MQTT/PDU host/port, GUI/Health ports) still need a restart.

Notes:
- Basic auth is sent in clear text, so only expose the GUI on a trusted network or behind a
  TLS-terminating reverse proxy. Remember to publish/forward the GUI `Port` (e.g. `-p 8080:8080`,
  or a `ports:` entry in docker-compose).
- For **Save** to work in a container, the config file must be writable. The example
  docker-compose mounts it read-only (`:ro`) — drop the `:ro` if you want to edit the config from
  the GUI:
  ```yaml
  services:
    rpdu2mqtt:
      ports:
        - "8080:8080"        # publish the GUI
      volumes:
        - ./config.yaml:/config/config.yaml   # writable (no :ro) so the GUI can save
  ```
- "Test" reflects the **currently running** configuration, not unsaved edits — save and restart to
  test new connection settings.

## GUI with Kubernetes / read-only config

A `config.yaml` mounted from a **ConfigMap** (or any `:ro` mount) is **read-only**, so the GUI
cannot save to it. In that case the GUI is **view + test only**: it detects the read-only file,
disables the **Save** button, and shows a notice (a save attempt returns HTTP 409). Viewing the
config and the MQTT/PDU connection tests still work.

If you want to edit and persist config from the GUI under Kubernetes, mount `config.yaml` from a
**writable** volume (e.g. a `PersistentVolumeClaim`) instead of a ConfigMap. Note that GUI edits
then become the source of truth for that file, which trades off against managing the config
declaratively (ConfigMap / GitOps). A common pattern is to keep the ConfigMap as the source of
truth and use the GUI only to view and test.

## Kubernetes config source (CRD)

Alternatively, store the configuration in an **`RpduConfig` custom resource** instead of a ConfigMap.
The CR is a writable API object, so the GUI's **Save works** (it PATCHes the CR), config is validated
by the CRD schema, and a `status` subresource reports health (`kubectl get rpduconfig`). Enable it via
the Helm chart (`kubernetesConfigSource.enabled=true`) or the manifests in
[`Examples/Kubernetes/crd/`](https://github.com/XtremeOwnage/rPDU2MQTT/tree/main/Examples/Kubernetes/crd); full details in
[KubernetesCRD.md](../deployment/kubernetes-crd.md). Saving from the GUI shows a reminder to update your GitOps
source, and the GUI's **Export** view can render the current config as an `RpduConfig` manifest
(secrets redacted) to commit back. Credentials are not stored in the CR — provide them via a Secret
and the `RPDU2MQTT_*` env vars.

## GUI Diagnostics page

The GUI's **Diagnostics** page shows runtime status — app version, container image, uptime, MQTT
connection, last successful PDU poll, config source, and (in Kubernetes) the namespace/pod. It also
has a **Restart** button (stops the process so the container/host restarts it) and, when using
the Kubernetes config source, on-demand **pod logs** and **recent events** (requires the RBAC the Helm
chart grants — `pods`, `pods/log`, `events`).


## How settings are labelled

A setting's label is its name as words — `PrometheusUrl` reads as "Prometheus URL", `ToleranceSeconds` as
"Tolerance Seconds" — with initialisms (URL, API, MQTT, PDU, GUI, …) kept upper case. `[Display(Name)]` on
the property overrides it where the name alone does not read well, and `[SettingGroup("…")]` draws related
settings in one bordered box: History's four retention settings are grouped that way.

## Settings without a page

Deployment settings have no page in the GUI. They are set in `config.yaml`, in `values.yaml`, or in the
`RpduConfig` resource, beside the volume, service, port or container that backs them — all of them are still
in the schema and the CRD.

- `Health` (port), `Api` (port, key) and `PlanStorage` (directory, bucket, size limit): the listener or the
  volume behind each is declared in the deployment, and a second editor in the GUI would disagree with it.
- `Cache` (endpoint, prefix, timeout): the Valkey/Redis service is part of the deployment.
- **Feature switches** — what is turned on at all — are set the same way. There is no Features page; each
  page says where its own switch lives and does not render one.
- `Debug` (publish to MQTT, print discovery payloads) is on the **Diagnostics** page, beside the runtime
  state it is used to read.

The Diagnostics page also lists every directory this process writes to — history, floor plan images,
plugins — with what each holds, the file count, the mount it sits on and the free space there. A directory
that is not there, or that cannot be written to, is marked: both look like data quietly not being kept.
The Used column is green, amber when the volume has under 10% free, and red under 3% (or 64 MB).

The Status board carries a **Storage** card judged by the directory in the worst shape: red when a
directory is missing, read-only or full, amber when one is nearly full. The plugins directory is only read,
so it is never faulted for being read-only or on a busy filesystem.

A page for a feature that is off stays hidden in the nav until it is turned on, as before.
