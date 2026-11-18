#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$PROJECT_DIR" || exit 1

# Clé age utilisée par SOPS (Terraform, Ansible et secret sops-age de Flux)
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

if [ ! -f "$SOPS_AGE_KEY_FILE" ]; then
  echo "Erreur : clé age introuvable ($SOPS_AGE_KEY_FILE)."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Erreur : jq est requis pour vérifier le plan Terraform."
  exit 1
fi

# Options du script
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
FRESH_INSTALL="${FRESH_INSTALL:-0}"
SSH_WAIT_TIMEOUT="${SSH_WAIT_TIMEOUT:-300}"

# FRESH_CLUSTER est l'ancien nom, conservé comme alias déprécié
if [ -n "${FRESH_CLUSTER:-}" ]; then
  echo "Avertissement : FRESH_CLUSTER est déprécié, utilisez FRESH_INSTALL."
  if [ "$FRESH_INSTALL" != "1" ]; then
    FRESH_INSTALL="$FRESH_CLUSTER"
  fi
fi

case "$FRESH_INSTALL" in
  0 | 1) ;;
  *)
    echo "Erreur : FRESH_INSTALL doit valoir 0 ou 1 (reçu : $FRESH_INSTALL)."
    exit 1
    ;;
esac

case "$SSH_WAIT_TIMEOUT" in
  '' | *[!0-9]*)
    echo "Erreur : SSH_WAIT_TIMEOUT doit être un nombre de secondes (reçu : $SSH_WAIT_TIMEOUT)."
    exit 1
    ;;
esac
if [ "$SSH_WAIT_TIMEOUT" -le 0 ]; then
  echo "Erreur : SSH_WAIT_TIMEOUT doit être supérieur à 0."
  exit 1
fi

# Nettoyage automatique des fichiers temporaires à la fin du script
TMP_VARS=$(mktemp --suffix=.tfvars.json)
TMP_ANSIBLE_VARS=$(mktemp --suffix=.yml)
TMP_PLAN=$(mktemp --suffix=.tfplan)
trap 'rm -f "$TMP_VARS" "$TMP_ANSIBLE_VARS" "$TMP_PLAN"' EXIT

# 0. Flux synchronise depuis GitHub : tout doit être poussé avant le bootstrap
echo -e "Vérification que le dépôt est synchronisé avec GitHub..."
git -C "$PROJECT_DIR" fetch origin

if [ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]; then
  if [ "$ALLOW_DIRTY" != "1" ]; then
    echo "Erreur : l'arbre Git n'est pas propre."
    echo "Flux déploie depuis GitHub : les modifications locales ne seront jamais appliquées."
    echo "Commitez et poussez vos changements, ou relancez avec ALLOW_DIRTY=1."
    exit 1
  fi
  echo "Avertissement : ALLOW_DIRTY=1, les modifications locales ne seront pas déployées par Flux."
fi

if ! UPSTREAM=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  echo "Erreur : la branche courante n'a pas de branche upstream (git push -u origin <branche>)."
  exit 1
fi
if [ "$(git -C "$PROJECT_DIR" rev-parse HEAD)" != "$(git -C "$PROJECT_DIR" rev-parse "$UPSTREAM")" ]; then
  echo "Erreur : la branche locale n'est pas synchronisée avec origin (git push / git pull)."
  exit 1
fi

# 0 bis. Mode fresh : supprimer les gotk-* pour forcer un nouveau bootstrap Flux
if [ "$FRESH_INSTALL" = "1" ]; then
  FLUX_PATH="$PROJECT_DIR/flux/clusters/prod" # doit correspondre à target_path dans group_vars/all.yml
  KUBECONFIG_LOCAL="${KUBECONFIG:-$HOME/.kube/config-k3s}"

  echo -e "\nMode FRESH_INSTALL : préparation d'un nouveau bootstrap Flux."
  echo "Ce mode ne détruit ni les VMs, ni les volumes Longhorn, ni les données."
  echo "Il suppose que le cluster a déjà été détruit (terraform destroy)."

  # Sécurité : ne pas retirer les manifests d'un Flux encore actif (Flux les supprimerait)
  if command -v kubectl >/dev/null 2>&1 && [ -f "$KUBECONFIG_LOCAL" ]; then
    if kubectl --kubeconfig "$KUBECONFIG_LOCAL" --request-timeout=5s \
      -n flux-system get deploy source-controller >/dev/null 2>&1; then
      echo "Erreur : Flux est encore actif sur le cluster ($KUBECONFIG_LOCAL)."
      echo "Détruisez d'abord le cluster (terraform destroy) avant d'utiliser FRESH_INSTALL=1."
      exit 1
    fi
  fi

  if [ "$ASSUME_YES" != "1" ]; then
    if ! read -r -p "Confirmer la suppression des gotk-* et le nouveau bootstrap Flux ? [oui/N] " answer; then
      echo -e "\nConfirmation impossible : utilisez ASSUME_YES=1 pour une exécution non interactive."
      exit 1
    fi
    case "$answer" in
      oui | OUI | Oui) ;;
      *)
        echo "Annulé."
        exit 1
        ;;
    esac
  fi

  if compgen -G "$FLUX_PATH/gotk-*.yaml" >/dev/null; then
    echo "Suppression des anciens gotk-* avant le bootstrap..."
    git -C "$PROJECT_DIR" rm -q "$FLUX_PATH"/gotk-*.yaml
    git -C "$PROJECT_DIR" commit -qm "Flux: supprimer les manifests gotk-* avant un bootstrap neuf"
    git -C "$PROJECT_DIR" push
  else
    echo "Aucun manifest gotk-* à supprimer."
  fi
