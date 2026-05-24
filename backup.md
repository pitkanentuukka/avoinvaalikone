# Database Backup

Three-tier daily backups: local rotation on the server, UpCloud Object Storage (same region), and Backblaze B2 (offsite).

- **Local:** 7 days on disk at `/opt/vaalikone/backups/`
- **UpCloud Object Storage:** 30-day lifecycle, bucket `vaalikone-backups`
- **Backblaze B2:** 30-day lifecycle, bucket `vaalikone-backups`

Backups run at 03:00 server time via cron. The script exits non-zero if either cloud upload fails; check `/var/log/vaalikone-backup.log`.

---

## One-time setup

### 1. Install rclone

```bash
curl https://rclone.org/install.sh | sudo bash
```

### 2. UpCloud Object Storage

1. UpCloud control panel → **Object Storage** → create bucket `vaalikone-backups`, zone `fi-hel2`
2. Create access keys (note access key ID and secret)
3. Configure rclone:

```bash
rclone config create upcloud-os s3 \
  provider Other \
  access_key_id YOUR_UPCLOUD_ACCESS_KEY \
  secret_access_key YOUR_UPCLOUD_SECRET \
  endpoint objectstorage.fi-hel2.upcloudobjects.com \
  acl private
```

4. Set a 30-day lifecycle rule on the bucket (UpCloud control panel → bucket → Lifecycle).

### 3. Backblaze B2

1. [backblaze.com](https://www.backblaze.com) → **Buckets** → create `vaalikone-backups` (private)
2. **App Keys** → create a key with read+write access to that bucket
3. Configure rclone:

```bash
rclone config create b2 b2 \
  account YOUR_B2_ACCOUNT_ID \
  key YOUR_B2_APP_KEY
```

4. Bucket → **Lifecycle Rules** → delete files older than 30 days.

### 4. Install the cron job

```bash
chmod +x /opt/vaalikone/scripts/backup.sh

cat > /etc/cron.d/vaalikone-backup <<'EOF'
0 3 * * * root /opt/vaalikone/scripts/backup.sh >> /var/log/vaalikone-backup.log 2>&1
EOF
```

### 5. Test

```bash
/opt/vaalikone/scripts/backup.sh
rclone ls upcloud-os:vaalikone-backups/
rclone ls b2:vaalikone-backups/
```

---

## Daily usage

**Check recent backup log:**
```bash
tail -50 /var/log/vaalikone-backup.log
```

**List local backups:**
```bash
ls -lh /opt/vaalikone/backups/
```

**List cloud backups:**
```bash
rclone ls upcloud-os:vaalikone-backups/
rclone ls b2:vaalikone-backups/
```

**Run a manual backup:**
```bash
/opt/vaalikone/scripts/backup.sh
```

---

## Restore

### From a local backup

```bash
/opt/vaalikone/scripts/restore.sh /opt/vaalikone/backups/vaalikone_2026-05-24_030001.sql.gz
```

### From a cloud backup

Fetch the file first, then restore:

```bash
# List available backups
rclone ls upcloud-os:vaalikone-backups/

# Download
rclone copy upcloud-os:vaalikone-backups/vaalikone_2026-05-24_030001.sql.gz /opt/vaalikone/backups/

# Restore
/opt/vaalikone/scripts/restore.sh /opt/vaalikone/backups/vaalikone_2026-05-24_030001.sql.gz
```

If UpCloud is unavailable, substitute `b2:vaalikone-backups/` for the B2 copy.

### What restore.sh does

1. Stops the backend container (to release DB connections)
2. Drops and recreates the `vaalikone` database
3. Pipes the decompressed dump into `psql`
4. Restarts the backend

The script prompts for confirmation before making any changes.
