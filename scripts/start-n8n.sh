#!/usr/bin/env bash
# Starts SheetOps' own n8n instance. It keeps its database and encryption key
# in var/n8n (gitignored), never in LeadIntel's folder or ~/.n8n. Stop
# LeadIntel's n8n first: both at once would compete for this laptop's memory.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export N8N_USER_FOLDER="$ROOT/var/n8n"
export N8N_PORT=5680                       # LeadIntel uses n8n's default, 5678
export N8N_RUNNERS_BROKER_PORT=5699        # task-runner port, away from the default
export N8N_CONCURRENCY_PRODUCTION_LIMIT=1  # scheduled runs queue instead of overlapping
export EXECUTIONS_TIMEOUT=300              # hard stop for one run, in seconds
export GENERIC_TIMEZONE=Africa/Addis_Ababa
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
export N8N_TEMPLATES_ENABLED=false

mkdir -p "$N8N_USER_FOLDER"
echo "SheetOps n8n: http://localhost:$N8N_PORT  (data in var/n8n)"
exec n8n start
