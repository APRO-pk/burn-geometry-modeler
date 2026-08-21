#!/usr/bin/env bash
# Build the burn-core Rust crate to WebAssembly.
#
# Run this from WSL2 (or any Linux/macOS shell). It must NOT be run from a
# Windows shell on this machine: Smart App Control blocks execution of freshly
# compiled Rust build scripts (os error 4551), which stops cargo before it
# starts. See the Step-3B notes in the commit history.
#
#   wsl
#   cd /mnt/c/Users/laiba/Downloads/burn-geometry-modeler
#   bash scripts/build-wasm.sh
#
# Produces two wasm-pack outputs, both committed so that `npm run build` and
# `npm run test` work without a Rust toolchain present:
#   crates/burn-core/pkg-node  (target nodejs) -> Vitest parity tests
#   crates/burn-core/pkg-web   (target web)    -> the browser Web Worker
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE_DIR="$REPO_ROOT/crates/burn-core"

if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
  echo "ERROR: this is a Windows shell. Smart App Control will block the Rust" >&2
  echo "       build scripts here. Run it from WSL instead:" >&2
  echo "         wsl" >&2
  echo "         cd /mnt/c/Users/laiba/Downloads/burn-geometry-modeler" >&2
  echo "         bash scripts/build-wasm.sh" >&2
  exit 1
fi

# ---- toolchain ----
if ! command -v rustup >/dev/null 2>&1; then
  echo "==> Installing Rust (rustup, minimal profile)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
fi
# shellcheck disable=SC1090
source "$HOME/.cargo/env"

echo "==> rustc $(rustc --version)"
rustup target add wasm32-unknown-unknown

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "==> Installing wasm-pack"
  curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
fi
echo "==> wasm-pack $(wasm-pack --version)"

cd "$CRATE_DIR"

# wasm-pack warns on every build when Cargo.toml declares a license but the
# crate directory has no LICENSE file. Copy the repo one in rather than keeping
# a second copy under version control, where the two could drift apart.
# .gitignore excludes the copy.
cp -f "$REPO_ROOT/LICENSE" "$CRATE_DIR/LICENSE"

# Building straight onto /mnt/c is slow (9p filesystem) and can trip permission
# oddities, so build into a Linux-native target dir and only write the finished
# package back to the repo.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/burn-core-target}"
mkdir -p "$CARGO_TARGET_DIR"

echo "==> wasm-pack build (nodejs target) -> pkg-node"
wasm-pack build --release --target nodejs --out-dir pkg-node --out-name burn_core

echo "==> wasm-pack build (web target) -> pkg-web"
wasm-pack build --release --target web --out-dir pkg-web --out-name burn_core

# wasm-pack drops a `.gitignore` containing `*` into each out-dir, which would
# hide the artifacts we specifically want committed. Remove it every build.
rm -f pkg-node/.gitignore pkg-web/.gitignore

echo
echo "Done. Artifacts:"
ls -la pkg-node/*.wasm pkg-node/*.js pkg-web/*.wasm pkg-web/*.js 2>/dev/null || true
echo
echo "Next: npm run test   (parity suite runs against pkg-node)"
