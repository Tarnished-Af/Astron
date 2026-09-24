#!/usr/bin/env bash
# Makes a dated backup of all notes, accounts and settings in /home/ubuntu.
set -euo pipefail
F=/home/ubuntu/astron-backup-$(date +%Y-%m-%d).tar.gz
sqlite3 /var/lib/astron/astron.db ".backup /var/lib/astron/backup.db" 2>/dev/null || cp /var/lib/astron/astron.db /var/lib/astron/backup.db
tar -czf "$F" -C /var/lib/astron backup.db files
rm -f /var/lib/astron/backup.db
echo "Backup saved: $F ($(du -h "$F" | cut -f1))"
