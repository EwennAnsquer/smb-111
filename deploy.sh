#!/usr/bin/env bash

set -e

PROJECT_DIR=$(pwd)

# Nettoyage automatique des fichiers temporaires à la fin du script
TMP_VARS=$(mktemp --suffix=.tfvars.json)
TMP_ANSIBLE_VARS=$(mktemp --suffix=.yml)
trap 'rm -f "$TMP_VARS" "$TMP_ANSIBLE_VARS"' EXIT

# 1. Déploiement Terraform
cd "$PROJECT_DIR/terraform"
terraform init

sops -d secrets.enc.tfvars.json >"$TMP_VARS"
terraform apply -var-file="$TMP_VARS" -auto-approve

# On se place dans le dossier ansible en avance pour avoir accès à inventory.ini
cd "$PROJECT_DIR/ansible"

echo -e "\nRécupération dynamique des adresses IP depuis l'inventaire Ansible..."
# Extraction des IPs : on cherche "ansible_host=", on coupe la ligne et on garde juste l'IP
NODES=($(awk -F'ansible_host=' '/ansible_host=/ {split($2, a, " "); print a[1]}' inventory.ini))

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
echo -e "\nLancement du playbook Ansible..."
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt

sops -d vars/secrets.enc.yml >"$TMP_ANSIBLE_VARS"
ansible-playbook -i inventory.ini playbook.yml -e @"$TMP_ANSIBLE_VARS"
