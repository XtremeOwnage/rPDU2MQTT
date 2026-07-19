#See https://aka.ms/customizecontainer to learn how to customize your debug container and how Visual Studio uses this Dockerfile to build your images for faster debugging.

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
USER app
WORKDIR /app

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
# Human-readable version stamped into the binary (GUI / MQTT discovery / heartbeat).
# CI passes the tag-derived version; local `docker build` falls back to a dev marker.
ARG APP_VERSION=0.0.0-dev
# The GUI assets are built from TypeScript by an MSBuild target using only the `node` binary (no npm).
# Bring Node in from the official image; if it's ever unavailable the build falls back to the committed bundle.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /src
COPY ["rPDU2MQTT/rPDU2MQTT.csproj", "rPDU2MQTT/"]
COPY ["rPDU2MQTT.Core/rPDU2MQTT.Core.csproj", "rPDU2MQTT.Core/"]
COPY ["rPDU2MQTT.Engine/rPDU2MQTT.Engine.csproj", "rPDU2MQTT.Engine/"]
COPY ["rPDU2MQTT.Api/rPDU2MQTT.Api.csproj", "rPDU2MQTT.Api/"]
COPY ["rPDU2MQTT.Web/rPDU2MQTT.Web.csproj", "rPDU2MQTT.Web/"]
RUN dotnet restore "./rPDU2MQTT/rPDU2MQTT.csproj"
COPY . .
WORKDIR "/src/rPDU2MQTT"
RUN dotnet build "./rPDU2MQTT.csproj" -c $BUILD_CONFIGURATION -o /app/build /p:InformationalVersion="$APP_VERSION"

FROM build AS publish
ARG BUILD_CONFIGURATION=Release
ARG APP_VERSION=0.0.0-dev
RUN dotnet publish "./rPDU2MQTT.csproj" -c $BUILD_CONFIGURATION -o /app/publish /p:UseAppHost=false /p:InformationalVersion="$APP_VERSION"

FROM base AS final
WORKDIR /app
COPY --from=publish /app/publish .
ENTRYPOINT ["dotnet", "rPDU2MQTT.dll"]
