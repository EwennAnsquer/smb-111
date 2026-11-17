locals {
  # L'image téléchargée est un qcow2, mais Proxmox la convertit en raw à
  # l'import : raw est plus performant sur LVM et évite une couche de
  # conversion supplémentaire. Le format est donc uniforme pour tous les nœuds.
  all_nodes = merge(
    { for k, v in var.masters : k => merge(v, {
      datastore   = var.master_datastore
      file_format = "raw"
    }) },
    { for k, v in var.workers : k => merge(v, {
      datastore   = var.worker_datastore
      file_format = "raw"
    }) },
  )
}

resource "proxmox_download_file" "debian_cloud_image" {
  content_type = "iso"
  datastore_id = "local"
  node_name    = var.proxmox_node_name
  url          = "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"
  file_name    = "debian-13-genericcloud-amd64.img"

  # Empreinte officielle publiée dans SHA512SUMS (Debian ne fournit pas de
  # SHA256SUMS pour ses images cloud). À mettre à jour si Debian republie
  # l'image "latest", sinon le téléchargement échouera volontairement.
  checksum           = "37cb32b320820417eb04b335afcf489bfb4cecce4a957190d09cb2bffbe02b56a1cadd62d78c6ead92aa7839d5ea65e4260f994bbb4b54490df59fdf11ee1d97"
  checksum_algorithm = "sha512"
}

resource "proxmox_virtual_environment_vm" "k3s_nodes" {
  for_each  = local.all_nodes
  name      = each.key
  node_name = var.proxmox_node_name
  vm_id     = each.value.id

  cpu {
    cores = each.value.cores
    type  = "host"
  }

  memory {
    dedicated = each.value.ram
  }

  disk {
    datastore_id = each.value.datastore
    file_id      = proxmox_download_file.debian_cloud_image.id
    file_format  = each.value.file_format
    interface    = "scsi0"
    size         = each.value.size
  }

  network_device {
    bridge = "vmbr0"
  }

  initialization {
    datastore_id = var.cloudinit_datastore

    ip_config {
      ipv4 {
        address = "${each.value.ip}/24"
        gateway = var.gateway
      }
    }
    user_account {
      username = "debian"
      keys     = [file(var.ssh_public_key_path)]
    }
  }
}

resource "local_file" "ansible_inventory" {
  filename = "${path.module}/../ansible/inventory.ini"
  content  = <<-EOF
  [masters]
  %{for name, node in var.masters~}
  ${name} ansible_host=${node.ip} ansible_user=debian
  %{endfor~}

  [workers]
  %{for name, node in var.workers~}
  ${name} ansible_host=${node.ip} ansible_user=debian
  %{endfor~}

  [k3s_cluster:children]
  masters
  workers

  [k3s_cluster:vars]
  ansible_ssh_private_key_file=${var.ssh_private_key_path}
  EOF
}
