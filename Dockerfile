FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS base
# Numeric UID so kubelet can verify runAsNonRoot.
USER $APP_UID
WORKDIR /app

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
ARG BUILD_CONFIGURATION=Release
# Version stamped into the binary; CI passes the tag-derived version.
ARG APP_VERSION=0.0.0-dev
# Node binary for the MSBuild TypeScript build of the GUI assets.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /src
COPY ["rPDU2MQTT/rPDU2MQTT.csproj", "rPDU2MQTT/"]
COPY ["rPDU2MQTT.Abstractions/rPDU2MQTT.Abstractions.csproj", "rPDU2MQTT.Abstractions/"]
COPY ["rPDU2MQTT.Core/rPDU2MQTT.Core.csproj", "rPDU2MQTT.Core/"]
COPY ["rPDU2MQTT.Engine/rPDU2MQTT.Engine.csproj", "rPDU2MQTT.Engine/"]
COPY ["rPDU2MQTT.Api/rPDU2MQTT.Api.csproj", "rPDU2MQTT.Api/"]
COPY ["rPDU2MQTT.Web/rPDU2MQTT.Web.csproj", "rPDU2MQTT.Web/"]
COPY ["plugins/rPDU2MQTT.Plugin.Tigo/rPDU2MQTT.Plugin.Tigo.csproj", "plugins/rPDU2MQTT.Plugin.Tigo/"]
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
# Default external plugin directory (override with RPDU2MQTT_PLUGINS).
RUN mkdir -p /app/plugins
ENTRYPOINT ["dotnet", "rPDU2MQTT.dll"]
