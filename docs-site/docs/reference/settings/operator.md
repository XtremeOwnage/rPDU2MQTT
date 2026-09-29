---
title: Operator
---

# Operator

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Kubernetes operator: let this release manage its own Deployment (registry update checks, optional self-update).

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Operator` | object |  | Kubernetes operator: let this release manage its own Deployment (registry update checks, optional self-update). |
| `Operator.Enabled` | bool | `false` | Enable the Kubernetes operator: let this release manage its own Deployment (registry update checks, optional self-update). Requires the Kubernetes config source and the 'operator' role. No effect otherwise. |
| `Operator.CheckForUpdates` | bool | `true` | Periodically check the container registry for a newer image and report it (in the CR status and the GUI Diagnostics page). Read-only — never changes the Deployment on its own. |
| `Operator.CheckIntervalHours` | int | `6` | How often to check the registry for updates, in hours. |
| `Operator.Policy` | one of `Patch`, `Minor`, `Major` | `Minor` | How far an update may move the deployed version: Patch (same major.minor), Minor (same major, no breaking changes), or Major (any newer release). |
| `Operator.AutoUpdate` | bool | `false` | Automatically roll the Deployment to the newest eligible release (bounded by Policy). Off by default — checking is safe, but applying an update restarts the workload. |
| `Operator.Registry` | string |  | Override the registry host to query (e.g. ghcr.io). Defaults to the registry of the currently-deployed image. |
| `Operator.Repository` | string |  | Override the repository to query (e.g. xtremeownage/rpdu2mqtt). Defaults to the repository of the currently-deployed image. |
