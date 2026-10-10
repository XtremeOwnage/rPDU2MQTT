---
title: Environment variables
---

# Environment variables

## Precedence

For a secret: `RPDU2MQTT_…_FILE` > `RPDU2MQTT_…` > value in `config.yaml` or the `RpduConfig` resource.

Every other setting comes from the config source only.

## Secrets

Each also accepts `<NAME>_FILE`, a path to a file holding the value (Docker or Kubernetes secret).

| Variable | Setting |
| --- | --- |
| `RPDU2MQTT_MQTT_USERNAME`, `RPDU2MQTT_MQTT_PASSWORD` | `MQTT.Credentials` |
| `RPDU2MQTT_PDU_USERNAME`, `RPDU2MQTT_PDU_PASSWORD` | Credentials of the `default` PDU, else the first one |
| `RPDU2MQTT_EMONCMS_APIKEY` | `EmonCMS.ApiKey` |
| `RPDU2MQTT_HASS_TOKEN` | `HomeAssistant.Token` |
| `RPDU2MQTT_GUI_PASSWORD` | `Gui.Password` |
| `RPDU2MQTT_OIDC_CLIENT_SECRET` | `Gui.Oidc.ClientSecret` |
| `RPDU2MQTT_API_KEY` | `Api.ApiKey` |
| `RPDU2MQTT_CACHE_PASSWORD` | `Cache.Password` |
| `RPDU2MQTT_PLANS_SECRET_KEY` | `PlanStorage.ObjectStore.SecretAccessKey` |

```yaml
services:
  rpdu2mqtt:
    environment:
      RPDU2MQTT_MQTT_PASSWORD_FILE: /run/secrets/mqtt_password
    secrets:
      - mqtt_password
```

## Config source

| Variable | Values | Default |
| --- | --- | --- |
| `RPDU2MQTT_CONFIG_SOURCE` | `file`, `k8s` / `kubernetes` | `file` |
| `RPDU2MQTT_CR_NAME` | `RpduConfig` resource name. Required for `k8s` | |
| `RPDU2MQTT_SECRET_NAME` | Secret the GUI writes credentials to (`k8s`) | CR name |
| `RPDU2MQTT_NAMESPACE` | Namespace of the resource | Service account namespace |

## Runtime

| Variable | Purpose | Default |
| --- | --- | --- |
| `RPDU2MQTT_ROLE` | Roles to run: `worker`, `api`, `ui`, `operator`, `all`. Comma separated. Same as `--role` | `all` |
| `RPDU2MQTT_HISTORY_DIRECTORY` | Local history directory when `History.LocalPath` is empty | Beside the program |
| `RPDU2MQTT_PLANS_DIRECTORY` | Floor plan image directory when `PlanStorage.Directory` and the object store are unset | Cache, else `plans` beside the program |
| `RPDU2MQTT_PLUGINS` | Plugin directory | `plugins` beside the program |
| `RPDU2MQTT_SHUTDOWN_DRAIN_SECONDS` | Seconds to keep serving after SIGTERM | `10` |
| `TZ` | Process time zone. Used for daily totals when `EnergyFlow.Aggregation.PeriodTimeZone` is empty | |

## Set by the Helm chart

| Variable | Purpose |
| --- | --- |
| `RPDU2MQTT_POD_NAME` | Pod name. Shown on Diagnostics; enables pod logs and events |
| `RPDU2MQTT_IMAGE` | Container image. Shown on Diagnostics |
| `RPDU2MQTT_DEPLOYMENT` | Deployment rolled by **Restart** under a leader lease |
| `RPDU2MQTT_LEADER_LEASE` | Enables the leader lease |
| `RPDU2MQTT_LEADER_LEASE_CONNECTION` | Valkey for the lease when `Cache` is off |
| `RPDU2MQTT_LEADER_LEASE_SECONDS` | Lease length. Default `15` |
