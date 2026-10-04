# Projet SMB-111 — Déploiement d'un Cluster K3s sur Proxmox VE

Ce projet provisionne automatiquement des machines virtuelles sur **n'importe quel hyperviseur Proxmox VE** avec **Terraform**, puis configure un cluster **K3s** et **FluxCD** via **Ansible**. Flux déploie ensuite toute la stack d'infrastructure (ingress, certificats, SSO, stockage, monitoring) en GitOps.

Tous les secrets du projet (variables Terraform, secrets Ansible, secrets Kubernetes) sont chiffrés avec **SOPS** et **age**, ce qui permet de les stocker en toute sécurité directement dans le dépôt Git.

---

## 🧱 CE QUI EST DÉPLOYÉ

| Composant | Rôle | Namespace |
|---|---|---|
| **Traefik** | Ingress controller | `traefik-system` |
| **cert-manager** + **webhook OVH** | Certificats Let's Encrypt (DNS-01 via OVH) | `cert-manager-system` |
| **Authelia** | SSO / portail d'authentification (ForwardAuth, OIDC) | `authelia-system` |
| **lldap** | Annuaire LDAP utilisé par Authelia | `lldap-system` |
| **Longhorn** | Stockage persistant distribué (StorageClass `longhorn`) | `longhorn-system` |
| **Tailscale operator** | Accès au cluster via Tailscale | `tailscale-system` |
| **VictoriaMetrics k8s stack** | Métriques, Grafana, vmalert, Alertmanager | `monitoring-system` |
| **Loki** + **Alloy** | Stockage et collecte des logs | `monitoring-system` |

Les services sont exposés sous `*.smb-111.azby.fr` (ex. `longhorn.smb-111.azby.fr`, `auth.smb-111.azby.fr`) et protégés par Authelia.

### Ordre de réconciliation Flux

Les `Kustomization` Flux s'enchaînent par dépendances :

```
infra-controllers  →  infra-configs  →  apps
(HelmReleases)        (ClusterIssuer…)   (Ingress, applications)
```

Si `infra-controllers` échoue, les deux suivantes restent en attente (`dependency ... is not ready`).

---

## 🛠️ OUTILS ET PRÉREQUIS

Avant de commencer, assurez-vous d'avoir installé les outils suivants sur votre machine d'administration (`devops`) :

