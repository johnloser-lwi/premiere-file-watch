#!/bin/bash
# File Watch — Dev Setup Script (macOS)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
LINK_PATH="$EXTENSIONS_DIR/FileWatch"

# Enable unsigned CEP extensions
echo "[1/2] Enabling unsigned extension support..."
for ver in CSXS.10 CSXS.11 CSXS.12; do
    defaults write "com.adobe.$ver" PlayerDebugMode 1
done
echo "   Done."

# Create extensions directory if needed
mkdir -p "$EXTENSIONS_DIR"

# Create symlink
echo "[2/2] Creating symlink..."
echo "   Link:   $LINK_PATH"
echo "   Source: $SCRIPT_DIR"

if [ -e "$LINK_PATH" ] || [ -L "$LINK_PATH" ]; then
    echo "   Removing existing link/folder..."
    rm -rf "$LINK_PATH"
fi

ln -s "$SCRIPT_DIR" "$LINK_PATH"

if [ -L "$LINK_PATH" ]; then
    echo "   Symlink created successfully."
    echo ""
    echo "   Restart Premiere Pro, then open:"
    echo "   Window > Extensions > File Watch"
else
    echo "   ERROR: Failed to create symlink." >&2
    exit 1
fi
