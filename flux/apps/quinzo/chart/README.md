# Chart Helm Quinzo

Déploie Quinzo (quiz multijoueur) sur Kubernetes. L'image publiée est la **1.0.1** : une seule instance, état en mémoire persisté sur un volume. Le schéma ci-dessous décrit l'architecture multi-réplicas, prise en charge par le chart mais **pas encore par une image publiée** (voir étape 4).

```
                  ┌──────────── Ingress (affinité par cookie) ────────────┐
 navigateurs ───► │  quinzo_sticky=pod-A → pod A   /   pod-B → pod B       │
                  └───────────────┬───────────────────────┬───────────────┘
                                  ▼                       ▼
                          ┌──────────────┐        ┌──────────────┐
                          │ Quinzo pod A │◄──────►│ Quinzo pod B │   adaptateur Socket.IO (pub/sub)
                          │  (leader)    │        │              │
                          └──────┬───────┘        └──────┬───────┘
                                 └──────────┬────────────┘
                                            ▼
                        Redis (Valkey) : état de partie, sessions admin,
                        thèmes, verrou, bail du leader, compteurs anti-abus
```

## 1. Construire et publier l'image

L'image réellement déployée est `azby/smb-111:1.0.1` (Docker Hub). Épinglée par digest
dans le HelmRelease : `sha256:f6ba4574b0525a862bab90cbf5a66958c60b1250949e74609b5dc83ec0136e8d`.

```bash
docker build -t azby/smb-111:1.0.1 .
docker push azby/smb-111:1.0.1
```

Pour un cluster k3s sans registre, import direct sur CHAQUE nœud :

```bash
docker save azby/smb-111:1.0.1 | sudo k3s ctr images import -
```

## 2. Installer

```bash
# k3s / Traefik — valeurs par défaut : 1 réplica, sans Redis
helm install quinzo ./flux/apps/quinzo/chart -n quinzo --create-namespace \
  --set ingress.enabled=true --set ingress.className=traefik \
  --set ingress.host=quiz.maison.lan

# ingress-nginx, TLS (cert-manager), NetworkPolicy
helm install quinzo ./flux/apps/quinzo/chart -n quinzo --create-namespace \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set ingress.host=quiz.maison.lan --set ingress.tls.enabled=true \
  --set-string ingress.annotations."cert-manager\.io/cluster-issuer"=letsencrypt \
  --set networkPolicy.enabled=true
```

Ouvre ensuite `https://quiz.maison.lan/host` pour l'écran hôte. La page des joueurs a aussi un bouton **🖥️ Écran hôte**.

L'écran hôte est **en accès libre** par défaut. Pour exiger un identifiant et un mot de passe, ajoute `--set admin.enabled=true`. Le mot de passe est alors généré, sauf si tu en fournis un :

```bash
kubectl -n quinzo get secret quinzo -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

## 3. Vérifier

```bash
kubectl -n quinzo get pods -o wide            # 1 seul pod quinzo, aucun pod redis
kubectl -n quinzo logs deploy/quinzo          # pas de connexion Redis, pas d'élection de leader
helm test quinzo -n quinzo                     # /readyz répond
```

Avec Redis (1.1.0 ou Redis externe), la vérification devient :

```bash
kubectl -n quinzo get pods -o wide            # pods quinzo répartis + 1 pod redis
kubectl -n quinzo logs -l app.kubernetes.io/component=app | grep 👑   # quel pod est leader

