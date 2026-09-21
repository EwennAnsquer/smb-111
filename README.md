# Projet SMB-111 — Déploiement d'un Cluster K3s sur Proxmox VE

Ce projet permet de provisionner automatiquement une infrastructure de machines virtuelles sur **n'importe quel hyperviseur Proxmox VE**, puis de configurer un cluster **K3s** et **FluxCD** via **Ansible**.

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
- Un compte **[GitHub](https://github.com/)** avec un token d'accès personnel (PAT) pour FluxCD.
- Un nom de domaine géré chez **[OVH](https://www.ovh.com/)** pour la génération automatique de certificats SSL Let's Encrypt (DNS-01).

---

## 🔑 ÉTAPE 1 : Configuration des clés SSH sur Proxmox

Pour que Terraform et Ansible puissent configurer les VMs via Cloud-Init et SSH, une clé SSH publique doit être présente sur l'hyperviseur Proxmox cible.

### 1. Vérifier ou créer votre clé SSH sur la machine `devops`
Vérifiez si vous possédez déjà une clé SSH :
```bash
ls -la ~/.ssh/id_ed25519.pub
```
Si vous n'en avez pas, génerer une nouvelle paire de clés :
```bash
ssh-keygen -t ed25519 -C "admin-smb111"
```

### 2. Ajouter la clé sur l'environnement Proxmox
- Copiez le contenu de votre clé publique (`cat ~/.ssh/id_ed25519.pub`).
- Sur l'interface Proxmox VE, rendez-vous dans **Datacenter** -> **Users** -> sélectionnez votre utilisateur -> **Edit** -> collez votre clé dans le champ **SSH Public Key**.
- *(Alternative)* Si vous utilisez une image modèle Cloud-Init, assurez-vous que cette clé est injectée dans les paramètres Cloud-Init du template Proxmox.

---

## 🎟️ ÉTAPE 2 : Création du token API Proxmox

Le projet s'adapte à n'importe quel serveur Proxmox VE. Vous devez générer un token d'accès API :

1. Connectez-vous à l'interface Web de votre serveur Proxmox.
2. Allez dans **Datacenter** -> **Permissions** -> **API Tokens**.
3. Cliquez sur **Add** :
   - Sélectionnez votre utilisateur.
   - Entrez un **Token ID** (ex: `terraform`).
   - **Décochez impérativement** la case **"Privilege Separation"**.
4. Copiez le Secret du Token généré.

---

## ⚙️ ÉTAPE 3 : Configuration du projet

### 1. Terraform (Cible Proxmox & Secret API)
Rendez-vous dans le dossier `terraform/` :

```bash
cd terraform/
cp secrets.tfvars.example secrets.tfvars
```

Éditez `secrets.tfvars` et collez votre token Proxmox :
```hcl
proxmox_api_token = "votre_token_api_proxmox_ici"
```

Ajustez ensuite le fichier `terraform.tfvars.json` pour cibler votre serveur Proxmox et définir votre réseau :
```json
{
  "proxmox_endpoint": "https://<IP-OU-FQDN-DE-VOTRE-PROXMOX>:8006",
  "proxmox_node_name": "<NOM-DU-NOEUD-PROXMOX>",
  "gateway": "192.168.1.1",
  "masters": {
    "k3s-master-0": { "id": 6100, "ip": "192.168.1.205", "ram": 4096, "cores": 2 },
    "k3s-master-1": { "id": 6101, "ip": "192.168.1.206", "ram": 4096, "cores": 2 },
    "k3s-master-2": { "id": 6102, "ip": "192.168.1.207", "ram": 4096, "cores": 2 }
  },
  "workers": {
    "k3s-worker-0": { "id": 6103, "ip": "192.168.1.208", "ram": 4096, "cores": 2 },
    "k3s-worker-1": { "id": 6104, "ip": "192.168.1.209", "ram": 4096, "cores": 2 }
  }
}
```

### 2. Ansible (Secrets GitHub)
Rendez-vous dans le dossier `ansible/vars/` :

```bash
cd ../ansible/vars/
cp secrets.yml.example secrets.yml
```

Éditez `secrets.yml` avec votre token GitHub :
```yaml
# ansible/vars/secrets.yml
github_token: "ghp_votre_token_github_ici"
```

### 3. Cert-Manager & Clés API OVH (Gestion exclusive OVH)
> ⚠️ **Note importante :** La résolution DNS-01 configurée dans ce cluster s'appuie exclusivement sur le webhook **OVH**. Elle requiert un nom de domaine dont la zone DNS est hébergée chez OVH.

1. Générez un jeu de clés d'API OVH sur [eu.api.ovh.com/createToken](https://eu.api.ovh.com/createToken/) (Droits requis : `GET /domain/zone/*`, `POST /domain/zone/*`, `DELETE /domain/zone/*`).
2. Créez votre fichier de secrets locaux à partir du modèle :
   ```bash
   cd ../../cluster/cert-manager-system/
   cp ovh-credentials.yml.example ovh-credentials.yml
   ```
3. Renseignez vos identifiants OVH dans `ovh-credentials.yml` :
   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: ovh-credentials
     namespace: cert-manager-system
   type: Opaque
   stringData:
     applicationKey: "VOTRE_APPLICATION_KEY"
     applicationSecret: "VOTRE_APPLICATION_SECRET"
     consumerKey: "VOTRE_CONSUMER_KEY"
   ```
4. *(Méthode recommandée pour GitOps)* **Ne commitez pas** `ovh-credentials.yml` en clair sur Git. Appliquez le Secret directement sur le cluster via `kubectl` ou chiffrez-le avec SOPS/Sealed Secrets.

---

## 🚀 ÉTAPE 4 : Déploiement

### Déploiement automatique
À la racine du projet, lancez le script global :

```bash
cd smb-111
chmod +x deploy.sh
./deploy.sh
```

### Déploiement manuel
1. **Provisionner l'infrastructure Proxmox :**
   ```bash
   cd ~/work/smb-111/terraform
   terraform init
   terraform apply -var-file="secrets.tfvars"
   ```

2. **Déployer K3s et FluxCD :**
   ```bash
   cd ~/work/smb-111/ansible
   ansible-playbook -i inventory.ini playbook.yml
   ```

3. **Appliquer les secrets OVH (si non gérés par GitOps) :**
   ```bash
   kubectl apply -f ../cluster/cert-manager-system/ovh-credentials.yml
   ```

---

## 🔍 ÉTAPE 5 : Connexion au Cluster et Lancement de K9s

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

---

## 📁 ARBORESCENCE DU PROJET (sûrement pas à jour)

```text
.
├── deploy.sh                        # Script d'automatisation globale
├── README.md                        # Documentation du projet
├── terraform/
│   ├── main.tf                      # Définition des VMs Proxmox
│   ├── providers.tf                 # Provider Proxmox
│   ├── terraform.tfvars.json        # Configuration du Proxmox cible et des VMs
│   └── secrets.tfvars               # Token API Proxmox (ignoré par Git)
├── ansible/
│   ├── ansible.cfg                  # Configuration Ansible
│   ├── inventory.ini                # Inventaire des nœuds K3s
│   ├── playbook.yml                 # Playbook de déploiement K3s & FluxCD
│   └── vars/
│       ├── all.yml                  # Variables Ansible
│       └── secrets.yml              # Token GitHub (ignoré par Git)
└── cluster/
    └── cert-manager-system/
        ├── namespace.yml            # Namespace cert-manager-system
        ├── helmrepo.yml             # Dépôt Helm Jetstack cert-manager
        ├── helmrelease.yml          # Installation de cert-manager
        ├── ovh-helmrepo.yml         # Dépôt Helm Webhook OVH
        ├── ovh-helmrelease.yml      # Installation du Webhook OVH
        ├── cluster-issuer.yml       # ClusterIssuer Let's Encrypt DNS-01 OVH
        ├── certificate.yml          # Définition du certificat Wildcard
        ├── ovh-credentials.yml.example  # Modèle de Secret pour l'API OVH
        └── ovh-credentials.yml      # Secrets OVH réels (ignoré par Git)
```
