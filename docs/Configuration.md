# Configuration Guide 

This guide will walk you through the configuration options available for this service. The configuration file, typically named `config.yaml`, should be properly set up before deploying the service.

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

### Polling Interval (Optional)
Set how often the PDU sensors should be polled and published to MQTT (in seconds).

```yaml
Pdu:
  PollInterval: 5  # Adjust the polling interval as needed
```

### Actions Enabled (Not yet implemented!)
Enable or disable the ability to perform write-actions on the PDU (e.g., toggling switches).

```yaml
Pdu:
  ActionsEnabled: true  # Set to false to disable any changes on the PDU
```

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
Customize individual outlets by their number. 

```yaml
Overrides:
  Outlets:
    1:
      ID: kube02                # Customize the outlet ID
      Name: "Proxmox: Kube02"   # Customize the outlet name
      Enabled: true             # Set to false to disable this outlet
```

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