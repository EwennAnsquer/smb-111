variable "proxmox_endpoint" { type = string }
variable "proxmox_node_name" { type = string }
variable "gateway" { type = string }

variable "proxmox_api_token" {
  type      = string
  sensitive = true
}

variable "ssh_private_key_path" {
  type    = string
  default = "~/.ssh/smb-111"
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/smb-111.pub"
}

variable "masters" {
  description = "Dictionnaire des nœuds maîtres (30 Go et 5 Go de RAM chacun : surveiller l'espace pour Longhorn, le monitoring et les logs)"
  type        = map(object({ id = number, ip = string, ram = number, cores = number, size = number }))
}

variable "workers" {
  description = "Dictionnaire des nœuds workers (30 Go et 4 Go de RAM chacun : surveiller l'espace pour Longhorn, le monitoring et les logs)"
  type        = map(object({ id = number, ip = string, ram = number, cores = number, size = number }))
}

variable "master_datastore" {
  description = "Datastore Proxmox des disques des masters (local-lvm recommandé)"
  type        = string
  default     = "local-lvm"
}

variable "worker_datastore" {
  description = "Datastore Proxmox des disques des workers. Le NFS est conservé faute de stockage local suffisant : Longhorn écrit ses réplicas dans /var/lib/longhorn, ce qui ajoute la latence NFS et rend le stockage distribué dépendant du serveur NFS. Prévoir local-lvm lors d'un rebuild si le stockage local le permet."
  type        = string
  default     = "nfs-smb-111"
}

variable "cloudinit_datastore" {
  description = "Datastore Proxmox des disques cloud-init (local-lvm recommandé)"
  type        = string
  default     = "local-lvm"
}
