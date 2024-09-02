# Deploying `rpdu2mqtt` with Docker Compose

This guide will help you deploy the `rpdu2mqtt` service using Docker Compose.

## Prerequisites

Before you begin, ensure you have the following installed on your system:

- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

## Step 1: Prepare the Configuration File

Create a `config.yaml` file that will be used to configure the `rpdu2mqtt` service. This file should contain your specific configuration settings.

For help on setting up `config.yaml`, please see [Configuration Documentation](./../../docs/Configuration.md)

```bash
touch config.yaml
```

Populate the `config.yaml` file with your desired configuration settings.

## Step 2: Create the Docker Compose File

Create a `docker-compose.yml`. 

See [docker-compose.yaml](./docker-compose.yaml)

This file defines the Docker service and specifies the necessary security and resource constraints.

## Step 3: Deploy the Service

Navigate to the directory containing your `docker-compose.yml` and `config.yaml` files, then deploy the service using Docker Compose:

```bash
docker-compose up -d
```

This command will download the required Docker image and start the `rpdu2mqtt` service in detached mode.

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