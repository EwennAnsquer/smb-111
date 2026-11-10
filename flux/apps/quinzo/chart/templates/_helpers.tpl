{{- define "quinzo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "quinzo.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "quinzo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "quinzo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "quinzo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "quinzo.labels" -}}
helm.sh/chart: {{ include "quinzo.chart" . }}
{{ include "quinzo.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "quinzo.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "quinzo.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Secret qui contient la clé d'admin */}}
{{- define "quinzo.secretName" -}}
{{- default (include "quinzo.fullname" .) .Values.quinzo.adminKey.existingSecret }}
{{- end }}
{{- define "quinzo.secretKey" -}}
{{- if .Values.quinzo.adminKey.existingSecret }}{{ .Values.quinzo.adminKey.existingSecretKey }}{{ else }}admin-key{{ end }}
{{- end }}

{{/* URL montrée aux joueurs */}}
{{- define "quinzo.publicUrl" -}}
{{- if .Values.quinzo.publicUrl -}}
{{- .Values.quinzo.publicUrl | trimSuffix "/" -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- if .Values.ingress.tls.enabled }}https{{ else }}http{{ end }}://{{ .Values.ingress.host }}
{{- end -}}
{{- end }}

{{/* Clé d'admin : valeur fournie, sinon celle déjà installée, sinon aléatoire */}}
{{- define "quinzo.adminKey" -}}
{{- $key := .Values.quinzo.adminKey.value -}}
{{- if not $key -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "quinzo.fullname" .) -}}
{{- if and $existing $existing.data (hasKey $existing.data "admin-key") -}}
{{- $key = index $existing.data "admin-key" | b64dec -}}
{{- else -}}
{{- $key = randAlphaNum 24 -}}
{{- end -}}
{{- end -}}
{{- $key -}}
{{- end }}

