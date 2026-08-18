{{/* Expand the name of the chart. */}}
{{- define "rpdu2mqtt.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Fully qualified app name. */}}
{{- define "rpdu2mqtt.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "rpdu2mqtt.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rpdu2mqtt.labels" -}}
helm.sh/chart: {{ include "rpdu2mqtt.chart" . }}
{{ include "rpdu2mqtt.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "rpdu2mqtt.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rpdu2mqtt.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "rpdu2mqtt.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "rpdu2mqtt.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "rpdu2mqtt.secretName" -}}
{{- if .Values.existingSecret -}}{{ .Values.existingSecret }}{{- else -}}{{ include "rpdu2mqtt.fullname" . }}{{- end -}}
{{- end -}}

{{- define "rpdu2mqtt.crName" -}}
{{- default (include "rpdu2mqtt.fullname" .) .Values.kubernetesConfigSource.crName -}}
{{- end -}}

{{/* True when the app exposes /metrics. Enabled is the old name for Exporter; the app still honors it. */}}
{{- define "rpdu2mqtt.metricsEnabled" -}}
{{- if or (dig "Prometheus" "Exporter" false .Values.config) (dig "Prometheus" "Enabled" false .Values.config) -}}
true
{{- end -}}
{{- end -}}

{{- define "rpdu2mqtt.metricsPort" -}}
{{- dig "Prometheus" "Port" 9184 .Values.config -}}
{{- end -}}

{{/* True when the app exposes the read-only REST API + its OpenAPI/Scalar docs (#190). */}}
{{- define "rpdu2mqtt.apiEnabled" -}}
{{- if dig "Api" "Enabled" false .Values.config -}}
true
{{- end -}}
{{- end -}}

{{- define "rpdu2mqtt.apiPort" -}}
{{- dig "Api" "Port" 8082 .Values.config -}}
{{- end -}}

{{/*
Resolve a route backend name to a Service. Routes name a logical target ("gui" / "api"); this maps it
to the release's Service so ingress.yaml and httproute.yaml stay in agreement about the naming.
Usage: include "rpdu2mqtt.backendService" (dict "root" $ "service" "api")
*/}}
{{- define "rpdu2mqtt.backendService" -}}
{{- $svc := default "gui" .service -}}
{{- if not (has $svc (list "gui" "api")) -}}
{{- fail (printf "route backend service must be \"gui\" or \"api\", got %q" $svc) -}}
{{- end -}}
{{- /* Fail loudly rather than emit a route to a Service this chart never creates. */ -}}
{{- if eq $svc "api" -}}
{{- if not (include "rpdu2mqtt.apiEnabled" .root) -}}
{{- fail "a route targets `service: api`, but config.Api.Enabled is false — the API Service is not created. Set config.Api.Enabled=true." -}}
{{- end -}}
{{- if not .root.Values.service.api.enabled -}}
{{- fail "a route targets `service: api`, but service.api.enabled is false — the API Service is not created." -}}
{{- end -}}
{{- else -}}
{{- if not (dig "Gui" "Enabled" false .root.Values.config) -}}
{{- fail "a route targets `service: gui`, but config.Gui.Enabled is false — the GUI Service is not created. Set config.Gui.Enabled=true." -}}
{{- end -}}
{{- if not .root.Values.service.gui.enabled -}}
{{- fail "a route targets `service: gui`, but service.gui.enabled is false — the GUI Service is not created." -}}
{{- end -}}
{{- end -}}
{{- printf "%s-%s" (include "rpdu2mqtt.fullname" .root) $svc -}}
{{- end -}}

{{- define "rpdu2mqtt.backendPort" -}}
{{- $svc := default "gui" .service -}}
{{- if eq $svc "api" -}}
{{- include "rpdu2mqtt.apiPort" .root -}}
{{- else -}}
{{- dig "Gui" "Port" 8080 .root.Values.config -}}
{{- end -}}
{{- end -}}

{{/* True when a credentials Secret should be referenced (either managed here or external). */}}
{{- define "rpdu2mqtt.hasSecret" -}}
{{- if or .Values.existingSecret .Values.credentials.mqtt.username .Values.credentials.mqtt.password .Values.credentials.pdu.username .Values.credentials.pdu.password .Values.credentials.emoncmsApiKey .Values.credentials.oidcClientSecret .Values.credentials.apiKey -}}
true
{{- end -}}
{{- end -}}
