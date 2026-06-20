# Configuration Guide 

This guide will walk you through the configuration options available for this service. The configuration file, typically named `config.yaml`, should be properly set up before deploying the service.

> Clustering multiple PDUs? See [Aggregation.md](Aggregation.md) for OneView setup.

## MQTT Configuration

### Credentials (Optional)

To connect to your MQTT broker, you can optionally specify a username and password.

If- your MQTT broker requires authentication, you will be required to provide a username and password.

```yaml
Mqtt:
  Credentials:
    Username: "user"    # Replace with your MQTT username
    Password: "password" # Replace with your MQTT password
```

### Parent Topic (Optional)

This defines the parent topic under which all MQTT keys will be published.

```yaml
Mqtt:
  ParentTopic: "rpdu2mqtt"  # Customize this to your desired parent topic
```

### Client ID (Optional)

This sets the client ID that the service will use when connecting to the MQTT broker.

```yaml
Mqtt:
  ClientID: "rpdu2mqtt"  # Customize as needed
```

### KeepAlive (Optional)
This defines the keep-alive interval (in seconds) for the MQTT connection.

```yaml
Mqtt:
  KeepAlive: 60  # Adjust as necessary
```

### Last Will / Availability (Optional)
By default the bridge registers an MQTT **Last-Will** message and sets an `availability_topic` on every
entity, so Home Assistant marks them **unavailable the instant the bridge disconnects**.

```yaml
Mqtt:
  LastWill: true   # default
```

Set `LastWill: false` to disable both the Last-Will and the availability topic. Entities then rely on
**`HomeAssistant.SensorExpireAfterSeconds`** (the `expire_after` timeout) to go unavailable once their
data goes stale — tune that value to control how long until they show unavailable:

```yaml
Mqtt:
  LastWill: false
HomeAssistant:
  SensorExpireAfterSeconds: 300   # how long stale sensors stay "available"
```

> Note: `expire_after` only applies to sensors/binary-sensors. Outlet **switches** have no
> `expire_after` in Home Assistant, so with `LastWill: false` switches will not auto-mark unavailable.

### Connection Details (Required)
Configure the connection to your MQTT broker:

```yaml
Mqtt:
  Connection:
    Host: "localhost"  # Replace with your MQTT broker's IP or hostname
    Port: 1883         # Replace with the MQTT broker's port number
    Timeout: 15        # Connection timeout in seconds
    ValidateCertificate: true  # Set to false if you're using self-signed certificates
```

## PDU Configuration (Required)

### Connection Details (Required)
Set up the connection details to your Power Distribution Unit (PDU).

```yaml
Pdu:
  Connection:
    Scheme: http         # http or https, based on your PDU's configuration
    Host: "localhost"    # Replace with your PDU's IP or hostname
    Port: 80             # Replace with your PDU's port number
    Timeout: 15          # Request timeout in seconds
    ValidateCertificate: true  # Set to false if using self-signed certificates
```

### Credentials (Optional)
Provide credentials if required to connect to the PDU.

```yaml
Pdu:
  Credentials:
    Username: "actionsUser"  # Replace with your PDU username
    Password: "actionsPass"  # Replace with your PDU password
```

### Credentials via environment / secrets (Optional)
To keep secrets out of `config.yaml`, MQTT and PDU credentials can be supplied via environment
variables. These override whatever is in the config file:

| Variable | Overrides |
| --- | --- |
| `RPDU2MQTT_MQTT_USERNAME` / `RPDU2MQTT_MQTT_PASSWORD` | MQTT broker credentials |
| `RPDU2MQTT_PDU_USERNAME` / `RPDU2MQTT_PDU_PASSWORD` | PDU credentials |
| `RPDU2MQTT_EMONCMS_APIKEY` | EmonCMS write API key |
| `RPDU2MQTT_GUI_PASSWORD` | GUI Basic-auth password |
| `RPDU2MQTT_OIDC_CLIENT_SECRET` | GUI OIDC client secret |

For each variable, a `<NAME>_FILE` form is also supported: set it to a file path (e.g. a Docker
secret at `/run/secrets/mqtt_password`) and the value is read from that file. The `_FILE` form
takes precedence over the plain variable.

```yaml
# docker-compose example
services:
  rpdu2mqtt:
    environment:
      RPDU2MQTT_MQTT_PASSWORD_FILE: /run/secrets/mqtt_password
    secrets:
      - mqtt_password
```

### Polling Interval (Optional)
Set how often the PDU sensors should be polled and published to MQTT (in seconds).

```yaml
Pdu:
  PollInterval: 5  # Adjust the polling interval as needed
```

