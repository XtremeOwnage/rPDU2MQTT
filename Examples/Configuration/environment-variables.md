# Environment variables & configuration precedence

rPDU2MQTT is configured by a **config file** *or* a **Kubernetes `RpduConfig` custom resource**, with a
handful of **environment variables** layered on top for secrets and to select the source.

## Precedence (what wins)

1. **Config source — the base config.** Exactly one source provides the whole configuration:
   - **File** (default): `config.yaml` (searched in `/config` then the working directory).
   - **Kubernetes CRD**: the `RpduConfig` custom resource's `spec`, when `RPDU2MQTT_CONFIG_SOURCE=k8s`.

   These are **alternatives**, not layers — you use the file *or* the CR, not both. (Defaults from the
   model fill in anything you omit.)

2. **Environment variables — override secrets on top.** After the source is loaded, the `RPDU2MQTT_*`
   variables below **override** the matching fields. This lets you keep credentials out of the
   file/CR. Env vars therefore **win** over whatever the source set for those specific fields.

3. **`*_FILE` — wins over the plain variable.** For every secret variable, a `<NAME>_FILE` form may
   point at a file (e.g. a Docker/Kubernetes secret); its contents are used and take precedence over
   the plain `<NAME>` variable.

> So for a secret field: **`RPDU2MQTT_…_FILE` > `RPDU2MQTT_…` > value in the config file / CR**.
> Everything else comes from the config source only.

## Variables

### Secrets (override the config source; each also has a `*_FILE` variant)

| Variable | Overrides |
| --- | --- |
| `RPDU2MQTT_MQTT_USERNAME` / `RPDU2MQTT_MQTT_PASSWORD` | MQTT broker credentials (`Mqtt.Credentials`) |
| `RPDU2MQTT_PDU_USERNAME` / `RPDU2MQTT_PDU_PASSWORD` | PDU credentials (`Pdu.Credentials`, for write actions) |
| `RPDU2MQTT_EMONCMS_APIKEY` | EmonCMS write API key (`EmonCMS.ApiKey`) |
| `RPDU2MQTT_GUI_PASSWORD` | GUI Basic-auth password (`Gui.Password`) |
| `RPDU2MQTT_OIDC_CLIENT_SECRET` | GUI OIDC client secret (`Gui.Oidc.ClientSecret`) |

Example (`*_FILE` for a Docker secret):

```yaml
services:
  rpdu2mqtt:
    environment:
      RPDU2MQTT_MQTT_PASSWORD_FILE: /run/secrets/mqtt_password
    secrets:
      - mqtt_password
```

### Config source selection

| Variable | Purpose | Default |
| --- | --- | --- |
| `RPDU2MQTT_CONFIG_SOURCE` | `file` (default) or `k8s` / `kubernetes` to read from an `RpduConfig` CR | `file` |
| `RPDU2MQTT_CR_NAME` | Name of the `RpduConfig` resource (required when source is `k8s`) | — |
| `RPDU2MQTT_NAMESPACE` | Namespace of the CR; falls back to the pod's service-account namespace | service-account namespace |

### Set by the Helm chart (informational)

| Variable | Purpose |
| --- | --- |
| `RPDU2MQTT_POD_NAME` | Pod name (downward API) — shown on the GUI Diagnostics page; enables the pod logs/events view |
| `RPDU2MQTT_IMAGE` | Container image ref — shown on the GUI Diagnostics page |

See the [Configuration guide](../../docs/Configuration.md) for the full config schema, and
[KubernetesCRD.md](../../docs/KubernetesCRD.md) for the CRD config source.
