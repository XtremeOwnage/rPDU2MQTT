# Deploying `rpdu2mqtt` with unRAID

This guide will help you deploy the `rpdu2mqtt` service using the [unRAID server](https://unraid.net/) platform GUI

## Prerequisites

Before you begin it is *highly recommended* you have access to the docker appdata folder `mnt/user/appdata`

Two methods:
 - [Rootshare](https://forums.unraid.net/topic/58053-video-guide-how-to-setup-a-root-share-in-unraid-1-share-to-rule-them-all/)
 - [Dynamix File Manager](https://forums.unraid.net/topic/120982-dynamix-file-manager/)

## Step 1: Prepare the Configuration File

Create a `config.yaml` file that will be used to configure the `rpdu2mqtt` service. This file should contain your specific configuration settings.

For help on setting up `config.yaml`, please see [Configuration Documentation](./../../docs/Configuration.md)

Use any text editor and save as `config.yaml` or `config.yml`

## Step 2: Create & Upload the `config.yaml` to your storage location

Create a folder `rpdu2mqtt` and sub-folder `config` to store the `config.yaml` configuration file.

E.g: `mnt/user/appdata/rpdu2mqtt/config`

*Note1: You could store (and subsequently map) this anywhere, but I think it makes most sense to store in the predefined docker storage location*

*Note2: The 'config' sub-folder is unecessary*

## Step 3: Deploy the Service

Navigate to the docker tab in unRAID.

Scroll down & Click: `Add Container`

Name it: Something spicey e.g. `rpdu2mqtt`

Set the Repository: `ghcr.io/xtremeownage/rpdu2mqtt:main`
 - Note: You can [select different sources by utilizing](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pulling-container-images) a 'colon' or '@' (:main - main branch, :latest - most recent tagged release, :v0.2.1 - specific tagged branch, @sha256: - specific commit)

Network Type: `Bridge` - Though, choose whatever makes sense. See below.

Click: `Add another Path, Port, Variable, Lable or Device`

Name it: `config`

Container Path: `/config`

Host Path: `/mnt/user/appdata/rpdu2mqtt/config` [Map to your config.yaml location]

Click: `Add`

Click: `Apply`

The container should pull from the repository and then start automatically.

Check for any errors.

Click: `Done`

## Step 4: Verify the Deployment

To ensure the service is running correctly, refresh the unRAID page to see if the `rpdu2mqtt` container stoped unexpectedly.

This will show the status of the `rpdu2mqtt` container faster than waiting for an auto-refresh.

Common issues are due to a malformed `config.yaml` file.

You can also view the logs to check for any errors or important information by clickign on the container icon and selecting the logs menu item in the context menu.


#
Google AI Generated Answer (Verified by me, pretty good summary).

```Here are some differences between Docker bridge, host, and custom networks in Unraid: 
 
Bridge
The default network mode for Docker, bridge networks are used within a single host. They can solve port conflicts and provide network isolation for containers. In Unraid, you can customize which ports a container uses when the network type is set to bridge. 
 
Host
In Docker host networking, a container shares its network namespace with the host machine. Host networking is optional but required to use DLNA. 
 
Custom
User-defined bridges provide automatic DNS resolution between containers, better isolation, and the ability to attach and detach containers on the fly. To preserve user-defined networks in Unraid, go to Settings > Docker, select Preserve user defined networks, and set it to Yes. 
 
Macvlan
A macvlan network gives a container its own dedicated IP on the network, similar to a real machine. All ports are open by default, so port forwarding is not required.```
