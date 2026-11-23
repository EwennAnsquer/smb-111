# Sauvegardes et restauration

Ce document décrit la politique de sauvegarde du cluster, l'export hors site
des snapshots etcd et les procédures de test de restauration. Une sauvegarde
non testée n'est pas une sauvegarde : le test trimestriel est obligatoire.

## Politique

| Donnée | Mécanisme | Fréquence | Rétention | Emplacement |
|---|---|---|---|---|
| Volumes Longhorn (lldap, Authelia, Grafana, VictoriaMetrics, Alertmanager, Loki, Redis Quinzo) | RecurringJob `daily-backup` (groupe `default`) | Tous les jours à 02:00 | 14 backups par volume (~2 semaines) | Cible S3 `s3://smb-111@us-east-1/` (MinIO), secret `minio-backup-secret` |
| etcd | `etcd-snapshot-schedule-cron` de K3s | Tous les jours à 03:00 | 14 snapshots par master | `/var/backups/k3s-etcd` sur chaque master |
| Snapshots etcd hors site | `rclone` (voir plus bas) | Après chaque snapshot | Politique du bucket MinIO | Bucket MinIO dédié |

Le RecurringJob `daily-backup` appartient au groupe `default` : Longhorn
l'applique automatiquement à tout volume qui n'a pas de `recurringJobSelector`
explicite. C'est le cas de tous les PVC applicatifs (StorageClass `longhorn`).

La rétention `retain: 14` ne concerne que les backups créés par ce job. Les
backups sont incrémentaux : chaque occurrence n'envoie que les blocs modifiés
depuis le backup précédent. La durée de vie côté MinIO (versioning, lifecycle,
réplication) doit être alignée sur cette politique.

Les snapshots etcd restent sur le disque racine des VM (30 Go, pas de disque
dédié) : ils protègent d'une erreur de manipulation ou d'un reset du datastore,
pas de la perte d'un nœud. **L'export hors site est la seule protection réelle.**

## Vérifications courantes

```bash
# Jobs et backups Longhorn
kubectl -n longhorn-system get recurringjob
kubectl -n longhorn-system get backups.longhorn.io
kubectl -n longhorn-system get volumes.longhorn.io -o json   # labels de groupe

# Dernier backup réussi par volume (métrique VictoriaMetrics)
kubectl -n monitoring-system port-forward svc/vmsingle-vm-stack 8428:8428 &
curl -s 'http://localhost:8428/api/v1/query?query=longhorn_volume_last_backup_at'

# Snapshots etcd sur un master
ssh root@<master> 'k3s etcd-snapshot list && ls -lh /var/backups/k3s-etcd'

# Intégrité d'un snapshot etcd (archive zip)
ssh root@<master> 'unzip -t /var/backups/k3s-etcd/<snapshot>.zip'
```

Alertes associées (groupe `smb-111.backups`) :

- `LonghornBackupFailed` : un Backup est passé en erreur (état 4) récemment.
- `LonghornBackupTooOld` : aucun backup réussi depuis plus de 26 h pour un
  volume (ou volume jamais sauvegardé).

## Export hors site des snapshots etcd

À exécuter sur chaque master. Les identifiants MinIO ne doivent **jamais** être
commités : le fichier `rclone` reste en `0600 root:root` sur la machine.

```bash
# 1. Installer rclone (Debian 13)
sudo apt-get update && sudo apt-get install -y rclone

# 2. Configurer le remote MinIO (interactif, une seule fois par master)
sudo rclone config
#   n) New remote
#   name> minio
#   Storage> s3
#   provider> Minio
#   env_auth> false
#   access_key_id> <clé>
#   secret_access_key> <secret>
#   endpoint> https://<hôte-minio>
sudo chmod 600 /root/.config/rclone/rclone.conf

# 3. Test manuel
sudo rclone sync /var/backups/k3s-etcd minio:<bucket>/etcd/$(hostname) \
  --include '*.zip' --verbose
```

Planification quotidienne (30 minutes après le snapshot K3s) :

```cron
# /etc/cron.d/k3s-etcd-offsite — root uniquement
30 3 * * * root rclone sync /var/backups/k3s-etcd minio:<bucket>/etcd/$(hostname) --include '*.zip' --log-file /var/log/rclone-etcd.log
```

