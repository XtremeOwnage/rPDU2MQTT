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

{{/* True when a credentials Secret should be referenced (either managed here or external). */}}
{{- define "rpdu2mqtt.hasSecret" -}}
{{- if or .Values.existingSecret .Values.credentials.mqtt.username .Values.credentials.mqtt.password .Values.credentials.pdu.username .Values.credentials.pdu.password .Values.credentials.emoncmsApiKey .Values.credentials.oidcClientSecret -}}
true
{{- end -}}
{{- end -}}