fi

# 1. Déploiement Terraform
cd "$PROJECT_DIR/terraform" || exit 1
if [ ! -f backend.hcl ]; then
  echo "Erreur : terraform/backend.hcl est absent. Copiez backend.hcl.example et adaptez le bucket S3/MinIO." >&2
  exit 1
fi
terraform init -backend-config=backend.hcl

sops -d secrets.enc.tfvars.json >"$TMP_VARS"
terraform plan -var-file="$TMP_VARS" -lock-timeout=5m -input=false -out="$TMP_PLAN"

# Un plan qui supprime des ressources (VMs, disques) doit être explicitement autorisé.
if [ "${ALLOW_DESTRUCTIVE_PLAN:-0}" != "1" ] &&
  terraform show -json "$TMP_PLAN" | jq -e '[.resource_changes[]? | select(.change.actions | index("delete"))] | length > 0' >/dev/null; then
  echo "Erreur : le plan Terraform supprime des ressources (VMs ou disques inclus)." >&2
  echo "Après sauvegarde, relancez avec ALLOW_DESTRUCTIVE_PLAN=1 si c'est intentionnel." >&2
  exit 1
fi

terraform apply -lock-timeout=5m -auto-approve "$TMP_PLAN"

# On se place dans le dossier ansible en avance pour avoir accès à inventory.ini
cd "$PROJECT_DIR/ansible" || exit 1

echo -e "\nRécupération dynamique des adresses IP depuis l'inventaire Ansible..."
# Extraction des IPs : on cherche "ansible_host=", on coupe la ligne et on garde juste l'IP
mapfile -t NODES < <(awk -F'ansible_host=' '/ansible_host=/ {split($2, a, " "); print a[1]}' inventory.ini)

if [ "${#NODES[@]}" -eq 0 ]; then
  echo "Erreur : Aucune adresse IP trouvée dans inventory.ini."
  exit 1
fi

echo "IPs trouvées : ${NODES[*]}"

# 2. Vérification des collections Ansible requises par le playbook
echo -e "\nVérification des collections Ansible (community.general, community.sops)..."
ansible-galaxy collection install -r requirements.yml

# 3. Attente SSH avec timeout par hôte
echo -e "\nAttente de l'ouverture du port SSH (timeout ${SSH_WAIT_TIMEOUT}s par hôte)..."
ansible-playbook -i inventory.ini preflight.yml -e "ssh_wait_timeout=${SSH_WAIT_TIMEOUT}"

# 4. Lancement d'Ansible
echo -e "\nPréparation des variables Ansible (secrets SOPS + clé age pour Flux)..."
sops -d group_vars/secrets.enc.yml >"$TMP_ANSIBLE_VARS"

# Injection de la clé age dans les variables (variable sops_age_key du playbook)
{
  printf '\nsops_age_key: |\n'
  sed 's/^/  /' "$SOPS_AGE_KEY_FILE"
} >>"$TMP_ANSIBLE_VARS"

echo -e "\nLancement du playbook Ansible..."
ansible-playbook -i inventory.ini playbook.yml -e @"$TMP_ANSIBLE_VARS"

# 5. Le bootstrap Flux a commité gotk-components.yaml et gotk-sync.yaml sur GitHub
echo -e "\nMise à jour du dépôt local (fichiers gotk-* générés par Flux)..."
git -C "$PROJECT_DIR" pull --ff-only

# 6. Aplatir : sortir les fichiers gotk-* du sous-dossier flux-system/
FLUX_PATH="$PROJECT_DIR/flux/clusters/prod" # doit correspondre à target_path dans group_vars/all.yml

if [ -d "$FLUX_PATH/flux-system" ]; then
  echo -e "\nAplatissement du dossier flux-system..."
  mv -f "$FLUX_PATH"/flux-system/gotk-*.yaml "$FLUX_PATH/"
  rm -rf "$FLUX_PATH/flux-system"

  git -C "$PROJECT_DIR" add -A "$FLUX_PATH"
  git -C "$PROJECT_DIR" commit -m "Flux: move gotk files out of flux-system folder"
  git -C "$PROJECT_DIR" push

  echo "Fichiers gotk-* déplacés et poussés."
fi

echo -e "\nDéploiement terminé. Suivi de Flux :"
echo "  export KUBECONFIG=~/.kube/config-k3s"
echo "  flux get kustomizations"
echo "  flux get helmreleases -A"
