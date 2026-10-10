#!/usr/bin/env bash
set -euo pipefail

# Non-destructive backup of T3 Code userdata and state
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${HOME}/.t3/userdata/backups/${TIMESTAMP}"

mkdir -p "${BACKUP_DIR}"

echo "Creating non-destructive backup in ${BACKUP_DIR}..."

# 1. Backup goals.json
if [[ -f "${HOME}/.t3/userdata/goals.json" ]]; then
  cp -a "${HOME}/.t3/userdata/goals.json" "${BACKUP_DIR}/goals.json"
  echo "✓ goals.json backed up"
fi

# 2. Backup state.sqlite safely using SQLite backup API
if [[ -f "${HOME}/.t3/userdata/state.sqlite" ]]; then
  sqlite3 "${HOME}/.t3/userdata/state.sqlite" ".backup '${BACKUP_DIR}/state.sqlite'"
  echo "✓ state.sqlite backed up"
fi

# 3. Backup service-state.json
if [[ -f "${HOME}/.t3/runtime/service-state.json" ]]; then
  cp -a "${HOME}/.t3/runtime/service-state.json" "${BACKUP_DIR}/service-state.json"
  echo "✓ service-state.json backed up"
fi

# 4. Snapshot git refs of t3code
if git rev-parse --git-dir > /dev/null 2>&1; then
  git show-ref > "${BACKUP_DIR}/git-refs.txt" || true
  git worktree list > "${BACKUP_DIR}/git-worktrees.txt" || true
  echo "✓ git metadata backed up"
fi

echo "Backup completed successfully at ${BACKUP_DIR}"
