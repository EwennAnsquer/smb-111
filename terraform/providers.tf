terraform {
  required_version = ">= 1.10.0"

  # Backend distant S3/MinIO en configuration partielle : le bucket, l'endpoint
  # et les options propres au fournisseur sont fournis par backend.hcl
  # (non versionné, voir backend.hcl.example). Les identifiants passent par
  # les variables d'environnement AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
  # Le verrouillage natif S3 évite une table DynamoDB (Terraform >= 1.10).
  backend "s3" {
    key          = "smb-111/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
  }

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "~> 0.123"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.9"
    }
  }
}

provider "proxmox" {
  endpoint  = var.proxmox_endpoint
  api_token = var.proxmox_api_token
  insecure  = false

  ssh {
    agent       = false
    username    = "root"
    private_key = file(var.ssh_private_key_path)
  }
}
