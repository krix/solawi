#!/bin/bash

# --- Linux Mint 22 (Wilma) / Ubuntu 24.04 (Noble) Build Script for SoLaWi App ---
# This script installs all necessary dependencies and builds the Tauri application.

set -e

echo ""
echo "========================================="
echo "  AckerApp – Linux Build v1.1.0"
echo "========================================="
echo ""

# 1. System-Abhängigkeiten installieren
echo "[1/6] Installiere System-Bibliotheken (GTK, WebKit, etc.)..."
sudo apt update
sudo apt install -y \
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libsoup-3.0-dev \
    libjavascriptcoregtk-4.1-dev \
    ca-certificates \
    gnupg

# 2. Node.js 22 LTS über NodeSource installieren (distro-Pakete sind zu alt)
REQUIRED_NODE_MAJOR=22
install_node() {
    echo "[2/6] Installiere Node.js $REQUIRED_NODE_MAJOR LTS via NodeSource..."
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$REQUIRED_NODE_MAJOR.x nodistro main" \
        | sudo tee /etc/apt/sources.list.d/nodesource.list > /dev/null
    sudo apt update
    sudo apt install -y nodejs
}

if command -v node &> /dev/null; then
    CURRENT_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$CURRENT_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
        echo "  Node.js $(node -v) ist zu alt (benötigt >= $REQUIRED_NODE_MAJOR)."
        install_node
    else
        echo "[2/6] Node.js $(node -v) ist bereits installiert."
    fi
else
    install_node
fi

echo "  Node: $(node -v)  npm: $(npm -v)"

# 3. Rust installieren (falls nicht vorhanden)
if ! command -v rustc &> /dev/null; then
    echo "[3/6] Installiere Rust (rustup)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    # shellcheck source=/dev/null
    source "$HOME/.cargo/env"
else
    echo "[3/6] Rust ist bereits installiert: $(rustc --version)"
    # Stelle sicher, dass cargo im PATH ist
    if [ -f "$HOME/.cargo/env" ]; then
        # shellcheck source=/dev/null
        source "$HOME/.cargo/env"
    fi
fi

# 4. Node-Abhängigkeiten installieren
echo "[4/6] Installiere Node-Abhängigkeiten..."
# Lösche node_modules bei Plattformwechsel (Windows → Linux)
if [ -d "node_modules" ]; then
    echo "  Entferne vorhandene node_modules (Plattformwechsel)..."
    rm -rf node_modules
fi
if [ -f "package-lock.json" ]; then
    # Deterministische Installation aus dem Lockfile
    npm ci
else
    npm install
fi

# --- Tauri Versions-Abgleich (verhindert "version mismatched Tauri packages") ---
# Die Rust-Seite ist über Cargo.lock fest (z. B. tauri 2.10.3). Die JS-Pakete
# muessen denselben Major/Minor haben. Wir lesen den Rust-Minor direkt aus
# Cargo.lock und erzwingen exakt diesen Minor fuer die @tauri-apps/* Pakete.
echo "  Gleiche Tauri-JS-Versionen an die Rust-Crates an..."
# CRLF-sicher (falls Cargo.lock mit Windows-Zeilenenden eingecheckt wurde):
RUST_TAURI_VERSION=$(awk '{sub(/\r$/,"")} $0=="name = \"tauri\""{f=1;next} f&&/^version = /{gsub(/[",]/,"",$3);print $3;exit}' src-tauri/Cargo.lock)
if [ -z "$RUST_TAURI_VERSION" ]; then
    echo "  WARNUNG: Konnte tauri-Version nicht aus Cargo.lock lesen. Nutze Fallback 2.11."
    TAURI_MINOR="2.11"
else
    TAURI_MINOR=$(echo "$RUST_TAURI_VERSION" | cut -d. -f1,2)
    echo "  Rust-Crate 'tauri' = $RUST_TAURI_VERSION  -> Ziel-Minor fuer JS: $TAURI_MINOR"
fi

# Erzwinge exakt den passenden Minor (npm waehlt den neuesten passenden Patch).
npm install --save-exact "@tauri-apps/api@~${TAURI_MINOR}.0" "@tauri-apps/cli@~${TAURI_MINOR}.0"

# --- Verifikation VOR dem Build ---
JS_API_VERSION=$(node -p "require('@tauri-apps/api/package.json').version" 2>/dev/null || echo "unbekannt")
JS_API_MINOR=$(echo "$JS_API_VERSION" | cut -d. -f1,2)
echo "  Installiert: @tauri-apps/api = $JS_API_VERSION (Minor $JS_API_MINOR)"
if [ "$JS_API_MINOR" != "$TAURI_MINOR" ]; then
    echo ""
    echo "  FEHLER: Tauri-Versionen passen nicht zusammen!"
    echo "    Rust  tauri            : $RUST_TAURI_VERSION (Minor $TAURI_MINOR)"
    echo "    JS    @tauri-apps/api  : $JS_API_VERSION (Minor $JS_API_MINOR)"
    echo "  Bitte 'node_modules' und 'package-lock.json' loeschen und Skript erneut ausfuehren."
    exit 1
fi
echo "  OK: Tauri JS ($JS_API_MINOR) passt zu Rust ($TAURI_MINOR)."

# 5. Frontend bauen
echo "[5/6] Baue das Frontend..."
npm run build

# 6. Tauri-Bundle bauen
echo "[6/6] Baue das Tauri-Bundle (.deb & .AppImage)..."
npm run tauri build

echo ""
echo "========================================="
echo "  Build abgeschlossen!"
echo "========================================="
echo ""
echo "Pakete findest du hier:"
echo "  src-tauri/target/release/bundle/deb/"
echo "  src-tauri/target/release/bundle/appimage/"
echo ""
echo "Die .deb Datei kannst du mit Doppelklick installieren."
echo ""
