# Sécurité réseau et Pod Security Admission

Ce document décrit les profils Pod Security Admission (PSA) des namespaces, les
flux réseau autorisés entre namespaces et les exceptions assumées. Il sert de
référence avant toute modification d'une NetworkPolicy.

Les NetworkPolicies n'ont pas de mode « audit » : un default-deny mal réglé
coupe immédiatement le trafic. Les changements doivent donc être déployés par
lots, avec un test de connectivité après chaque lot.

## Pod Security Admission

| Namespace | enforce | audit | warn | Justification |
|---|---|---|---|---|
| `quinzo` | `baseline` | `restricted` | `restricted` | pods déjà restricted-compatibles |
| `lldap-system` | `baseline` | `restricted` | `restricted` | pods durcis dans ce lot |
| `authelia-system` | `baseline` | `restricted` | `restricted` | chart root, PVC `/config` root |
| `cert-manager-system` | `baseline` | `restricted` | `restricted` | webhook OVH et chart cert-manager |
| `traefik-system` | `baseline` | `restricted` | `restricted` | chart déjà hardened |
| `monitoring-system` | `privileged` | `baseline` | `baseline` | node-exporter `hostNetwork`/`hostPID`/`hostPath`, Alloy `/var/log` |
| `longhorn-system` | `privileged` | `privileged` | `privileged` | iSCSI, moteur, hostPath |
| `tailscale-system` | `privileged` | `privileged` | `privileged` | pods proxy privilégiés |
| `kube-system` | `privileged` | `privileged` | `privileged` | kube-vip, klipper-lb, CoreDNS, metrics-server |
| `flux-system` | inchangé | — | `restricted` | namespace généré par Flux |

`monitoring-system` ne peut pas être en `baseline` : le DaemonSet
`prometheus-node-exporter` utilise `hostNetwork`, `hostPID` et monte `/proc`,
`/sys` et `/`, et Alloy monte `/var/log`. Le profil `privileged` est donc
nécessaire ; les autres pods du namespace restent conformes à `baseline`.

Le namespace `kube-system` est déclaré dans
`flux/infrastructure/controllers/kube/namespace.yml` avec l'annotation
`kustomize.toolkit.fluxcd.io/prune: disabled` pour éviter toute suppression
accidentelle par Flux.

## Matrice des flux

### Entrée externe et Ingress

| Source | Destination | Port | Remarque |
|---|---|---|---|
| LAN / Internet | `traefik-system` (pods Traefik) | `8000`, `8443` | via `svclb-traefik` (kube-system) et kube-vip |
| `traefik-system` | `authelia-system/authelia` | `80` → `9091` | ForwardAuth et portail |
| `traefik-system` | `lldap-system/lldap` | `17170` | interface web |
| `traefik-system` | `longhorn-system/longhorn-frontend` | `80` | pas de NetworkPolicy sur ce namespace |
| `traefik-system` | `monitoring-system/grafana` | `80` → `3000` | |
| `traefik-system` | `monitoring-system/vmsingle` | `8428` | vmui |
| `traefik-system` | `monitoring-system/vmalert` | `8080` | |
| `traefik-system` | `monitoring-system/alertmanager` | `9093` | |
| `traefik-system` | `quinzo/quinzo` | `3000` | NetworkPolicy du chart |
| `monitoring-system` | `traefik-system` | `9100` | métriques Traefik (si scrape activé) |

### Authentification et annuaire

| Source | Destination | Port | Remarque |
|---|---|---|---|
| `authelia-system` | `lldap-system/lldap` | `3890` | bind LDAP |
| `lldap-system` (bootstrap) | `lldap-system/lldap` | `17170` | CronJob de bootstrap |
| Tous les namespaces isolés | `kube-system` (CoreDNS) | `53/UDP`, `53/TCP` | résolution DNS |

### Certificats

| Source | Destination | Port | Remarque |
|---|---|---|---|
| API server | `cert-manager-system` (webhooks) | `10250`, `8443` | appel depuis l'IP du nœud, donc toutes sources autorisées sur ces ports |
| `cert-manager-system` | `cert-manager-system` (interne) | tous | controller, cainjector et webhooks |
| `cert-manager-system` | API Kubernetes | `6443` | |
| `cert-manager-system` | Internet | `443` | ACME Let's Encrypt et API OVH |
| `monitoring-system` | `cert-manager-system` | `9402` | métriques (scrape éventuel) |

