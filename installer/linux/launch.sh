#!/bin/sh
set -eu
launcher_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -m)" in
  x86_64|amd64) architecture=x64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) printf '%s\n' 'Velron Installer supports x64 and ARM64.' >&2; exit 1 ;;
esac
exec "$launcher_dir/$architecture/velron-installer" "$@"