Contrôles :

```bash
sudo tail -n 20 /var/log/rclone-etcd.log
sudo rclone lsf minio:<bucket>/etcd/$(hostname)/ | tail
```

En cas de perte d'un master, récupérer le snapshot depuis MinIO puis le placer
dans `/var/backups/k3s-etcd` avant la restauration.

## Test de restauration Longhorn

Objectif : prouver qu'un backup est lisible et contient les données attendues,
sans jamais toucher au PVC de production. Restaurer dans un volume **neuf**.

1. Choisir un volume peu critique pour le test (par exemple Grafana, 1 Gi).
2. Dans l'UI Longhorn (`https://longhorn.smb-111.azby.fr`) : **Backup** →
   sélectionner le dernier backup du volume → **Restore** → nommer le volume
   `restore-test-<volume>` → laisser l'option de restauration depuis le backup.
3. Attendre que le volume `restore-test-<volume>` soit créé et détaché
   (`State: detached`, `Robustness: healthy`).
4. Enregistrer le manifeste suivant dans `restore-test-grafana.yml` (adapter le
   nom et la taille à ceux du volume restauré), puis l'appliquer :

```yaml
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: restore-test-grafana
spec:
  capacity:
    storage: 1Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: longhorn
  csi:
    driver: driver.longhorn.io
    fsType: ext4
    volumeHandle: restore-test-grafana
    volumeAttributes:
      numberOfReplicas: "2"
      staleReplicaTimeout: "2880"
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: restore-test-grafana
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: longhorn
  volumeName: restore-test-grafana
  resources:
    requests:
      storage: 1Gi
```

5. Monter le volume dans un pod temporaire et vérifier les données :

```bash
kubectl apply -f restore-test-grafana.yml

kubectl run restore-test-grafana \
  --image=busybox:1.38.0 --restart=Never \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "restore-test-grafana",
        "image": "busybox:1.38.0",
        "command": ["sh", "-c", "ls -la /data && du -sh /data && sleep 300"],
        "volumeMounts": [{"name": "data", "mountPath": "/data"}]
      }],
      "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "restore-test-grafana"}}]
    }
  }'

kubectl logs restore-test-grafana
```

Vérifier au minimum la présence des fichiers attendus (`grafana.db` pour
Grafana, `auth.sqlite` pour Authelia, etc.) et une taille cohérente.

6. Nettoyage complet :

```bash
kubectl delete pod restore-test-grafana --ignore-not-found
kubectl delete pvc restore-test-grafana --ignore-not-found
kubectl delete pv restore-test-grafana --ignore-not-found
kubectl -n longhorn-system delete volumes.longhorn.io restore-test-grafana
```

Ne jamais restaurer directement sur le PVC de production : le backup crée un
nouveau volume, la bascule se fait ensuite en connaissance de cause.

## Test de restauration etcd

La restauration etcd est **destructive et cluster-wide**. Un test complet se fait
sur un cluster jetable (ou pendant un incident réel), jamais sur la production
sans raison. Le test trimestriel peut se limiter au contrôle d'intégrité.

1. Contrôle d'intégrité (non destructif) :

```bash
ssh root@<master> 'unzip -t /var/backups/k3s-etcd/<snapshot>.zip'
```

2. Restauration complète (procédure d'incident, détaillée dans l'en-tête de
   `ansible/upgrade-k3s.yml`) :

```bash
# Sur les 3 masters : arrêter K3s
sudo systemctl stop k3s

# Sur UN SEUL master : restaurer le snapshot (opération destructive)
sudo k3s server --cluster-reset \
  --cluster-reset-restore-path=/var/backups/k3s-etcd/<snapshot>
sudo systemctl start k3s

# Sur les autres masters : supprimer l'état etcd local, puis redémarrer
sudo rm -rf /var/lib/rancher/k3s/server/db
sudo systemctl start k3s
```

3. Vérifier la reprise :

```bash
kubectl get --raw /healthz
kubectl get --raw /healthz/etcd
kubectl get nodes
kubectl -n longhorn-system get pods
```

## Journal des tests

Consigner chaque test (date, environnement, volume/snapshot, résultat) :

| Date | Type | Cible | Résultat | Opérateur |
|---|---|---|---|---|
| | Longhorn | | | |
| | etcd | | | |
