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
  description = "Dictionnaire des nœuds maîtres"
  type = map(object({ id = number, ip = string, ram = number, cores = number }))
}

variable "workers" {
  description = "Dictionnaire des nœuds workers"
  type = map(object({ id = number, ip = string, ram = number, cores = number }))
}
