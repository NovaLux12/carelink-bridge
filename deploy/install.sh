#!/usr/bin/env bash
# install.sh — first-time deployment of carelink-bridge on a Linux host.
#
# Idempotent. Safe to re-run after a code update (it will npm ci +
# npm run build + restart the service).
#
# Prerequisites:
#   - Node.js >= 20 (the bridge's engines.node requirement)
#   - git
#   - systemd (this script sets up a user service)
#   - loginctl enable-linger $USER (so the service survives logout)
#
# What this script does:
#   1. Clones the repo into ~/carelink-bridge (or pulls if it exists)
#   2. Installs deps + builds TypeScript
#   3. Symlinks the systemd unit into ~/.config/systemd/user/
#   4. daemon-reload + enable (does NOT start — needs .env + logindata.json first)
#
# After running this, do:
#   1. cp deploy/systemd/carelink-bridge.env.example ~/carelink-bridge/.env
#   2. Edit ~/carelink-bridge/.env with your real credentials
#   3. chmod 600 ~/carelink-bridge/.env
#   4. cd ~/carelink-bridge && npm run login  (interactive OAuth flow)
#   5. systemctl --user start carelink-bridge

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/NovaLux12/carelink-bridge.git}"
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/carelink-bridge}"
SERVICE_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/systemd/carelink-bridge.service"
UNIT_NAME="carelink-bridge.service"

# Sanity checks.
command -v git >/dev/null || { echo "git not found"; exit 1; }
command -v node >/dev/null || { echo "node not found"; exit 1; }
command -v systemctl >/dev/null || { echo "systemd not found"; exit 1; }

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $NODE_MAJOR detected; bridge requires >= 20. Please upgrade."
  exit 1
fi

# Enable linger so the user service survives logout.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
  echo "Enabling linger for $USER (so the service survives logout)..."
  sudo loginctl enable-linger "$USER"
fi

# Clone or update.
if [ -d "$DEPLOY_DIR/.git" ]; then
  echo "Pulling latest in $DEPLOY_DIR..."
  (cd "$DEPLOY_DIR" && git pull --ff-only)
else
  echo "Cloning $REPO_URL -> $DEPLOY_DIR..."
  git clone "$REPO_URL" "$DEPLOY_DIR"
fi

# Install + build.
echo "Installing deps..."
(cd "$DEPLOY_DIR" && npm ci)

echo "Building..."
(cd "$DEPLOY_DIR" && npm run build)

# Install the systemd unit.
mkdir -p "$HOME/.config/systemd/user"
ln -sf "$SERVICE_SRC" "$HOME/.config/systemd/user/$UNIT_NAME"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME"

echo ""
echo "✓ Installed. Service is enabled (will auto-start on login)."
echo ""
echo "Next steps:"
echo "  1. cp $DEPLOY_DIR/deploy/systemd/carelink-bridge.env.example $DEPLOY_DIR/.env"
echo "  2. Edit $DEPLOY_DIR/.env with your real credentials"
echo "  3. chmod 600 $DEPLOY_DIR/.env"
echo "  4. cd $DEPLOY_DIR && npm run login  (interactive OAuth flow)"
echo "  5. systemctl --user start $UNIT_NAME"
echo "  6. systemctl --user status $UNIT_NAME  # verify it's running"
echo "  7. journalctl --user -u $UNIT_NAME -f  # tail logs"