- **[Proxmox VE](https://www.proxmox.com/en/proxmox-virtual-environment/overview)** : Hyperviseur cible (accès réseau et compte administrateur requis).
- **[Terraform](https://www.terraform.io/)** (>= 1.0) : Pour le provisioning des VMs.
- **[Ansible](https://www.ansible.com/)** : Pour le déploiement et l'automatisation du cluster.
- **[K3s](https://k3s.io/)** : Distribution Kubernetes légère.
- **[kubectl](https://kubernetes.io/docs/tasks/tools/)** : CLI officielle de Kubernetes.
- **[k9s](https://k9scli.io/)** : Interface TUI pour gérer le cluster.
- **[FluxCD](https://fluxcd.io/)** (CLI `flux`) : Outil de déploiement continu GitOps.
- **[SOPS](https://github.com/getsops/sops)** : Outil de chiffrement de fichiers de configuration (YAML, JSON).
- **[age](https://github.com/FiloSottile/age)** : Outil de chiffrement à clé publique utilisé par SOPS.
- **[kubelogin](https://github.com/int128/kubelogin)** (plugin `kubectl oidc-login`) : Uniquement pour l'accès au cluster avec authentification OIDC (voir étape 7).
- Un compte **[GitHub](https://github.com/)** avec un token d'accès personnel (PAT) pour FluxCD.
- Un nom de domaine géré chez **[OVH](https://www.ovh.com/)** pour la génération automatique de certificats SSL Let's Encrypt (DNS-01).

**Prérequis sur les nœuds** (normalement gérés par le playbook Ansible) : `open-iscsi` (service `iscsid` actif) et `nfs-common`, nécessaires à Longhorn.

---

## 🔑 ÉTAPE 1 : Configuration de la clé age pour SOPS

Les secrets du projet sont chiffrés avec une clé **age**. Pour pouvoir déployer l'infrastructure, vous devez disposer de la clé privée correspondante sur votre machine.

1. Créez le dossier de configuration SOPS s'il n'existe pas :
   ```bash
   mkdir -p ~/.config/sops/age
   ```
2. Placez votre clé privée `age` dans le fichier `keys.txt` :
   ```bash
   nano ~/.config/sops/age/keys.txt
   ```
3. Vérifiez les permissions du fichier :
   ```bash
   chmod 600 ~/.config/sops/age/keys.txt
   ```

---

## 🔑 ÉTAPE 2 : Configuration des clés SSH sur Proxmox

Pour que Terraform et Ansible puissent configurer les VMs via Cloud-Init et SSH, une clé SSH publique doit être présente sur l'hyperviseur Proxmox cible.

### 1. Vérifier ou créer votre clé SSH sur la machine `devops`
```bash
ls -la ~/.ssh/id_ed25519.pub
```
Si vous n'en avez pas, générez une nouvelle paire de clés :
```bash
ssh-keygen -t ed25519 -C "admin-smb111"
```

### 2. Ajouter la clé sur l'environnement Proxmox
- Copiez le contenu de votre clé publique (`cat ~/.ssh/id_ed25519.pub`).
- Sur l'interface Proxmox VE, rendez-vous dans **Datacenter** -> **Users** -> sélectionnez votre utilisateur -> **Edit** -> collez votre clé dans le champ **SSH Public Key**.

---

## 🎟️ ÉTAPE 3 : Token API Proxmox

Pour permettre à Terraform de communiquer avec Proxmox :

1. Connectez-vous à l'interface Web de votre serveur Proxmox.
2. Allez dans **Datacenter** -> **Permissions** -> **API Tokens**.
3. Cliquez sur **Add** :
   - Sélectionnez votre utilisateur.
   - Entrez un **Token ID** (ex: `terraform`).
   - **Décochez impérativement** la case **"Privilege Separation"**.
4. Le token et les identifiants requis sont déjà chiffrés dans le fichier `terraform/secrets.enc.tfvars.json`.

---

## ⚙️ ÉTAPE 4 : Gestion des Secrets avec SOPS

Tous les secrets sont versionnés directement dans le dépôt sous forme chiffrée. **Aucun fichier de modèle `.example` n'est nécessaire.**

### Fichiers de secrets du projet :
- **Terraform :** `terraform/secrets.enc.tfvars.json` (Contient le token API Proxmox et les accès).
- **Ansible :** `ansible/vars/secrets.enc.yml` (Contient le token GitHub pour FluxCD).
- **Kubernetes / Flux :** Les secrets Kubernetes (identifiants OVH pour cert-manager, secrets Authelia, etc.) sont chiffrés avec SOPS dans le répertoire `flux/` et déchiffrés par Flux au moment de l'application.

Si vous devez modifier un fichier de secrets chiffré, utilisez SOPS :
```bash
sops terraform/secrets.enc.tfvars.json
sops ansible/vars/secrets.enc.yml
```

---

## 🚀 ÉTAPE 5 : Déploiement

Le script `deploy.sh` s'occupe de déchiffrer temporairement les secrets nécessaires en mémoire, de provisionner les VMs Proxmox via Terraform, d'attendre la disponibilité du SSH, puis de déployer K3s et FluxCD via Ansible.

### Déploiement standard
```bash
chmod +x deploy.sh
./deploy.sh
```

### Installation neuve du cluster (fresh install)

Pour repartir d'un cluster vierge, lancez le script avec la variable `FRESH_CLUSTER=1` :

```bash
FRESH_CLUSTER=1 ./deploy.sh
```

> ⚠️ **Attention** : une réinstallation complète efface l'état du cluster, y compris les volumes Longhorn et les données qu'ils contiennent (Loki, Grafana, base SQLite d'Authelia…). À n'utiliser que si vous acceptez de tout perdre.

### Suivre le déploiement Flux

Une fois le script terminé, Flux déploie la stack en plusieurs minutes (Longhorn, Loki et la stack VictoriaMetrics sont les plus longs) :

```bash
flux get kustomizations
flux get helmreleases -A
```

Tout doit passer à `READY True`. Pour forcer une réconciliation après un `git push` :

```bash
flux reconcile source git flux-system
flux reconcile kustomization infra-controllers --with-source
```

---

## 🔍 ÉTAPE 6 : Connexion au Cluster et Lancement de K9s

### Vérifier le cluster
```bash
kubectl --kubeconfig ~/.kube/config-k3s get nodes -o wide
```

### Vérifier les certificats SSL Let's Encrypt (OVH)
```bash
kubectl get clusterissuer
kubectl get certificate -A
```

Le certificat d'un service n'est créé que si son `Ingress` porte l'annotation `cert-manager.io/cluster-issuer` **et** un bloc `spec.tls` avec un `secretName` (voir la section Dépannage).

### Lancer K9s
Pour administrer votre cluster avec k9s :
```bash
k9s --kubeconfig ~/.kube/config-k3s
```

---

## 🔐 ÉTAPE 7 : Accès au cluster avec authentification OIDC (optionnel)

Deux kubeconfig sont disponibles. Le choix se fait simplement avec la variable `KUBECONFIG` :

| Fichier | Usage |
|---|---|
| `~/.kube/config-k3s` | Accès **sans authentification** (certificat d'administration, comme à l'étape 6). |
| `~/.kube/config-k3s-oidc` | Accès **authentifié via Authelia** (OIDC), les utilisateurs viennent de lldap. |

### Activer l'authentification OIDC
```bash
export KUBECONFIG=~/.kube/config-k3s-oidc
kubectl get nodes
```
Au premier appel, `kubelogin` ouvre le navigateur sur le portail Authelia (`https://auth.smb-111.azby.fr`). Après connexion, le jeton est mis en cache dans `~/.kube/cache/oidc-login` et réutilisé jusqu'à son expiration.

Le client OIDC `kubernetes` est déclaré dans le HelmRelease d'Authelia : client public avec PKCE (`S256`), redirections vers `http://localhost:8000` et `http://localhost:18000`, scopes `openid profile email groups`. Ces ports locaux doivent donc être libres au moment de la connexion. Les groupes lldap sont transmis dans le jeton : les droits dans le cluster dépendent des `RBAC` (bindings sur ces groupes ou utilisateurs).

### Connexion depuis un poste distant : port forwarding sur le port 8000

`kubectl` tourne sur la machine `devops`, mais le navigateur est sur votre poste. Après l'authentification, Authelia redirige le navigateur vers `http://localhost:8000`, où `kubelogin` attend le retour. Sans redirection de port, `localhost:8000` pointe vers votre poste et non vers `devops`, et la connexion échoue.

Il faut donc ouvrir la session SSH avec un `LocalForward` sur le port 8000. Exemple de `~/.ssh/config` sur votre poste :

```
Host devops
    HostName 192.168.1.87
    User root
    IdentityFile ~/Desktop/ssh_keys/devops
    LocalForward 8000 127.0.0.1:8000
```

Ou ponctuellement, sans modifier la config :
```bash
ssh -L 8000:127.0.0.1:8000 root@192.168.1.87
```

Déroulé :
1. Connectez-vous en SSH à `devops` (le forwarding est actif tant que la session est ouverte).
2. Sur `devops`, lancez `export KUBECONFIG=~/.kube/config-k3s-oidc` puis `kubectl get nodes`.
3. Ouvrez dans le navigateur de votre poste l'URL de connexion affichée par `kubelogin` (si aucun navigateur ne peut s'ouvrir sur `devops`).
4. Authentifiez-vous sur Authelia : le retour sur `localhost:8000` traverse le tunnel jusqu'à `kubelogin`.

Notes :
- Le port 8000 doit être libre sur votre poste. S'il est déjà utilisé, le forwarding échoue (le port 18000, déclaré aussi dans Authelia, peut servir de secours avec un `LocalForward 18000` équivalent).
- Une seule session SSH à la fois peut détenir le forward sur le port 8000.
- Si le jeton est encore valide dans le cache, aucune connexion navigateur n'est nécessaire.

### Revenir à l'accès sans authentification
```bash
export KUBECONFIG=~/.kube/config-k3s
```

### Se déconnecter (supprimer le jeton OIDC)
```bash
./logout.sh
```
Le script supprime le cache `~/.kube/cache/oidc-login` ; la prochaine commande kubectl en mode OIDC redemandera une connexion. Il ne supprime que le jeton local : la session ouverte sur le portail Authelia reste active dans le navigateur, et la reconnexion peut donc être immédiate. Pour la fermer, déconnectez-vous du portail.

---

## 🩺 DÉPANNAGE

### `dry-run failed ... spec.interval: Required value`
Tout `HelmRelease` doit avoir un `spec.interval` **au niveau de `spec`**. L'`interval` de `chart.spec` est un autre champ (fréquence de vérification des nouvelles versions du chart). Pour repérer les oublis :
```bash
grep -rl "kind: HelmRelease" flux/ | xargs grep -L "^  interval:"
```

### `Helm install failed ... timeout waiting for ...`
Avec un `timeout` trop court (1 min), Helm déclare l'échec avant que le volume Longhorn soit attaché. Avec `install.remediation.retries: -1`, Flux désinstalle puis réinstalle en boucle. Recommandation pour les charts avec stockage (Longhorn, Loki, vm-stack) :
```yaml
spec:
  interval: 10m
  timeout: 10m
  install:
    remediation:
      retries: 3
```

### Longhorn bloqué en `unable to determine state for release with status 'uninstalling'`
Longhorn refuse d'être désinstallé tant que le réglage `deleting-confirmation-flag` n'est pas à `true`. Sur une installation neuve sans données :
```bash
kubectl -n longhorn-system patch settings.longhorn.io deleting-confirmation-flag \
  --type=merge -p '{"value":"true"}'
```
Si cela reste bloqué, supprimer l'état Helm et relancer :
```bash
kubectl -n longhorn-system delete secret -l owner=helm,name=longhorn-release
flux reconcile helmrelease longhorn-release -n longhorn-system --force
```

### Le navigateur affiche `MOZILLA_PKIX_ERROR_SELF_SIGNED_CERT`
L'`Ingress` n'a pas demandé de certificat à cert-manager, donc Traefik sert son certificat par défaut (auto-signé). Vérifier que l'Ingress contient :
```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod   # nom exact du ClusterIssuer
spec:
  tls:
    - hosts:
        - mon-service.smb-111.azby.fr
      secretName: mon-service-tls
```
Lister les Ingress sans TLS :
```bash
kubectl get ingress -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,TLS:.spec.tls[*].secretName
```
Suivre l'émission (DNS-01, compter 1 à 3 minutes) :
```bash
kubectl get certificate,certificaterequest,order,challenge -A
```
