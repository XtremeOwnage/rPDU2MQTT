---
title: Logging
---

# Logging

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Logging` | object |  |  |
| `Logging.LogFilePath` | string |  |  |
| `Logging.Console` | object |  |  |
| `Logging.Console.Severity` | one of `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal` |  |  |
| `Logging.Console.Format` | string |  |  |
| `Logging.Console.Enabled` | bool |  |  |
| `Logging.File` | object |  |  |
| `Logging.File.Path` | string |  |  |
| `Logging.File.FileRollover` | one of `Infinite`, `Year`, `Month`, `Day`, `Hour`, `Minute` |  |  |
| `Logging.File.FileRetention` | int |  |  |
| `Logging.File.Severity` | one of `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal` |  |  |
| `Logging.File.Format` | string |  |  |
| `Logging.File.Enabled` | bool |  |  |
| `Logging.Syslog` | object |  |  |
| `Logging.Syslog.Host` | string |  |  |
| `Logging.Syslog.Port` | int |  |  |
| `Logging.Syslog.Protocol` | one of `UDP`, `TCP` |  |  |
| `Logging.Syslog.AppName` | string |  |  |
| `Logging.Syslog.Severity` | one of `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal` |  |  |
| `Logging.Syslog.Format` | string |  |  |
| `Logging.Syslog.Enabled` | bool |  |  |