### Monitoring et journaux

| Source | Destination | Port | Remarque |
|---|---|---|---|
| `monitoring-system` (vmagent) | API Kubernetes | `6443` | découverte de services |
| `monitoring-system` (vmagent) | kubelets | `10250` | cAdvisor, métriques kubelet |
| `monitoring-system` (vmagent) | `node-exporter` | `9100` | |
| `monitoring-system` (vmagent) | `kube-state-metrics` | `8080` | |
| `monitoring-system` (vmagent) | CoreDNS | `9153` | |
| `monitoring-system` (vmagent) | etcd / controller-manager | `2381` / `10257` | |
| `monitoring-system` (vmagent) | `longhorn-system` | `9500` | `VMServiceScrape` Longhorn |
| `monitoring-system` (Alloy) | API Kubernetes, Loki | `6443`, `3100` | |
| `monitoring-system` (Grafana) | vmsingle, Loki, Internet | `8428`, `3100`, `443` | plugin VictoriaMetrics |
| `monitoring-system` (vmalert) | vmsingle, Alertmanager | `8428`, `9093` | |
| `monitoring-system` (Alertmanager) | Internet | `443`, `587` | Discord / SMTP |
| `monitoring-system` (role-sync) | Grafana | `80` | CronJob first-party |
| API server | `monitoring-system` (opérateur VM) | `9443` | webhook d'admission des CRs |

### Applications

| Source | Destination | Port | Remarque |
|---|---|---|---|
| `quinzo` (app) | `quinzo-redis` | `6379` | NetworkPolicy du chart |
| `quinzo` | DNS | `53` | NetworkPolicy du chart |

### Sorties non restreintes dans ce lot

| Namespace | Sortie | Raison |
|---|---|---|
| `monitoring-system` | toutes | scrapes dynamiques, plugins Grafana, Alertmanager |
| `traefik-system` | toutes | backends dynamiques, API Kubernetes |
| `longhorn-system` | toutes | réplication, iSCSI, sauvegardes MinIO (`192.168.1.220`) |
| `tailscale-system` | toutes | control plane Tailscale, proxy |

## Exceptions et choix

- **`traefik-system`** : default-deny ingress avec autorisation explicite de
  `8000/8443` depuis toutes sources. Le trafic externe est conservé par
  `svclb-traefik` (kube-system) et kube-vip. Les ports API `8080` et métriques
  `9100` ne sont plus joignables librement.
- **`monitoring-system`** : seul l'ingress est restreint. L'egress reste ouvert
  pour ne pas casser les scrapes (API, kubelets, etcd, CoreDNS, Longhorn, pods
  annotés) ni les téléchargements de plugins Grafana.
- **`longhorn-system`** : Longhorn crée lui-même ses NetworkPolicies
  (manager, instance-manager, webhook, recovery, backing-image). Un default-deny
  manuel casserait le moteur et l'iSCSI. Seule la politique additive
  `longhorn-manager-allow-monitoring` est maintenue.
- **`kube-system`** : pas de NetworkPolicy, car CoreDNS, kube-vip, klipper-lb et
  metrics-server ont des besoins host/réseau non exprimables simplement.
- **`tailscale-system`** : pods privilégiés et connectivité sortante large.
- **Authelia** : reste en `baseline` et tourne en root dans ce lot ; son PVC
  `/config` appartient à root. Un passage non-root nécessite un chown ou une
  recréation du volume, à traiter séparément.

## Vérification

