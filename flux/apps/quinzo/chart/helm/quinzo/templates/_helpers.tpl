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

{{- define "quinzo.redisName" -}}
{{- printf "%s-redis" (include "quinzo.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "quinzo.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "quinzo.baseLabels" -}}
app.kubernetes.io/name: {{ include "quinzo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Pods de l'application */}}
{{- define "quinzo.selectorLabels" -}}
{{ include "quinzo.baseLabels" . }}
app.kubernetes.io/component: app
{{- end }}
{{/* Pod Redis */}}
{{- define "quinzo.redisSelectorLabels" -}}
{{ include "quinzo.baseLabels" . }}
app.kubernetes.io/component: redis
{{- end }}

{{- define "quinzo.labels" -}}
helm.sh/chart: {{ include "quinzo.chart" . }}
{{ include "quinzo.baseLabels" . }}
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

{{/* Mode multi-réplicas : Redis intégré ou externe */}}
{{- define "quinzo.multi" -}}
{{- if or .Values.redis.enabled .Values.externalRedis.url }}true{{ end }}
{{- end }}

{{- define "quinzo.trustProxy" -}}
{{- if eq (toString .Values.quinzo.trustProxy) "auto" }}{{ ternary "1" "0" .Values.ingress.enabled }}{{ else }}{{ ternary "1" "0" (eq (toString .Values.quinzo.trustProxy) "true") }}{{ end }}
{{- end }}

{{/* URL montrée aux joueurs */}}
{{- define "quinzo.publicUrl" -}}
{{- if .Values.quinzo.publicUrl -}}
{{- .Values.quinzo.publicUrl | trimSuffix "/" -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- if .Values.ingress.tls.enabled }}https{{ else }}http{{ end }}://{{ .Values.ingress.host }}
{{- end -}}
{{- end }}

{{/*
Valeur d'un secret : fournie, sinon celle déjà présente dans le cluster (mise à jour), sinon aléatoire.
Usage : include "quinzo.secretValue" (dict "ctx" . "key" "admin-password" "value" .Values.admin.password "length" 20)
*/}}
{{- define "quinzo.secretValue" -}}
{{- $v := .value -}}
{{- if not $v -}}
{{- $existing := lookup "v1" "Secret" .ctx.Release.Namespace (include "quinzo.fullname" .ctx) -}}
{{- if and $existing $existing.data (hasKey $existing.data .key) -}}
{{- $v = index $existing.data .key | b64dec -}}
{{- else -}}
{{- $v = randAlphaNum (int .length) -}}
{{- end -}}
{{- end -}}
{{- $v -}}
{{- end }}

{{- define "quinzo.adminSecretName" -}}
{{- default (include "quinzo.fullname" .) .Values.admin.existingSecret }}
{{- end }}