# Bascule : supprime le pod leader en pleine partie, un autre reprend le chrono
kubectl -n quinzo delete pod <pod-leader>
```

## 4. Bascule vers l'image 1.1.0 (multi-réplicas)

Le chart gère déjà l'architecture multi-réplicas (Redis, adaptateur Socket.IO, leader
election, sticky). Elle nécessite un code applicatif 1.1.0, **qui n'est pas encore publié**
sur Docker Hub (`azby/smb-111` ne propose que 1.0.0 et 1.0.1). Tant que c'est le cas, le
chart déploie 1.0.1 en mono-instance : c'est volontaire et cohérent.

Pour basculer, une fois l'image construite et poussée :

```bash
docker build -t azby/smb-111:1.1.0 .
docker push azby/smb-111:1.1.0
docker buildx imagetools inspect azby/smb-111:1.1.0   # relever le digest
```

Puis dans `chart/Chart.yaml` : `appVersion: "1.1.0"` et bump de `version`. Dans
`chart/values.yaml` : `replicaCount: 2`, `redis.enabled: true`, `sticky.enabled: true`,
`podDisruptionBudget.enabled: true`. Enfin, mettre à jour `image.digest` dans
`flux/apps/quinzo/helmrelease.yml`.

## Valeurs principales

| Valeur | Défaut | Rôle |
|---|---|---|
| `replicaCount` | `1` | nombre de pods Quinzo (> 1 exige Redis, donc pas avec l'image 1.0.1) |
| `image.repository` / `image.tag` | `azby/smb-111` / appVersion | image construite à l'étape 1 |
| `image.digest` | vide | digest `sha256:…` épinglé après le tag (reproductibilité) |
| `admin.enabled` | `false` | `true` = connexion par identifiant / mot de passe obligatoire pour l'écran hôte |
| `admin.username` / `admin.password` | `admin` / généré | compte de l'écran hôte si `admin.enabled` (mot de passe ≥ 10 caractères) |
| `admin.passwordHash` | vide | hash scrypt (`node server.js hash-password "…"`), à la place du mot de passe |
| `admin.existingSecret` | vide | Secret existant (clés `admin-username` / `admin-password`) |
| `redis.enabled` | `false` | Redis intégré (Valkey 8, mot de passe généré, AOF, PVC 1 Gi) — inutile pour 1.0.1 |
| `externalRedis.url` | vide | Redis existant, ex. `redis://redis.infra:6379/0` (avec `redis.enabled=false`) |
| `sticky.enabled` | `false` | affinité : annotations ingress-nginx (Ingress) + Traefik (Service) + `sessionAffinity: ClientIP` |
| `quinzo.trustProxy` | `auto` | lit l'IP réelle dans `X-Forwarded-For` (auto = si Ingress activé) |
| `quinzo.publicUrl` | déduite de l'Ingress | adresse affichée aux joueurs / QR code |
| `quinzo.pin` | vide | code de partie fixe, **entre guillemets** |
| `ingress.*` | désactivé | `host`, `className`, `tls.enabled`, `tls.secretName`, `annotations` |
| `podDisruptionBudget.enabled` | `false` | garde au moins 1 pod pendant les maintenances (à activer dès 2 réplicas) |
| `topologySpreadConstraints` | par nœud | répartit les pods sur des nœuds différents si possible |
| `networkPolicy.enabled` | `false` | appli : entrée HTTP, sortie DNS + Redis seulement ; Redis : entrée depuis l'appli seulement |

Sans Redis (`redis.enabled=false` et pas d'`externalRedis`), le chart repasse en **mode une instance** : 1 réplique, stratégie `Recreate`, volume pour les thèmes. C'est le mode par défaut tant que l'image 1.1.0 n'est pas publiée. Demander plus d'une réplique dans ce mode fait échouer l'installation avec un message explicite.

## Sécurité
- Pods sans root, système de fichiers en lecture seule, aucune capacité Linux, profil seccomp `RuntimeDefault`, jeton de ServiceAccount non monté.
- Mot de passe Redis dans un Secret, lu par Redis depuis un fichier de configuration, jamais en argument de commande.
- Avec `admin.enabled=true`, l'écran hôte et l'éditeur passent derrière une connexion :
  - sessions partagées par tous les pods via Redis ;
  - cookie `HttpOnly`, `SameSite=Strict`, et `Secure` en HTTPS ;
  - en-tête anti-CSRF obligatoire et vérification de l'origine des WebSockets.
- Mise à jour sans coupure (`RollingUpdate`, `maxUnavailable: 0`) uniquement avec Redis, donc à partir de l'image 1.1.0. Avec l'image 1.0.1, le déploiement est en `Recreate` : le volume RWO impose un seul pod à la fois, il y a donc une courte coupure. À l'arrêt, un pod rend son bail de leader et ferme ses connexions ; les clients se reconnectent aussitôt sur un autre pod.

## Mise à jour depuis la version 0.1.0 du chart
Les sélecteurs de pods ont changé : l'appli et Redis portent désormais l'étiquette `app.kubernetes.io/component`, et Kubernetes interdit de modifier le sélecteur d'un Deployment existant. Désinstalle puis réinstalle : `helm uninstall quinzo -n quinzo`, puis `helm install …`. Le volume de la version 0.1.0 est conservé ; tes thèmes perso peuvent être réimportés depuis l'éditeur.
