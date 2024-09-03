# Deploying `rpdu2mqtt` with unRAID

This guide will help you deploy the `rpdu2mqtt` service using unRAID

## Prerequisites

Before you begin you need access to your docker appdata folder `mnt/user/appdata`

Two methods:
 - [rootshare](https://forums.unraid.net/topic/58053-video-guide-how-to-setup-a-root-share-in-unraid-1-share-to-rule-them-all/)
 - [Dynamix File Manager](https://forums.unraid.net/topic/120982-dynamix-file-manager/)

## Step 1: Prepare the Configuration File

Create a `config.yaml` file that will be used to configure the `rpdu2mqtt` service. This file should contain your specific configuration settings.

For help on setting up `config.yaml`, please see [Configuration Documentation](./../../docs/Configuration.md)

Populate the `config.yaml` file with your desired configuration settings.

## Step 2: Create & Upload the `config.yaml` to your storage location

`mnt/user/appdata/rpdu2mqtt/config`

Note: you could store (and subsequently map) this anywhere, but I think it makes most sense to store in the predefined docker storage location

## Step 3: Deploy the Service

Navigate to the docker tab in unRAID.

Scroll down & Click: `Add Container`

Name it: `rpdu2mqtt`

Repository: `ghcr.io/xtremeownage/rpdu2mqtt:main`
Note: You can [select different sources by utilizing](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pulling-container-images) a 'colon' or '@' (:main - main branch, :latest - most recent tagged release, :v0.2.1 - specific tagged branch, @sha256: - specific commit)


## Step 4: Verify the Deployment

To ensure the service is running correctly, use the following command:

```bash
docker-compose ps
```

This will show the status of the `rpdu2mqtt` container.

You can also view the logs to check for any errors or important information:

```bash
docker-compose logs -f
```