```bash
# Construction des kustomizations
for d in \
  flux/infrastructure/controllers \
  flux/infrastructure/controllers/lldap \
  flux/infrastructure/controllers/authelia \
  flux/infrastructure/controllers/cert-manager \
  flux/infrastructure/controllers/monitoring \
  flux/infrastructure/controllers/traefik \
  flux/infrastructure/controllers/kube \
  flux/apps \
  flux/apps/quinzo; do
  kubectl kustomize "$d" >/dev/null || exit 1
done

# Chart Quinzo
helm lint flux/apps/quinzo/chart
helm template quinzo flux/apps/quinzo/chart -n quinzo \
  --show-only templates/networkpolicy.yaml

# Dry-run serveur (fichiers sans secrets)
kubectl apply --dry-run=server \
  -f flux/infrastructure/controllers/lldap/namespace.yml \
  -f flux/infrastructure/controllers/lldap/networkpolicy.yml \
  -f flux/infrastructure/controllers/lldap/deployment.yml \
  -f flux/infrastructure/controllers/lldap/bootstrap-cronjob.yml \
  -f flux/infrastructure/controllers/authelia/namespace.yml \
  -f flux/infrastructure/controllers/authelia/networkpolicy.yml \
  -f flux/infrastructure/controllers/cert-manager/namespace.yml \
  -f flux/infrastructure/controllers/cert-manager/networkpolicy.yml \
  -f flux/infrastructure/controllers/monitoring/namespace.yml \
  -f flux/infrastructure/controllers/monitoring/networkpolicy.yml \
  -f flux/apps/monitoring/grafana-role-sync-cronjob.yml \
  -f flux/infrastructure/controllers/traefik/namespace.yml \
  -f flux/infrastructure/controllers/traefik/networkpolicy.yml \
  -f flux/infrastructure/controllers/kube/namespace.yml \
  -f flux/apps/quinzo/namespace.yml \
  -f flux/apps/quinzo/networkpolicy.yml
```

```bash
# Labels PSA
kubectl get ns -o custom-columns='NAME:.metadata.name,ENFORCE:.metadata.labels.pod-security\.kubernetes\.io/enforce,AUDIT:.metadata.labels.pod-security\.kubernetes\.io/audit'

# Test de rejet (doit être refusé en baseline)
kubectl -n quinzo run psa-test --image=busybox --restart=Never --dry-run=server \
  --overrides='{"spec":{"containers":[{"name":"psa-test","image":"busybox","securityContext":{"privileged":true}}]}}'
```

```bash
# Connectivité depuis un namespace sans politique : doit échouer après
kubectl -n default run netcheck --rm -it --restart=Never --image=nicolaka/netshoot -- \
  sh -c 'for t in lldap.lldap-system.svc:3890 lldap.lldap-system.svc:17170 authelia.authelia-system.svc:80 quinzo.quinzo.svc:3000 vm-stack-grafana.monitoring-system.svc:80; do h=${t%:*}; p=${t##*:}; nc -z -w 2 "$h" "$p" && echo "OK $t" || echo "KO $t"; done'

# Depuis Traefik : doit réussir
kubectl -n traefik-system run netcheck --rm -it --restart=Never --image=nicolaka/netshoot -- \
  sh -c 'for t in authelia.authelia-system.svc:80 lldap.lldap-system.svc:17170 quinzo.quinzo.svc:3000 longhorn-frontend.longhorn-system.svc:80; do h=${t%:*}; p=${t##*:}; nc -z -w 2 "$h" "$p" && echo "OK $t" || echo "KO $t"; done'

# Depuis Authelia : LDAP doit réussir
kubectl -n authelia-system run netcheck --rm -it --restart=Never --image=nicolaka/netshoot -- \
  nc -z -w 2 lldap.lldap-system.svc 3890
```

```bash
# Probes et métriques
kubectl get pods -A -o wide | grep -vE 'Running|Completed'
kubectl get events -A --field-selector reason=Unhealthy --sort-by=.lastTimestamp | tail -20

pod=$(kubectl -n monitoring-system get pod -l app.kubernetes.io/name=vmsingle -o jsonpath='{.items[0].metadata.name}')
kubectl -n monitoring-system exec "$pod" -- \
  wget -qO- 'http://127.0.0.1:8428/api/v1/query?query=count(up==0)'

pod=$(kubectl -n monitoring-system get pod -l app.kubernetes.io/name=vmagent -o jsonpath='{.items[0].metadata.name}')
kubectl -n monitoring-system exec "$pod" -c vmagent -- \
  wget -qO- http://127.0.0.1:8429/targets | grep -c 'health":"down'
```

```bash
# Réconciliation Flux
flux reconcile source git flux-system
flux reconcile kustomization infra-controllers --with-source
flux get kustomizations
flux get helmreleases -A
```

## Rollback

En urgence, supprimer la politique fautive (elle sera recréée au prochain
reconcile Flux) :

```bash
kubectl delete networkpolicy default-deny -n <namespace>
```

Puis corriger dans Git et réconcilier :

```bash
git revert <sha>
git push
flux reconcile source git flux-system
flux reconcile kustomization infra-controllers --with-source
flux reconcile kustomization apps --with-source
```
