# rPDU2MQTT

### What is rPDU2MQTT?

This is a simple container-based service, which queries data from a vertiv pdu unit, and submits the data to your MQTT broker.

If- you wish to learn more about these PDU units, I created at [blog post](https://static.xtremeownage.com/blog/2024/metered-switch-pdu/) detailing the units, with capabilities, and available configuration.

In addition, this container will also automatically create entities, and devices within Home Assistant, if discovery is enabled in your configuration.

## How do i...

### How to configure it?

For help with configuration, please see [Configuration Guide](./docs/Configuration.md)

### How do I deploy it or use it?

For help with deployment, including kubernetes manifests, and docker-compose examples, please see [Deployment Guide](./docs/Deployment.md)


## Help!

If you are unable to get this working as expected, there are a few options available to you.

First- sending a message in [My Discord](https://static.xtremeownage.com/discord), is the preferred option. Just- make sure to take @XtremeOwnage.

As well- you can submit a [New Issue](https://github.com/XtremeOwnage/rPDU2MQTT/issues/new/choose).

## Other Q&A

### Why didn't you just build a native home-assistant integration

A few reasons.

First- I code in .net for a living. I don't play with Python too often.

Next- this solution isn't specific to home assistant, and does not require home assistant at all to work.

Finally- in addition to creating home assistant configurations, devices, etc.... it also serves to populate, and update emoncms automatically. (pending, implementation.)