#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: scripts/test-codex-plugin-local.sh [--check]"
  echo ""
  echo "With no option, install the packed working tree into an isolated Codex home and launch Codex."
  echo "With --check, verify installation and hook discovery non-interactively and exit."
}

mode="launch"
if [[ ${1:-} == "--check" ]]; then
  mode="check"
elif [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  usage
  exit 0
elif [[ $# -ne 0 ]]; then
  usage >&2
  exit 2
fi

for required_command in codex node npm pnpm tar; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
project_root=$(cd -- "$script_directory/.." && pwd -P)
marketplace_root=$(mktemp -d /tmp/context-tree-codex-marketplace.XXXXXX)
codex_test_home=$(mktemp -d /tmp/context-tree-codex-home.XXXXXX)
smoke_project=$(mktemp -d /tmp/context-tree-codex-project.XXXXXX)

cleanup_directory() {
  case "$1" in
    /tmp/context-tree-codex-marketplace.* | /tmp/context-tree-codex-home.* | /tmp/context-tree-codex-project.*)
      rm -rf -- "$1"
      ;;
    *)
      echo "Refusing to remove unexpected temporary path: $1" >&2
      ;;
  esac
}

cleanup() {
  cleanup_directory "$marketplace_root"
  cleanup_directory "$codex_test_home"
  cleanup_directory "$smoke_project"
}
trap cleanup EXIT

echo "Building Context Tree..."
pnpm --dir "$project_root" build

echo "Packing the working tree..."
(
  cd -- "$project_root"
  npm_config_cache="$marketplace_root/npm-cache" \
    npm pack --silent --ignore-scripts --pack-destination "$marketplace_root" >/dev/null
)

tarballs=("$marketplace_root"/*.tgz)
if [[ ${#tarballs[@]} -ne 1 || ! -f ${tarballs[0]} ]]; then
  echo "Expected npm pack to create exactly one tarball." >&2
  exit 1
fi

plugin_root="$marketplace_root/plugins/context-tree"
mkdir -p "$plugin_root" "$marketplace_root/.agents/plugins"
tar -xzf "${tarballs[0]}" -C "$plugin_root" --strip-components=1

cat >"$marketplace_root/.agents/plugins/marketplace.json" <<'JSON'
{
  "name": "context-tree-local",
  "interface": {
    "displayName": "Context Tree Local"
  },
  "plugins": [
    {
      "name": "context-tree",
      "source": {
        "source": "local",
        "path": "./plugins/context-tree"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Developer Tools"
    }
  ]
}
JSON

echo "Installing the temporary marketplace and plugin..."
CODEX_HOME="$codex_test_home" codex plugin marketplace add "$marketplace_root"
CODEX_HOME="$codex_test_home" codex plugin add context-tree@context-tree-local

echo ""
echo "Installed plugins:"
CODEX_HOME="$codex_test_home" codex plugin list

if [[ $mode == "check" ]]; then
  node "$script_directory/check-codex-plugin-hooks.mjs" \
    "$codex_test_home" \
    "$smoke_project" \
    "$marketplace_root/.agents/plugins/marketplace.json"
  echo ""
  echo "Local Codex plugin installation and hook-discovery smoke test passed."
  exit 0
fi

echo ""
echo "Starting Codex in an unconnected temporary project."
echo 'Try: Use $context-tree-read for this project with agent_slug engineer.'
echo "Exit Codex to remove the temporary marketplace, plugin, Codex home, and project."
echo ""

cd -- "$smoke_project"
CODEX_HOME="$codex_test_home" codex
