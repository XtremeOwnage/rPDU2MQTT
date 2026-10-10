---
title: Modbus
---

# Modbus

Generated from `rPDU2MQTT --emit-schema`. Keys are case-insensitive. `[]` marks a list item and `<name>` a map key of your choosing. A blank default means none is declared.

Modbus TCP connections that energy-flow nodes can be bound to (inverters, meters, PLCs).

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `Modbus` | object |  | Modbus TCP connections that energy-flow nodes can be bound to (inverters, meters, PLCs). |
| `Modbus.Connections` | list |  | Modbus TCP devices to poll. Add one per device, then reference it from a source binding's Connection. |
| `Modbus.Connections[].Id` | string |  | Stable id used to reference this connection from a source binding. |
| `Modbus.Connections[].Name` | string |  | Friendly name for the device (shown in the editor). |
| `Modbus.Connections[].Host` | string |  | Hostname or IP address of the Modbus TCP device. |
| `Modbus.Connections[].Port` | int | `502` | TCP port the device listens on (Modbus TCP default 502; RS485-to-Ethernet gateways often use 4196, 8899, or 502). |
| `Modbus.Connections[].Framing` | one of `auto`, `tcp`, `rtu-over-tcp` | `auto` | Wire protocol: 'auto' (try native Modbus TCP, then Modbus RTU over TCP, and use whichever the device answers), 'tcp' (native Modbus TCP), or 'rtu-over-tcp' (Modbus RTU frames over a raw TCP socket — what most RS485-to-Ethernet gateways / serial dongles speak, e.g. an EG4 inverter on port 4196/8899). Leave on 'auto' unless you want to pin one. |
| `Modbus.Connections[].UnitId` | int | `1` | Modbus unit / slave id. |
| `Modbus.Connections[].PollIntervalSeconds` | int | `10` | How often to poll this device, in seconds. Range 1–86400. |
| `Modbus.Connections[].TimeoutMs` | int | `1500` | Read/write timeout per Modbus request, in milliseconds. Lower it to fail faster on an unresponsive device; raise it for a slow gateway. Range 200–30000. |
| `Modbus.Connections[].Enabled` | bool | `true` | Poll this device. Turn off to disable it without deleting the connection. |