### Actions Enabled
Enable or disable the ability to perform write-actions on the PDU (e.g., toggling outlets).
Requires PDU `Credentials`. Disabled by default.

```yaml
Pdu:
  ActionsEnabled: true  # Set to false to disable any changes on the PDU
```

When enabled, each outlet gains the following **outlet operations** in Home Assistant
(and a matching **Control** tab in the configuration GUI):

| Entity | Type | Action |
| --- | --- | --- |
| Switch | `switch` | Turn the outlet on / off |
| Reboot | `button` | Power-cycle the outlet |
| On Delay / Off Delay / Reboot Delay | `number` | Configure the outlet's on/off/reboot timing (seconds) |
| Power-On Action | `select` | What the outlet does when power is restored |
| Reset Statistics | `button` | Reset the outlet's accumulated energy statistics |

The GUI **Control** tab is the easiest place to exercise these against a single outlet. It also
shows each outlet's current delays and power-on action so changes made from Home Assistant are
visible there.

> Power-On Action options are `on` / `off` / `last` (restore the pre-outage state).

## Overrides Configuration (Optional)

This section allows you to override generated `entity_id`, names, and enabled/disabled states for various objects. 

For all override sections, Name can be updated at anytime. Home assistant will reflect the updated names after the next discovery job runs.

ID fields, are only used when the device/entity is initially created. Changing this after the entity has been created will have no effect.

All fields, are optional.

### PDU Override
Override details about the PDU itself.

```yaml
Overrides:
  PDU:
    ID: null  # Leave as null unless you have a specific ID
    Name: "Your-PDU"  # Customize the PDU name
```

### Devices Override
Override details regarding devices exposed by the PDU using their serial numbers.

Each PDU can expose multiple devices. The outlets, sensors, etc will belong to one of these devices within Home Assistant.

```yaml
Overrides:
  Devices:
    A0AE260C851900C3:       # Replace this with the serial number from your device. You can get this from the info tab.
      ID: null              # Leave as null unless you have a specific ID
      Name: "Device Name"   # Customize the device name
      Enabled: true         # Set to false to disable this device. 
```

### Outlets Override
Customize individual outlets by their number (1-based, matching the PDU UI). Outlets are nested under
their device's serial number.

```yaml
Overrides:
  Devices:
    A0AE260C851900C3:           # Device serial number
      Outlets:
        1:
          ID: kube02                # Customize the outlet ID
          Name: "Proxmox: Kube02"   # Customize the outlet name
          Enabled: true             # Set to false to disable this outlet
          Make: "Dell"              # Manufacturer shown in Home Assistant
          Model: "PowerEdge R730xd" # Model shown in Home Assistant
```

`Make` and `Model` override what Home Assistant shows in the device info (instead of the PDU's
hardware make/model, e.g. `GEI` / `MNU3E1R1-...`). They apply to devices, outlets, and OneView groups,
and take precedence over the `RemapMake` / `RemapModel` toggles.

### Measurements Override
Customize how metrics are sent to services. The entity ID used for metrics is `[DEVICE_ID]_[METRIC_TYPE]`.

Example, say, you have a device named `kube02`. The measurements will be named kube02_power

```yaml
Overrides:
  Measurements:
    apparentPower:
      ID: null         # Leave as null unless you have a specific ID
      Name: "Apparent Power"  # Human-readable name for this metric
      Enabled: true    # Set to false to disable this metric
    realPower:
      ID: power        # Customize the ID if needed
      Name: "Power"    # Human-readable name for this metric
      Enabled: true    # Set to false to disable this metric
```

## Home Assistant Integration

### Discovery Configuration

Enable automatic discovery of the PDU and its entities in Home Assistant.

```yaml
HomeAssistant:
  DiscoveryEnabled: true                      # Set to false if you do not want Home Assistant discovery
  DiscoveryTopic: "homeassistant/discovery"   # Customize the discovery topic
  DiscoveryInterval: 300                      # Interval (in seconds) between discovery messages
  SensorExpireAfterSeconds: 300               # Time after which sensors are marked as unavailable
```

## Debugging Configuration

### Debug Options

Use these settings when debugging or requiring additional data.

You- typically should never need to touch, or change any settings here.

```yaml
Debug:
  PrintDiscovery: false  # Set to true to print discovery messages to the console
  PublishMessages: true  # Set to false to test the program without sending messages
```

## Logging Configuration

### Console Logging
Customize how messages are logged to the console (stdout).

```yaml
Logging:
  Console:
    Enabled: true  # Set to false to disable console logging
    Severity: Information  # Minimum severity of messages to log
    Format: "[{Timestamp:HH:mm:ss} {Level}] {Message:lj}{NewLine}{Exception}"  # Customize the log format
```

