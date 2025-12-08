#!/bin/bash
# Setup trader user on the droplet
# Run this once as root: ssh root@goodtraderbot.com 'bash -s' < scripts/setup-user.sh

set -e

echo "Creating trader user..."

# Create user if doesn't exist
if ! id -u trader &>/dev/null; then
    useradd -m -s /bin/bash trader
    echo "Created trader user"
else
    echo "trader user already exists"
fi

# Add trader to systemd-journal group for logging access
usermod -aG systemd-journal trader

# Set up SSH key for git operations (copy root's)
mkdir -p /home/trader/.ssh
cp /root/.ssh/id_* /home/trader/.ssh/ 2>/dev/null || true
cp /root/.ssh/known_hosts /home/trader/.ssh/ 2>/dev/null || true
chown -R trader:trader /home/trader/.ssh
chmod 700 /home/trader/.ssh
chmod 600 /home/trader/.ssh/id_* 2>/dev/null || true

# Configure git for trader user
su - trader -c 'git config --global user.email "bot@goodtraderbot.com"'
su - trader -c 'git config --global user.name "Trader Bot"'
su - trader -c 'git config --global --add safe.directory /opt/trader'

# Transfer ownership of /opt/trader to trader
chown -R trader:trader /opt/trader

# Give trader user ability to manage its own systemd services (lingering)
loginctl enable-linger trader

# Install Claude Code for trader user
echo "Installing Claude Code for trader user..."
su - trader -c 'curl -fsSL https://claude.ai/install.sh | sh' || echo "Claude install may need manual intervention"

# Create Claude config directory
mkdir -p /home/trader/.config/claude
chown -R trader:trader /home/trader/.config

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "1. Copy the ANTHROPIC_API_KEY to /home/trader/.config/claude/settings.json"
echo "2. Test: su - trader -c 'cd /opt/trader && claude --version'"
echo "3. Redeploy: npm run deploy"
