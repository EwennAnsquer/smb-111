# Chart Helm Quinzo

Déploie Quinzo (quiz multijoueur) sur Kubernetes, **sur plusieurs réplicas** avec un état partagé dans Redis.

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

```bash
docker build -t registry.maison.lan/quinzo:1.1.0 .
docker push registry.maison.lan/quinzo:1.1.0

# k3s sans registre : import direct sur CHAQUE nœud
docker save registry.maison.lan/quinzo:1.1.0 | sudo k3s ctr images import -
```

## 2. Installer

```bash
# k3s / Traefik, 2 réplicas + Redis intégré
helm install quinzo ./helm/quinzo -n quinzo --create-namespace \
  --set image.repository=registry.maison.lan/quinzo \
  --set ingress.enabled=true --set ingress.className=traefik \
  --set ingress.host=quiz.maison.lan

# ingress-nginx, 3 réplicas, TLS (cert-manager), NetworkPolicy
helm install quinzo ./helm/quinzo -n quinzo --create-namespace \
  --set image.repository=registry.maison.lan/quinzo \
  --set replicaCount=3 \
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
kubectl -n quinzo get pods -o wide            # pods quinzo répartis + 1 pod redis
kubectl -n quinzo logs -l app.kubernetes.io/component=app | grep 👑   # quel pod est leader
helm test quinzo -n quinzo                     # /readyz répond (appli + Redis)

# Bascule : supprime le pod leader en pleine partie, un autre reprend le chrono
kubectl -n quinzo delete pod <pod-leader>
```

## Valeurs principales

| Valeur | Défaut | Rôle |
|---|---|---|
| `replicaCount` | `2` | nombre de pods Quinzo (> 1 exige Redis) |
| `image.repository` / `image.tag` | `quinzo` / appVersion | image construite à l'étape 1 |
| `admin.enabled` | `false` | `true` = connexion par identifiant / mot de passe obligatoire pour l'écran hôte |
| `admin.username` / `admin.password` | `admin` / généré | compte de l'écran hôte si `admin.enabled` (mot de passe ≥ 10 caractères) |
| `admin.passwordHash` | vide | hash scrypt (`node server.js hash-password "…"`), à la place du mot de passe |
| `admin.existingSecret` | vide | Secret existant (clés `admin-username` / `admin-password`) |
| `redis.enabled` | `true` | Redis intégré (Valkey 8, mot de passe généré, AOF, PVC 1 Gi) |
| `externalRedis.url` | vide | Redis existant, ex. `redis://redis.infra:6379/0` (avec `redis.enabled=false`) |
| `sticky.enabled` | `true` | affinité : annotations ingress-nginx (Ingress) + Traefik (Service) + `sessionAffinity: ClientIP` |
| `quinzo.trustProxy` | `auto` | lit l'IP réelle dans `X-Forwarded-For` (auto = si Ingress activé) |
| `quinzo.publicUrl` | déduite de l'Ingress | adresse affichée aux joueurs / QR code |
| `quinzo.pin` | vide | code de partie fixe, **entre guillemets** |
| `ingress.*` | désactivé | `host`, `className`, `tls.enabled`, `tls.secretName`, `annotations` |
| `podDisruptionBudget.enabled` | `true` | garde au moins 1 pod pendant les maintenances de nœuds |
| `topologySpreadConstraints` | par nœud | répartit les pods sur des nœuds différents si possible |
| `networkPolicy.enabled` | `false` | appli : entrée HTTP, sortie DNS + Redis seulement ; Redis : entrée depuis l'appli seulement |

Sans Redis (`redis.enabled=false` et pas d'`externalRedis`), le chart repasse en **mode une instance** : 1 réplique, stratégie `Recreate`, volume pour les thèmes. Demander plus d'une réplique dans ce mode fait échouer l'installation avec un message explicite.

## Sécurité
- Pods sans root, système de fichiers en lecture seule, aucune capacité Linux, profil seccomp `RuntimeDefault`, jeton de ServiceAccount non monté.
- Mot de passe Redis dans un Secret, lu par Redis depuis un fichier de configuration, jamais en argument de commande.
- Avec `admin.enabled=true`, l'écran hôte et l'éditeur passent derrière une connexion :
  - sessions partagées par tous les pods via Redis ;
  - cookie `HttpOnly`, `SameSite=Strict`, et `Secure` en HTTPS ;
  - en-tête anti-CSRF obligatoire et vérification de l'origine des WebSockets.
- Mise à jour sans coupure : `RollingUpdate` (`maxUnavailable: 0`). À l'arrêt, un pod rend son bail de leader et ferme ses connexions ; les clients se reconnectent aussitôt sur un autre pod.

## Mise à jour depuis la version 0.1.0 du chart
Les sélecteurs de pods ont changé : l'appli et Redis portent désormais l'étiquette `app.kubernetes.io/component`, et Kubernetes interdit de modifier le sélecteur d'un Deployment existant. Désinstalle puis réinstalle : `helm uninstall quinzo -n quinzo`, puis `helm install …`. Le volume de la version 0.1.0 est conservé ; tes thèmes perso peuvent être réimportés depuis l'éditeur.
