#!/usr/bin/env bash
set -euo pipefail

# Copy SSH keys from read-only host mount into user's home with strict perms.
# Host mount is at /tmp/host-ssh (read-only); we need writable, 0600/0700 perms.
if [ -d /tmp/host-ssh ]; then
  mkdir -p "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  # Copy keys, configs, known_hosts (skip sockets/agents).
  for f in id_rsa id_rsa.pub id_ed25519 id_ed25519.pub id_ecdsa id_ecdsa.pub config known_hosts; do
    if [ -f "/tmp/host-ssh/$f" ]; then
      cp "/tmp/host-ssh/$f" "$HOME/.ssh/$f"
      case "$f" in
        *.pub|known_hosts|config) chmod 644 "$HOME/.ssh/$f" ;;
        *)                        chmod 600 "$HOME/.ssh/$f" ;;
      esac
    fi
  done
fi

# Pre-populate known_hosts for github.com if missing (avoids interactive prompt).
if [ ! -f "$HOME/.ssh/known_hosts" ] || ! grep -q "github.com" "$HOME/.ssh/known_hosts" 2>/dev/null; then
  ssh-keyscan -t rsa,ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
  chmod 644 "$HOME/.ssh/known_hosts" 2>/dev/null || true
fi

# Restore Claude Code's project-state file (~/.claude.json) from latest backup
# if missing. Claude Code creates that file at $HOME, not inside .claude/, and
# our writable layer drops it on container recreate. The .claude/backups/ dir
# IS mounted, so backups accumulate on host across runs.
if [ ! -f "$HOME/.claude.json" ]; then
  LATEST_BACKUP=$(ls -t "$HOME/.claude/backups/.claude.json.backup."* 2>/dev/null | head -1 || true)
  if [ -n "$LATEST_BACKUP" ]; then
    cp "$LATEST_BACKUP" "$HOME/.claude.json"
    chmod 600 "$HOME/.claude.json"
  fi
fi

# Auto-install claude-mem hooks on first boot.
# Detection: settings.json mentions claude-mem. Skipped on subsequent boots.
SETTINGS="$HOME/.claude/settings.json"
if ! grep -q "claude-mem" "$SETTINGS" 2>/dev/null; then
  if command -v claude-mem >/dev/null 2>&1; then
    echo "[entrypoint] running claude-mem install..."
    claude-mem install 2>&1 || echo "[entrypoint] claude-mem install failed (non-fatal — run manually after 'claude login')"
  fi
fi

exec "$@"