### File Logging
Configure logging to a file.

```yaml
Logging:
  File:
    Enabled: false  # Set to true to enable file logging
    Severity: Debug  # Minimum severity of messages to log
    Format: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}"  # Customize the log format
    Path: null  # Specify the log file path
    FileRollover: Day  # Set the frequency of log file rollover (e.g., Day, Month)
    FileRetention: 30  # Number of rolled over logs to retain
```

### Syslog Logging
Send logs to a remote syslog server (RFC3164/RFC5424) over UDP or TCP.

```yaml
Logging:
  Syslog:
    Enabled: false       # Set to true to enable syslog
    Host: "10.0.0.10"    # Syslog server hostname/IP (required when enabled)
    Port: 514            # Syslog server port
    Protocol: UDP        # UDP or TCP
    AppName: "rPDU2MQTT" # Application name reported in syslog messages
    Severity: Information # Minimum severity of messages to send
```


## Metric Exporters (Optional)

In addition to MQTT, measurements can be exported to Prometheus and/or EmonCMS. Both are disabled
by default and poll on the same `Pdu.PollInterval` cadence.

### Prometheus
Each measurement type becomes a gauge (e.g. `rpdu2mqtt_realpower`) labelled by `device`, `source`, and
`units`. Two independent delivery methods — enable **either or both**:

