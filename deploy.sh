#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR=$(pwd)

# Clé age utilisée par SOPS (Terraform, Ansible et secret sops-age de Flux)
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"

if [ ! -f "$SOPS_AGE_KEY_FILE" ]; then
  echo "Erreur : clé age introuvable ($SOPS_AGE_KEY_FILE)."
  exit 1
fi

# Nettoyage automatique des fichiers temporaires à la fin du script
TMP_VARS=$(mktemp --suffix=.tfvars.json)
TMP_ANSIBLE_VARS=$(mktemp --suffix=.yml)
trap 'rm -f "$TMP_VARS" "$TMP_ANSIBLE_VARS"' EXIT

# 0. Flux synchronise depuis GitHub : tout doit être poussé avant le bootstrap
echo -e "Vérification que le dépôt est synchronisé avec GitHub..."
git -C "$PROJECT_DIR" fetch origin
if [ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]; then
  echo "Attention : des modifications locales ne sont pas commitées."
fi
if [ "$(git -C "$PROJECT_DIR" rev-parse HEAD)" != "$(git -C "$PROJECT_DIR" rev-parse '@{u}')" ]; then
  echo "Erreur : la branche locale n'est pas synchronisée avec origin (git push / git pull)."
  exit 1
fi

# 1. Déploiement Terraform
cd "$PROJECT_DIR/terraform"
terraform init

sops -d secrets.enc.tfvars.json >"$TMP_VARS"
terraform apply -var-file="$TMP_VARS" -auto-approve

# On se place dans le dossier ansible en avance pour avoir accès à inventory.ini
cd "$PROJECT_DIR/ansible"

echo -e "\nRécupération dynamique des adresses IP depuis l'inventaire Ansible..."
# Extraction des IPs : on cherche "ansible_host=", on coupe la ligne et on garde juste l'IP
mapfile -t NODES < <(awk -F'ansible_host=' '/ansible_host=/ {split($2, a, " "); print a[1]}' inventory.ini)

if [ ${#NODES[@]} -eq 0 ]; then
  echo "Erreur : Aucune adresse IP trouvée dans inventory.ini."
  exit 1
fi

echo -e "\nIPs trouvées : ${NODES[*]}"
echo -e "Attente de l'ouverture du port SSH sur toutes les VMs..."

# 2. Boucle dynamique d'attente SSH
for ip in "${NODES[@]}"; do
  until nc -z -w 2 "$ip" 22 &>/dev/null; do
    echo "En attente du service SSH sur $ip..."
    sleep 3
  done
  echo "Port SSH disponible sur $ip !"
done

# 3. Lancement d'Ansible
echo -e "\nPréparation des variables Ansible (secrets SOPS + clé age pour Flux)..."
sops -d group_vars/secrets.enc.yml >"$TMP_ANSIBLE_VARS"

# Injection de la clé age dans les variables (variable sops_age_key du playbook)
{
  printf '\nsops_age_key: |\n'
  sed 's/^/  /' "$SOPS_AGE_KEY_FILE"
} >>"$TMP_ANSIBLE_VARS"

if [ "${FRESH_INSTALL:-0}" = "1" ]; then
  FLUX_PATH="$PROJECT_DIR/flux/clusters/prod"
  if ls "$FLUX_PATH"/gotk-*.yaml >/dev/null 2>&1; then
    echo "Réinstallation : suppression des anciens gotk-* avant le bootstrap..."
    git -C "$PROJECT_DIR" rm -q "$FLUX_PATH"/gotk-*.yaml
    git -C "$PROJECT_DIR" commit -qm "Reset flux files before fresh bootstrap"
    git -C "$PROJECT_DIR" push
  fi
fi

echo -e "\nLancement du playbook Ansible..."
ansible-playbook -i inventory.ini playbook.yml -e @"$TMP_ANSIBLE_VARS"

# 4. Le bootstrap Flux a commité gotk-components.yaml et gotk-sync.yaml sur GitHub
echo -e "\nMise à jour du dépôt local (fichiers gotk-* générés par Flux)..."
git -C "$PROJECT_DIR" pull --ff-only

# 5. Aplatir : sortir les fichiers gotk-* du sous-dossier flux-system/
FLUX_PATH="$PROJECT_DIR/flux/clusters/prod" # doit correspondre à target_path dans vars/all.yml

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
