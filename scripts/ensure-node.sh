#!/usr/bin/env bash
# ensure-node.sh — Verify Node.js and npm are installed on the host.
# If missing, install them using the platform's package manager.
# Idempotent: safe to re-run.
set -euo pipefail

c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }

# Minimum Node.js major version required by @anthropic-ai/claude-code.
MIN_NODE_MAJOR="${MIN_NODE_MAJOR:-20}"

have() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  have node || { echo 0; return; }
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0
}

install_macos() {
  if ! have brew; then
    c_red "    Homebrew not found. Install from https://brew.sh and re-run, or install Node manually."
    exit 1
  fi
  c_yellow "    installing node via Homebrew..."
  brew install node
}

install_linux() {
  local sudo_cmd=""
  if [ "$(id -u)" -ne 0 ]; then
    if have sudo; then sudo_cmd="sudo"; else
      c_red "    need root or sudo to install node."
      exit 1
    fi
  fi

  if have apt-get; then
    c_yellow "    installing node via apt-get (NodeSource ${MIN_NODE_MAJOR}.x)..."
    if ! have curl; then $sudo_cmd apt-get update -y && $sudo_cmd apt-get install -y curl; fi
    curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | $sudo_cmd -E bash -
    $sudo_cmd apt-get install -y nodejs
  elif have dnf; then
    c_yellow "    installing node via dnf (NodeSource ${MIN_NODE_MAJOR}.x)..."
    curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | $sudo_cmd bash -
    $sudo_cmd dnf install -y nodejs
  elif have yum; then
    c_yellow "    installing node via yum (NodeSource ${MIN_NODE_MAJOR}.x)..."
    curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | $sudo_cmd bash -
    $sudo_cmd yum install -y nodejs
  elif have pacman; then
    c_yellow "    installing node via pacman..."
    $sudo_cmd pacman -Sy --noconfirm nodejs npm
  elif have apk; then
    c_yellow "    installing node via apk..."
    $sudo_cmd apk add --no-cache nodejs npm
  else
    c_red "    no supported package manager found (apt/dnf/yum/pacman/apk). Install Node ${MIN_NODE_MAJOR}+ manually."
    exit 1
  fi
}

ensure_node() {
  local current
  current="$(node_major)"
  if have node && have npm && [ "$current" -ge "$MIN_NODE_MAJOR" ]; then
    c_green "    node:  $(node -v)"
    c_green "    npm:   $(npm -v)"
    return 0
  fi

  if have node && [ "$current" -lt "$MIN_NODE_MAJOR" ]; then
    c_yellow "    node $(node -v) < required v${MIN_NODE_MAJOR}. Upgrading..."
  else
    c_yellow "    node/npm not found. Installing..."
  fi

  case "$(uname -s)" in
    Darwin) install_macos ;;
    Linux)  install_linux ;;
    *)      c_red "    unsupported OS: $(uname -s). Install Node ${MIN_NODE_MAJOR}+ manually."; exit 1 ;;
  esac

  if ! have node || ! have npm; then
    c_red "    install completed but node/npm still not on PATH. Open a new shell or fix PATH and re-run."
    exit 1
  fi
  c_green "    installed node $(node -v), npm $(npm -v)"
}

c_blue "==> ensure node + npm (min v${MIN_NODE_MAJOR})"
ensure_node