- **`Exporter`** — expose a `/metrics` endpoint for Prometheus to **scrape** (pull).
- **`Pushgateway`** — **push** to a Prometheus **Pushgateway** (for setups where scraping isn't practical).

```yaml
Prometheus:
  Exporter: false       # expose /metrics for scraping
  Port: 9184            # /metrics endpoint port (Exporter)
  MetricNameTemplate: "rpdu2mqtt_{type}"  # naming template; {type} = measurement type
  Pushgateway:
    Enabled: false      # push to a Pushgateway
    Url: "http://pushgateway:9091/metrics"
    Job: "rpdu2mqtt"
    IntervalSeconds: 0  # 0 = use Pdu.PollInterval
```

> The older `Prometheus.Enabled: true` still works — it's treated as `Exporter: true`.

**Customizing metric names.** `MetricNameTemplate` controls the generated metric name. Placeholders:

| Placeholder | Value |
| --- | --- |
| `{type}` | measurement type (honoring its Overrides.Measurements ID) |
| `{device}` | device name |
| `{source}` / `{outlet}` | outlet or entity name |
| `{units}` | measurement units |

For example `"pdu_{device}_{type}"` yields `pdu_rack_pdu_1_realpower`. The result is lower-cased with
non-alphanumeric characters replaced by `_` (so pick a template that starts with a letter). Note that
`device`, `source`, and `units` are **also always emitted as Prometheus labels**, so you can keep the
default `rpdu2mqtt_{type}` and aggregate/filter by label (the idiomatic approach), or encode them into
the name if you prefer.

You can also rename an individual measurement type via its **Measurements override ID**, which replaces
`{type}`. For example, with the default template:

```yaml
Overrides:
  Measurements:
    realPower:
      ID: power      # -> rpdu2mqtt_power instead of rpdu2mqtt_realpower
```

The GUI **Paths** tab (and the Overrides "Preview generated paths" button) show the resulting metric
names so you can confirm them before deploying.

### EmonCMS
Pushes measurements to an EmonCMS server's `input/post` API (EmonCMS auto-creates the inputs).

```yaml
EmonCMS:
  Enabled: false
  Url: "http://emoncms.example.com"   # required when enabled
  ApiKey: "your-write-apikey"         # or set RPDU2MQTT_EMONCMS_APIKEY
  Node: "rpdu2mqtt"
  Path: "input/post"                  # API path (relative to Url) to post to
```

## Configuration GUI (Optional)

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

### Single Sign-On (OIDC)

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

### Disabling authentication

For a trusted, isolated network you can turn GUI authentication off entirely:

```yaml
Gui:
  Enabled: true
  AuthType: None   # ⚠️ no login — anyone who can reach the port has full access
```

**Only** use it where the GUI port is otherwise protected (e.g. a private network or a NetworkPolicy);
a warning is logged at startup.

The GUI:
- Renders a **structured form for every option**, generated from the configuration model (so it stays
  in sync automatically), with inline descriptions, types, and the dynamic Overrides maps.
- **Tests** the running services — the MQTT section has a "Test MQTT connection" button (broker
  connectivity) and the PDU section a "Test PDU connection" button (fetches live data and reports the
  device/outlet counts).
- **Home Assistant actions** — the Home Assistant section has "Republish discovery" and
  "Clear discovery" buttons. Clear removes the retained discovery messages so the entities disappear
  from Home Assistant (until discovery runs again).
- **Live-driven Overrides** — the Overrides section is populated from the **live PDU data**: it lists
  the actual devices, outlets (by index), measurement types, and OneView groups currently being
  discovered, each with Name/ID/Enabled fields, so you can see exactly what an override targets
  instead of typing keys blind. Existing overrides for entities that are not currently discovered
  (e.g. disabled ones) are still shown so they can be re-enabled.
- **Live Data** — a read-only view of the current measurements being pulled from the PDU(s). The
  **Grouped** view pivots to one row per outlet/entity (grouped by device) with a column per
  measurement type and the outlet on/off state; a **Flat** view lists one row per reading. Both have a
  filter and optional 5-second auto-refresh.
- **Paths** — shows the generated **MQTT topic**, **Prometheus metric**, and **EmonCMS key** for each
  measurement (reflecting your overrides), with click-to-copy. Prometheus/EmonCMS columns appear only
  when those exporters are enabled.
- **Export YAML** — an "Export YAML" view renders the current form state (including unsaved edits) as
  the `config.yaml` that would be written, with a Copy button, for pasting into a ConfigMap, source
  control, etc.
- **Saves** back to this config file (keeping a `config.yaml.bak` copy). Changes apply on the next
  restart, so restart the service after saving.

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

### GUI with Kubernetes / read-only config

A `config.yaml` mounted from a **ConfigMap** (or any `:ro` mount) is **read-only**, so the GUI
cannot save to it. In that case the GUI is **view + test only**: it detects the read-only file,
disables the **Save** button, and shows a notice (a save attempt returns HTTP 409). Viewing the
config and the MQTT/PDU connection tests still work.

If you want to edit and persist config from the GUI under Kubernetes, mount `config.yaml` from a
**writable** volume (e.g. a `PersistentVolumeClaim`) instead of a ConfigMap. Note that GUI edits
then become the source of truth for that file, which trades off against managing the config
declaratively (ConfigMap / GitOps). A common pattern is to keep the ConfigMap as the source of
truth and use the GUI only to view and test.

### Kubernetes config source (CRD)

Alternatively, store the configuration in an **`RpduConfig` custom resource** instead of a ConfigMap.
The CR is a writable API object, so the GUI's **Save works** (it PATCHes the CR), config is validated
by the CRD schema, and a `status` subresource reports health (`kubectl get rpduconfig`). Enable it via
the Helm chart (`kubernetesConfigSource.enabled=true`) or the manifests in
[`Examples/Kubernetes/crd/`](../Examples/Kubernetes/crd/); full details in
[KubernetesCRD.md](KubernetesCRD.md). Saving from the GUI shows a reminder to update your GitOps
source, and the GUI's **Export** view can render the current config as an `RpduConfig` manifest
(secrets redacted) to commit back. Credentials are not stored in the CR — provide them via a Secret
and the `RPDU2MQTT_*` env vars.

### GUI Diagnostics page

The GUI's **Diagnostics** tab shows runtime status — app version, container image, uptime, MQTT
connection, last successful PDU poll, config source, and (in Kubernetes) the namespace/pod. It also
has a **Restart bridge** button (stops the process so the container/host restarts it) and, when using
the Kubernetes config source, on-demand **pod logs** and **recent events** (requires the RBAC the Helm
chart grants — `pods`, `pods/log`, `events`).

## Health Checks (Optional)

The bridge exposes lightweight HTTP health endpoints for container/orchestrator probes, enabled by
default on their own port:

```yaml
Health:
  Enabled: true   # default
  Port: 8081      # default
```

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | **Liveness** — the process is up (always `200 OK` while running). |
| `GET /readyz` | **Readiness** — `200` when MQTT is connected and the PDU has been polled recently; otherwise `503`. |

The Helm chart wires these as `livenessProbe` / `readinessProbe` automatically (toggle with
`healthProbes.enabled`, default on). For Docker Compose you can point a `healthcheck` at `/healthz`.

## Example Configurations

Here- are a few example configuration files.

### Minimal Configuration

This, represents the absolute minimum amount of configuration needed for functionality.

[Minimal Configuration](./../Examples/Configuration/minimum-configuration-example.yaml)

### Recommended Configuration

This configuration changes the names, and default IDs for a few measurements.

[Recommended Configuration](./../Examples/Configuration//recommended-configuration.yaml)

### All Options / Configuration Spec

This file, represents all of the currently documented configuration settings which can be changed.

[Configuration Spec](./../Examples/Configuration/config.spec.yaml)