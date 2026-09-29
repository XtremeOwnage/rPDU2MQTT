---
title: Logging and debug
---

# Logging and debug

## What each level tells you

Every sink below takes its own `Severity`, so you can keep the console quiet and send the detail to a file or
syslog instead. What you get at each level:

| Level | What it covers |
| --- | --- |
| `Information` | The default. What the process decided to be at startup (roles, config source, every PDU/Modbus source, every destination that's on or off), each PDU's shape when it changes, and **every write** — outlet on/off/reboot, config field changes, group actions. Anything that changes the physical world or the topology. |
| `Debug` | Why nothing is happening. Each poll with its latency and counts, the energy-flow graph as it's provisioned (each node's type and feeders), flow ingest batches, feed provisioning passes, subscription reconciliation, and failures that are repeats of one already reported. |
| `Verbose` (trace) | The roll-up, step by step: every node's value change and who it notified, every ingested reading, every topic sample. This is what to turn on when a tier's number looks wrong and nothing else explains it — it is very chatty, so prefer a file sink. |

A useful troubleshooting combination — normal console, full detail on disk:

```yaml
Logging:
  Console:
    Enabled: true
    Severity: Information
  File:
    Enabled: true
    Severity: Verbose
    Path: /config/rpdu2mqtt.log
```

## Console Logging
Customize how messages are logged to the console (stdout).

```yaml
Logging:
  Console:
    Enabled: true  # Set to false to disable console logging
    Severity: Information  # Minimum severity of messages to log
    Format: "[{Timestamp:HH:mm:ss} {Level}] {Message:lj}{NewLine}{Exception}"  # Customize the log format
```

## File Logging
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

## Syslog Logging
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

## Debug Options

Use these settings when debugging or requiring additional data.

You- typically should never need to touch, or change any settings here.

```yaml
Debug:
  PrintDiscovery: false  # Set to true to print discovery messages to the console
  PublishMessages: true  # Set to false to test the program without sending messages
```
