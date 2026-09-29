---
title: Debug
---

# Debug

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Settings for debugging and diagnostics.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Debug` | object |  | Settings for debugging and diagnostics. |
| `Debug.PublishMessages` | bool | `true` | Actually publish messages to the broker. Turn off to dry-run the whole pipeline without sending anything. |
| `Debug.PrintDiscovery` | bool | `false` | Log the Home Assistant discovery JSON to the console (verbose; for troubleshooting discovery). |
