# Projet SMB-111 — Déploiement d'un Cluster K3s sur Proxmox VE

Ce projet permet de provisionner automatiquement une infrastructure de machines virtuelles sur **n'importe quel hyperviseur Proxmox VE**, puis de configurer un cluster **K3s** et **FluxCD** via **Ansible**.

Tous les secrets du projet (variables Terraform, secrets Ansible, secrets Kubernetes) sont chiffrés avec **SOPS** et **age**, ce qui permet de les stocker en toute sécurité directement dans le dépôt Git.

---

## 🛠️ OUTILS ET PRÉREQUIS

Avant de commencer, assurez-vous d'avoir installé les outils suivants sur votre machine d'administration (`devops`) :

- **[Proxmox VE](https://www.proxmox.com/en/proxmox-virtual-environment/overview)** : Hyperviseur cible (accès réseau et compte administrateur requis).
- **[Terraform](https://www.terraform.io/)** (>= 1.0) : Pour le provisioning des VMs.
- **[Ansible](https://www.ansible.com/)** : Pour le déploiement et l'automatisation du cluster.
- **[K3s](https://k3s.io/)** : Distribution Kubernetes légère.
- **[kubectl](https://kubernetes.io/docs/tasks/tools/)** : CLI officielle de Kubernetes.
- **[k9s](https://k9scli.io/)** : Interface TUI pour gérer le cluster.
- **[FluxCD](https://fluxcd.io/)** : Outil de déploiement continu GitOps.
- **[SOPS](https://github.com/getsops/sops)** : Outil de chiffrement de fichiers de configuration (YAML, JSON).
- **[age](https://github.com/FiloSottile/age)** : Outil de chiffrement à clé publique utilisé par SOPS.
- Un compte **[GitHub](https://github.com/)** avec un token d'accès personnel (PAT) pour FluxCD.
- Un nom de domaine géré chez **[OVH](https://www.ovh.com/)** pour la génération automatique de certificats SSL Let's Encrypt (DNS-01).

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
- **Kubernetes / Flux :** Les secrets Kubernetes (comme `ovh-credentials` dans `cluster/cert-manager-system/`) sont chiffrés avec SOPS et appliqués automatiquement au cluster.

Si vous devez modifier un fichier de secrets chiffré, utilisez SOPS :
```bash
sops terraform/secrets.enc.tfvars.json
sops ansible/vars/secrets.enc.yml
```

---

## 🚀 ÉTAPE 5 : Déploiement

Le script `deploy.sh` s'occupe de déchiffrer temporairement les secrets nécessaires en mémoire, de provisionner les VMs Proxmox via Terraform, d'attendre la disponibilité du SSH, puis de déployer K3s et FluxCD via Ansible.

```bash
chmod +x deploy.sh
./deploy.sh
```

---

## 🔍 ÉTAPE 6 : Connexion au Cluster et Lancement de K9s

### Vérifier le cluster
```bash
kubectl --kubeconfig ~/.kube/config-k3s get nodes -o wide
```

### Vérifier l'état du certificat SSL Let's Encrypt (OVH)
```bash
kubectl get clusterissuer
kubectl get certificate -n default
```

### Lancer K9s
Pour administrer votre cluster avec k9s :
```bash
k9s --kubeconfig ~/.kube/config-k3s
```
