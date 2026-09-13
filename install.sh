#!/usr/bin/env sh
set -eu

# Installer source/releases live in velronInstaller; application payloads stay here.
REPOSITORY="CodingManFocus/velronRelease"
LATEST_BASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
DEFAULT_HTTP_PORT="4141"
DEFAULT_VCP_PORT="4143"
NON_INTERACTIVE=false

case "${1:-}" in
  --help|-h)
    printf '%s\n' 'Usage: sh install.sh' \
      'Interactive Velron Server and stdio MCP Client installer for Linux and macOS.' \
      'Choose Codex, Claude Code, or another stdio MCP host.' \
      'Pass an absolute workspaceDir to call_agent when using workspace tools.'
    exit 0
    ;;
  --non-interactive) NON_INTERACTIVE=true ;;
  '') ;;
  *) printf '%s\n' "Unknown option: $1" >&2; exit 2 ;;
esac

if [ "$NON_INTERACTIVE" = true ]; then
  TTY=/dev/null
elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
  TTY=/dev/tty
else
  printf '%s\n' "Velron installer requires an interactive terminal." >&2
  exit 1
fi

if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  BLUE='\033[1;34m'
  GREEN='\033[1;32m'
  YELLOW='\033[1;33m'
  RED='\033[1;31m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  BLUE=''
  GREEN=''
  YELLOW=''
  RED=''
  BOLD=''
  RESET=''
fi

say() { printf '%b\n' "$*"; }
info() { say "${BLUE}i${RESET} $*"; }
success() { say "${GREEN}✓${RESET} $*"; }
warn() { say "${YELLOW}!${RESET} $*"; }
die() { say "${RED}Error:${RESET} $*" >&2; exit 1; }
stage() { [ "$NON_INTERACTIVE" = false ] || printf 'VELRON_INSTALL_STAGE:%s\n' "$1"; }

# The desktop UI supplies data through the child environment, never shell source.
read_gui_settings() {
  INSTALL_SERVER=false
  INSTALL_CLIENT=false
  case "${VELRON_INSTALL_COMPONENTS:-}" in
    both) INSTALL_SERVER=true; INSTALL_CLIENT=true ;;
    server) INSTALL_SERVER=true ;;
    client) INSTALL_CLIENT=true ;;
    *) die "Choose Server, Client, or both." ;;
  esac
  VELRON_HOME_PATH=$(absolute_path "${VELRON_INSTALL_HOME:?Missing Velron directory}")
  COMMAND_DIR=$(absolute_path "${VELRON_INSTALL_COMMAND_DIR:?Missing command directory}")
  RUNTIME_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/velron/bin"
  SERVER_ENV_PATH="$VELRON_HOME_PATH/server.env"
  CLIENT_ENV_PATH="$VELRON_HOME_PATH/client.env"
  SERVER_HOST=${VELRON_INSTALL_SERVER_HOST:-127.0.0.1}
  SERVER_HTTP_PORT=${VELRON_INSTALL_HTTP_PORT:-4141}
  SERVER_VCP_PORT=${VELRON_INSTALL_VCP_PORT:-4143}
  SERVER_ALLOWED_HOSTS=${VELRON_INSTALL_ALLOWED_HOSTS:-}
  ENABLE_AUTOSTART=${VELRON_INSTALL_AUTOSTART:-false}
  START_SERVER_NOW=${VELRON_INSTALL_START_NOW:-false}
  keep_config=${VELRON_INSTALL_KEEP_CONFIG:-true}
  for flag in "$ENABLE_AUTOSTART" "$START_SERVER_NOW" "$keep_config"; do
    case "$flag" in true|false) ;; *) die "Invalid boolean installation setting." ;; esac
  done
  WRITE_SERVER_CONFIG=true
  if [ "$keep_config" = true ] && [ -f "$VELRON_HOME_PATH/config.json" ]; then
    WRITE_SERVER_CONFIG=false
  fi
  valid_host "$SERVER_HOST" bind || die "Invalid server bind host."
  valid_port "$SERVER_HTTP_PORT" || die "Invalid HTTP port."
  valid_port "$SERVER_VCP_PORT" || die "Invalid VCP port."
  [ "$SERVER_HTTP_PORT" != "$SERVER_VCP_PORT" ] || die "HTTP and VCP ports must differ."
  allowed_hosts_json "$SERVER_ALLOWED_HOSTS" >/dev/null
  VCP_MODE=${VELRON_INSTALL_CONNECTION:-local}
  VCP_URL="wss://127.0.0.1:$SERVER_VCP_PORT/vcp/v1"
  VCP_TOKEN=''
  case "$VCP_MODE" in
    local) ;;
    remote)
      VCP_URL=${VELRON_INSTALL_VCP_URL:-}
      VCP_TOKEN=${VELRON_INSTALL_VCP_TOKEN:-}
      case "$VCP_URL" in wss://*) ;; *) die "Remote VCP URL must use wss://." ;; esac
      case "$VCP_URL" in *'?'*|*'#'*|wss://*@*) die "Invalid VCP URL." ;; esac
      vcp_remainder=${VCP_URL#wss://}
      vcp_authority=${vcp_remainder%%/*}
      vcp_path=/${vcp_remainder#*/}
      if [ -z "$vcp_authority" ] || [ "$vcp_authority" = "$vcp_remainder" ] || [ "$vcp_path" != /vcp/v1 ]; then
        die "Remote VCP URL must target exactly /vcp/v1."
      fi
      case "$VCP_TOKEN" in *[!A-Za-z0-9_-]*|'') die "Invalid VCP token." ;; esac
      [ "${#VCP_TOKEN}" -eq 43 ] || die "VCP token must be exactly 43 characters."
      ;;
    *) die "Invalid connection mode." ;;
  esac
  case "${VELRON_INSTALL_INTEGRATION:-}" in
    codex) INTEGRATION_CHOICE=1 ;;
    claude) INTEGRATION_CHOICE=2 ;;
    both) INTEGRATION_CHOICE=3 ;;
    other) INTEGRATION_CHOICE=4 ;;
    *) die "Invalid MCP host selection." ;;
  esac
}

prompt() {
  prompt_label=$1
  prompt_default=${2-}
  if [ -n "$prompt_default" ]; then
    printf '%b' "${BOLD}$prompt_label${RESET} [$prompt_default]: " >"$TTY"
  else
    printf '%b' "${BOLD}$prompt_label${RESET}: " >"$TTY"
  fi
  IFS= read -r prompt_answer <"$TTY" || die "Input was cancelled."
  if [ -z "$prompt_answer" ]; then
    prompt_answer=$prompt_default
  fi
  printf '%s' "$prompt_answer"
}

secret_prompt() {
  secret_label=$1
  printf '%b' "${BOLD}$secret_label${RESET}: " >"$TTY"
  stty -echo <"$TTY" 2>/dev/null || true
  IFS= read -r secret_answer <"$TTY" || {
    stty echo <"$TTY" 2>/dev/null || true
    die "Input was cancelled."
  }
  stty echo <"$TTY" 2>/dev/null || true
  printf '\n' >"$TTY"
  printf '%s' "$secret_answer"
}

menu() {
  menu_title=$1
  shift
  say "" >"$TTY"
  say "${BOLD}$menu_title${RESET}" >"$TTY"
  menu_index=1
  for menu_item in "$@"; do
    say "  ${BLUE}$menu_index)${RESET} $menu_item" >"$TTY"
    menu_index=$((menu_index + 1))
  done
  while :; do
    printf '%b' "${BOLD}Select${RESET} [1]: " >"$TTY"
    IFS= read -r menu_choice <"$TTY" || die "Input was cancelled."
    menu_choice=${menu_choice:-1}
    case "$menu_choice" in
      ''|*[!0-9]*) warn "Enter a number from 1 to $#." >"$TTY" ;;
      *) [ "$menu_choice" -ge 1 ] 2>/dev/null && [ "$menu_choice" -le "$#" ] 2>/dev/null && {
           printf '%s' "$menu_choice"
           return
         }
         warn "Enter a number from 1 to $#." >"$TTY" ;;
    esac
  done
}

confirm() {
  confirm_label=$1
  confirm_default=${2:-yes}
  if [ "$confirm_default" = yes ]; then
    confirm_hint="Y/n"
  else
    confirm_hint="y/N"
  fi
  while :; do
    printf '%b' "${BOLD}$confirm_label${RESET} [$confirm_hint]: " >"$TTY"
    IFS= read -r confirm_answer <"$TTY" || die "Input was cancelled."
    case "$confirm_answer" in
      y|Y|yes|YES|Yes) return 0 ;;
      n|N|no|NO|No) return 1 ;;
      '') [ "$confirm_default" = yes ] && return 0 || return 1 ;;
      *) warn "Enter y or n." ;;
    esac
  done
}

expand_home() {
  case "$1" in
    '~') printf '%s' "$HOME" ;;
    \~/*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

absolute_path() {
  path_value=$(expand_home "$(trim "$1")")
  case "$path_value" in
    /*) printf '%s' "$path_value" ;;
    *) die "Path must be absolute: $path_value" ;;
  esac
}

valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

# Match the runtime's IP/DNS policy without requiring Node or Python on user PCs.
valid_host() {
  printf '%s\n' "$1" | awk -v kind="$2" '
    function ipv4(v, parts, n, i) {
      n=split(v,parts,"."); if(n!=4) return 0
      for(i=1;i<=n;i++) if(parts[i]!~/^[0-9]+$/ || length(parts[i])>3 ||
        (length(parts[i])>1 && substr(parts[i],1,1)=="0") || parts[i]+0>255) return 0
      return 1
    }
    {
      v=$0; if(length(v)<1 || length(v)>253) exit 1
      if(v~/^\[/ || v~/\]$/) {
        if(kind!="allowed" || v!~/^\[.*\]$/) exit 1
        v=substr(v,2,length(v)-2); if(index(v,":")==0) exit 1
      }
      if(index(v,":")>0) {
        if(v!~/^[0-9a-fA-F:.]+$/ || v~/:::/ || v~/^:[^:]/ || v~/[^:]:$/) exit 1
        if(index(v,".")>0) {
          n=split(v,a,":"); tail=a[n]; if(!ipv4(tail)) exit 1
          v=substr(v,1,length(v)-length(tail)) "0:0"
        }
        copy=v; compression=gsub(/::/,":",copy); if(compression>1) exit 1
        n=split(copy,a,":"); groups=0
        for(i=1;i<=n;i++) if(a[i]!="") {
          if(a[i]!~/^[0-9a-fA-F]+$/ || length(a[i])>4) exit 1
          groups++
        }
        exit !((compression==1 && groups<8) || (compression==0 && groups==8))
      }
      n=split(v,a,".")
      for(i=1;i<=n;i++) if(length(a[i])<1 || length(a[i])>63 ||
        a[i]!~/^[A-Za-z0-9][A-Za-z0-9-]*$/ || a[i]~/-$/) exit 1
    }'
}

canonical_path() (
  canonical_value=$1
  if [ -d "$canonical_value" ]; then cd -P "$canonical_value" && pwd -P; return; fi
  canonical_value=${canonical_value%/}
  canonical_parent=$(dirname "$canonical_value")
  canonical_name=$(basename "$canonical_value")
  [ "$canonical_parent" != "$canonical_value" ] || return 1
  canonical_parent=$(canonical_path "$canonical_parent") || return 1
  case "$canonical_name" in
    .) printf '%s\n' "$canonical_parent" ;;
    ..) dirname "$canonical_parent" ;;
    *) printf '%s/%s\n' "${canonical_parent%/}" "$canonical_name" ;;
  esac
)

validate_state_home() {
  state_path=$(canonical_path "$1") || die "Cannot resolve the Velron data directory."
  state_user_home=$(canonical_path "$HOME") || die "Cannot resolve the user home directory."
  if [ "$state_path" = / ] || [ "$state_path" = "$state_user_home" ] || [ "$state_path" = "$(pwd -P)" ]; then
    die "Velron data must use a dedicated directory, not the filesystem root, user home, or working directory."
  fi
}

runServerCommand() {
  commandTimeout=$1; commandOutput=$2
  shift 2
  "$SERVER_COMMAND" "$@" >"$commandOutput" 2>"$TEMP_DIR/server-command-error.txt" &
  serverCommandPid=$!
  commandElapsed=0
  while kill -0 "$serverCommandPid" 2>/dev/null; do
    if [ "$commandElapsed" -ge "$commandTimeout" ]; then
      kill -KILL "$serverCommandPid" 2>/dev/null || :
      wait "$serverCommandPid" 2>/dev/null || :
      serverCommandPid=''
      return 124
    fi
    sleep 1
    commandElapsed=$((commandElapsed + 1))
  done
  commandResult=0
  wait "$serverCommandPid" || commandResult=$?
  serverCommandPid=''
  return "$commandResult"
}

detectServerCommands() {
  serverCommands=false
  backgroundArgument=''; foregroundArgument=''; launchArgument=''
  # Help bypasses startup/update dispatch in both old and new Server releases.
  if ! runServerCommand 15 "$TEMP_DIR/server-help.txt" --help; then
    die "Could not inspect Velron Server commands. Run velron --help to diagnose the installed binary."
  fi
  if grep -Fxq 'Usage: velron [on|off|status|stream|run]' "$TEMP_DIR/server-help.txt"; then
    serverCommands=true
    backgroundArgument=' on'; foregroundArgument=' run'; launchArgument='<string>run</string>'
  fi
}

assertServerRunning() {
  # status authenticates the instance in VELRON_HOME; exit 0 alone can mean stopped.
  if ! runServerCommand 15 "$TEMP_DIR/server-status.txt" status ||
      ! grep -Eq '^Velron is running \((background|foreground), PID [0-9]+\)\.$' "$TEMP_DIR/server-status.txt"; then
    die "Velron Server is not confirmed running. Check velron status and velron stream."
  fi
}

wait_server_ready() {
  # Existing settings are authoritative when the user elects to preserve them.
  readiness_host=$SERVER_HOST; readiness_port=$SERVER_HTTP_PORT
  if [ "$WRITE_SERVER_CONFIG" = false ]; then
    readiness_host=$(sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VELRON_HOME_PATH/config.json" | head -n 1)
    readiness_port=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$VELRON_HOME_PATH/config.json" | head -n 1)
  fi
  if ! valid_host "$readiness_host" bind || ! valid_port "$readiness_port"; then
    die "Could not determine a valid management address from config.json. Check the Server startup log."
  fi
  case "$readiness_host" in 0.0.0.0) readiness_host=127.0.0.1 ;; ::) readiness_host='[::1]' ;; *:*) readiness_host="[$readiness_host]" ;; esac
  readiness_url="http://$readiness_host:$readiness_port/api/health"
  readiness_attempt=0
  while [ "$readiness_attempt" -lt 30 ]; do
    if [ -n "${STARTED_SERVER_PID:-}" ] && ! kill -0 "$STARTED_SERVER_PID" 2>/dev/null; then
      die "Velron Server exited before becoming ready. Check $VELRON_HOME_PATH/server-error.log and server.log."
    fi
    readiness_body="$TEMP_DIR/readiness.json"
    rm -f "$readiness_body"
    readiness_status=0
    if command -v curl >/dev/null 2>&1; then
      # No credentials, redirects, proxies, or unlimited response waits.
      readiness_status=$(curl --silent --noproxy '*' --connect-timeout 1 --max-time 2 --max-filesize 8192 "$readiness_url" -o "$readiness_body" --write-out '%{http_code}' 2>/dev/null) || :
    else
      wget --no-proxy --timeout=2 --tries=1 --max-redirect=0 --content-on-error -O "$readiness_body" "$readiness_url" --server-response 2>"$TEMP_DIR/readiness.headers" || :
      readiness_status=$(awk '/HTTP\/[0-9.]+ [0-9]+/ { code=$2 } END { print code }' "$TEMP_DIR/readiness.headers")
    fi
    if [ "$readiness_status" = 401 ] && [ -f "$readiness_body" ] && grep -Eq '"code"[[:space:]]*:[[:space:]]*"management_authentication_required"' "$readiness_body"; then
      # Catch immediate exits even if another server already occupies the port.
      sleep 1
      if [ -n "${STARTED_SERVER_PID:-}" ]; then
        kill -0 "$STARTED_SERVER_PID" 2>/dev/null || die "Velron Server exited. Check $VELRON_HOME_PATH/server-error.log."
      elif [ "${AUTOSTART_KIND:-}" = systemd ]; then
        systemctl --user is-active --quiet velron.service || die "Velron user service is not active. Check journalctl --user -u velron.service."
      elif [ "${AUTOSTART_KIND:-}" = launchd ]; then
        launch_pid=$(launchctl print "gui/$(id -u)/com.codenamemc.velron" 2>/dev/null | awk '/^[[:space:]]*pid = [0-9]+/ { print $3; exit }')
        if [ -z "$launch_pid" ] || ! kill -0 "$launch_pid" 2>/dev/null; then
          die "Velron LaunchAgent is not running. Check $VELRON_HOME_PATH/server-error.log."
        fi
      fi
      if [ "$serverCommands" = true ]; then assertServerRunning; fi
      return
    fi
    readiness_attempt=$((readiness_attempt + 1))
    sleep 1
  done
  die "Velron Server did not become ready. Check $VELRON_HOME_PATH/server-error.log, server.log, or journalctl --user -u velron.service; confirm the configured ports are available."
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

download() {
  download_url=$1
  download_destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --connect-timeout 15 --progress-bar "$download_url" -o "$download_destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$download_destination" "$download_url"
  else
    die "curl or wget is required."
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "sha256sum, shasum, or openssl is required to verify downloads."
  fi
}

verify_asset() {
  verify_file=$1
  verify_name=$2
  verify_sums=$3
  verify_expected=$(awk -v name="$verify_name" '$2 == name || $2 == "*" name { print $1; exit }' "$verify_sums")
  [ -n "$verify_expected" ] || die "No checksum was published for $verify_name."
  verify_actual=$(sha256_file "$verify_file")
  [ "$verify_actual" = "$verify_expected" ] || die "SHA-256 verification failed for $verify_name."
  success "Verified $verify_name"
}

trim() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

allowed_hosts_json() {
  allowed_source=$1
  [ -n "$(trim "$allowed_source")" ] || { printf '[]'; return; }
  old_ifs=$IFS
  IFS=','
  set -f
  # Split the comma-delimited host list deliberately; globbing is disabled above.
  # shellcheck disable=SC2086
  set -- $allowed_source
  set +f
  IFS=$old_ifs
  allowed_result='['
  allowed_separator=''
  allowed_count=0
  for allowed_host in "$@"; do
    allowed_host=$(trim "$allowed_host")
    [ -n "$allowed_host" ] || continue
    allowed_count=$((allowed_count + 1))
    [ "$allowed_count" -le 256 ] || die "At most 256 allowed hosts are supported."
    valid_host "$allowed_host" allowed || die "Invalid allowed host: $allowed_host"
    allowed_result="$allowed_result$allowed_separator\"$(json_escape "$allowed_host")\""
    allowed_separator=','
  done
  printf '%s]' "$allowed_result"
}

write_private_file() {
  private_path=$1
  private_content=$2
  private_tmp="$private_path.tmp.$$"
  umask 077
  printf '%s' "$private_content" >"$private_tmp"
  chmod 600 "$private_tmp"
  mv -f "$private_tmp" "$private_path"
}

write_launcher() {
  launcher_path=$1
  runtime_path=$2
  config_path=$3
  launcher_tmp="$launcher_path.tmp.$$"
  {
    printf '%s\n' '#!/bin/sh' 'set -eu'
    if [ "${4:-server}" = client ]; then
      printf '%s\n' 'unset VELRON_VCP_URL VELRON_VCP_TOKEN VELRON_LOCAL_VCP_PORT'
    fi
    printf '%s\n' 'set -a'
    printf '[ ! -f %s ] || . %s\n' "$(shell_quote "$config_path")" "$(shell_quote "$config_path")"
    printf '%s\n' 'set +a'
    printf 'exec %s "$@"\n' "$(shell_quote "$runtime_path")"
  } >"$launcher_tmp"
  chmod 755 "$launcher_tmp"
  mv -f "$launcher_tmp" "$launcher_path"
}

ensure_path() {
  path_directory=$1
  case ":$PATH:" in
    *":$path_directory:"*) ;;
    *) PATH="$path_directory:$PATH"; export PATH ;;
  esac
  path_line="export PATH=$(shell_quote "$path_directory"):\$PATH"
  for profile in "$HOME/.profile" "$HOME/.zprofile"; do
    if [ -e "$profile" ] && [ ! -f "$profile" ]; then
      warn "Skipped non-regular shell profile: $profile"
      continue
    fi
    # Replace only the Installer-owned block; preserve all user profile content.
    profile_tmp="$profile.velron.$$"
    if [ -f "$profile" ]; then
      awk '/^# >>> velron >>>$/ { managed=1; next }
           /^# <<< velron <<<$/{ if (managed) { managed=0; next } }
           !managed { print }
           END { if (managed) exit 1 }' "$profile" >"$profile_tmp" || {
        rm -f "$profile_tmp"
        die "Unterminated Velron PATH block in $profile; repair it before reinstalling."
      }
    else
      : >"$profile_tmp"
    fi
    {
      printf '\n%s\n' '# >>> velron >>>'
      printf '%s\n' "$path_line"
      printf '%s\n' '# <<< velron <<<'
    } >>"$profile_tmp"
    # Write through the existing profile to preserve symlinks and permissions.
    cat "$profile_tmp" >"$profile"
    rm -f "$profile_tmp"
  done
}

configure_autostart() {
  autostart_command=$1
  if [ "$OS_NAME" = linux ]; then
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      unit_file="$unit_dir/velron.service"
      mkdir -p "$unit_dir"
      systemd_exec=$(printf '%s' "$autostart_command" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g; s/\$/$$/g')
      cat >"$unit_file" <<EOF
[Unit]
Description=Velron Server
After=network-online.target

[Service]
Type=simple
ExecStart="$systemd_exec"$foregroundArgument
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
      systemctl --user daemon-reload
      systemctl --user enable velron.service >/dev/null
      AUTOSTART_KIND=systemd
      success "Registered Velron Server with systemd user services"
    else
      desktop_dir="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
      mkdir -p "$desktop_dir"
      # Exec has both desktop-string and argument quoting layers.
      escaped_exec=$(printf '%s' "$autostart_command" | sed 's/\\/\\\\\\\\/g; s/"/\\\\"/g; s/`/\\\\`/g; s/\$/\\\\$/g; s/%/%%/g')
      cat >"$desktop_dir/velron.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Velron Server
Comment=Start Velron Server when you sign in
Exec="$escaped_exec"$backgroundArgument
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
      AUTOSTART_KIND=desktop
      success "Registered Velron Server in desktop autostart"
    fi
  else
    launch_dir="$HOME/Library/LaunchAgents"
    launch_file="$launch_dir/com.codenamemc.velron.plist"
    mkdir -p "$launch_dir"
    escaped_xml=$(printf '%s' "$autostart_command" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
    escaped_home_xml=$(printf '%s' "$VELRON_HOME_PATH" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')
    cat >"$launch_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.codenamemc.velron</string>
  <key>ProgramArguments</key><array><string>$escaped_xml</string>$launchArgument</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>$escaped_home_xml/server.log</string>
  <key>StandardErrorPath</key><string>$escaped_home_xml/server-error.log</string>
</dict>
</plist>
EOF
    AUTOSTART_KIND=launchd
    success "Registered Velron Server as a LaunchAgent"
  fi
}

remove_autostart() {
  if [ "$OS_NAME" = linux ]; then
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable --now velron.service >/dev/null 2>&1 || true
      rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/velron.service"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/velron.desktop"
  else
    launchctl bootout "gui/$(id -u)/com.codenamemc.velron" >/dev/null 2>&1 || true
    rm -f "$HOME/Library/LaunchAgents/com.codenamemc.velron.plist"
  fi
}

printHostMcpCommand() {
  if [ "$1" = codex ]; then
    printf '  codex mcp add velron -- %s mcp\n' "$(shell_quote "$CLIENT_COMMAND")"
  else
    printf '  claude mcp add --transport stdio --scope user velron -- %s mcp\n' "$(shell_quote "$CLIENT_COMMAND")"
  fi
}

installHostMcp() {
  mcpHost=$1
  if ! command -v "$mcpHost" >/dev/null 2>&1; then
    warn "$mcpHost CLI was not found. After installing it, run:"
    printHostMcpCommand "$mcpHost"
    return
  fi
  if ! "$mcpHost" mcp get --help >/dev/null 2>&1; then
    warn "Could not inspect $mcpHost MCP settings. Register Velron manually after checking existing entries:"
    printHostMcpCommand "$mcpHost"
    return
  fi
  if "$mcpHost" mcp get velron >/dev/null 2>&1; then
    warn "Preserved the existing $mcpHost MCP entry named velron. Review its command and settings before replacing it."
    info "After removing only the old Velron entry in that host, register the installed Client with:"
    printHostMcpCommand "$mcpHost"
    return
  fi
  if [ "$mcpHost" = codex ]; then
    if codex mcp add velron -- "$CLIENT_COMMAND" mcp >/dev/null 2>&1; then
      success "Registered Velron as a stdio MCP server for Codex"
    else
      warn "Codex MCP registration did not finish. Check its MCP settings, then run:"
      printHostMcpCommand codex
    fi
  else
    if claude mcp add --transport stdio --scope user velron -- "$CLIENT_COMMAND" mcp >/dev/null 2>&1; then
      success "Registered Velron as a stdio MCP server for Claude Code"
    else
      warn "Claude Code MCP registration did not finish. Check its MCP settings, then run:"
      printHostMcpCommand claude
    fi
  fi
}

say "${BLUE}${BOLD}Velron installer${RESET}"
say "Server, stdio MCP Client, PATH, and startup setup"

case "$(uname -s)" in
  Linux) OS_NAME=linux ;;
  Darwin) OS_NAME=macos ;;
  *) die "This installer supports Linux and macOS. Use install.ps1 on Windows." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH_NAME=x64 ;;
  arm64|aarch64) ARCH_NAME=arm64 ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac

if [ "$NON_INTERACTIVE" = true ]; then
  read_gui_settings
else
install_choice=$(menu "What do you want to install?" "Server and Client" "Server only" "Client only")
INSTALL_SERVER=false
INSTALL_CLIENT=false
case "$install_choice" in
  1) INSTALL_SERVER=true; INSTALL_CLIENT=true ;;
  2) INSTALL_SERVER=true ;;
  3) INSTALL_CLIENT=true ;;
esac

default_velron_home="$HOME/.velron"
VELRON_HOME_PATH=$(absolute_path "$(prompt "Velron data and configuration directory" "$default_velron_home")")
default_command_dir="$HOME/.local/bin"
COMMAND_DIR=$(absolute_path "$(prompt "Command directory (added to PATH)" "$default_command_dir")")
RUNTIME_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/velron/bin"
SERVER_ENV_PATH="$VELRON_HOME_PATH/server.env"
CLIENT_ENV_PATH="$VELRON_HOME_PATH/client.env"

SERVER_HOST=127.0.0.1
SERVER_HTTP_PORT=$DEFAULT_HTTP_PORT
SERVER_VCP_PORT=$DEFAULT_VCP_PORT
SERVER_ALLOWED_HOSTS=''
WRITE_SERVER_CONFIG=false
if [ "$INSTALL_SERVER" = true ]; then
  existing_config="$VELRON_HOME_PATH/config.json"
  if [ -f "$existing_config" ] && confirm "Keep the existing Server config at $existing_config?" yes; then
    discovered_port=$(sed -n 's/.*"localVcpPort"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$existing_config" | head -n 1)
    [ -z "$discovered_port" ] || SERVER_VCP_PORT=$discovered_port
  else
    WRITE_SERVER_CONFIG=true
    SERVER_HOST=$(prompt "Server bind host" "$SERVER_HOST")
    SERVER_HTTP_PORT=$(prompt "Management HTTP port" "$SERVER_HTTP_PORT")
    valid_port "$SERVER_HTTP_PORT" || die "Invalid HTTP port: $SERVER_HTTP_PORT"
    SERVER_VCP_PORT=$(prompt "Pinned local VCP port" "$SERVER_VCP_PORT")
    valid_port "$SERVER_VCP_PORT" || die "Invalid VCP port: $SERVER_VCP_PORT"
    [ "$SERVER_HTTP_PORT" != "$SERVER_VCP_PORT" ] || die "HTTP and VCP ports must differ."
    SERVER_ALLOWED_HOSTS=$(prompt "Additional allowed hosts (comma-separated, optional)" "")
  fi
  if confirm "Start Velron Server automatically when you sign in?" yes; then
    ENABLE_AUTOSTART=true
  else
    ENABLE_AUTOSTART=false
  fi
  if confirm "Start Velron Server after installation?" yes; then
    START_SERVER_NOW=true
  else
    START_SERVER_NOW=false
  fi
fi

VCP_MODE=local
VCP_URL="wss://127.0.0.1:$SERVER_VCP_PORT/vcp/v1"
VCP_TOKEN=''
INTEGRATION_CHOICE=0
if [ "$INSTALL_CLIENT" = true ]; then
  say ""
  say "${BOLD}Client connection${RESET}"
  say "Press Enter to use automatic local discovery. Enter a different wss:// URL for a remote Server."
  entered_vcp_url=$(prompt "VCP URL" "$VCP_URL")
  if [ "$entered_vcp_url" != "$VCP_URL" ]; then
    case "$entered_vcp_url" in
      wss://*) ;;
      *) die "Remote VCP URL must use wss:// and target exactly /vcp/v1." ;;
    esac
    case "$entered_vcp_url" in *'?'*|*'#'*|wss://*@*) die "VCP URL cannot contain credentials, a query, or a fragment." ;; esac
    vcp_remainder=${entered_vcp_url#wss://}
    vcp_authority=${vcp_remainder%%/*}
    vcp_path=/${vcp_remainder#*/}
    if [ -z "$vcp_authority" ] || [ "$vcp_authority" = "$vcp_remainder" ] || [ "$vcp_path" != /vcp/v1 ]; then
      die "Remote VCP URL must target exactly /vcp/v1."
    fi
    VCP_MODE=remote
    VCP_URL=$entered_vcp_url
    VCP_TOKEN=$(secret_prompt "VCP access token")
    case "$VCP_TOKEN" in
      *[!A-Za-z0-9_-]*|'') die "VCP token must be a 43-character base64url value." ;;
    esac
    [ "${#VCP_TOKEN}" -eq 43 ] || die "VCP token must be exactly 43 characters."
  fi

  INTEGRATION_CHOICE=$(menu "Where should Velron Client be connected?" "Codex" "Claude Code" "Codex and Claude Code" "Other... (generic stdio MCP)")
  info "Workspace tools use the absolute call_agent.workspaceDir supplied by your MCP host for each call."
fi

say ""
say "${BOLD}Installation summary${RESET}"
say "  Platform:        $OS_NAME-$ARCH_NAME"
say "  Components:      $([ "$INSTALL_SERVER" = true ] && printf Server)$([ "$INSTALL_SERVER" = true ] && [ "$INSTALL_CLIENT" = true ] && printf ' + ')$([ "$INSTALL_CLIENT" = true ] && printf Client)"
say "  Velron home:     $VELRON_HOME_PATH"
say "  Command path:    $COMMAND_DIR"
if [ "$INSTALL_CLIENT" = true ]; then
  say "  VCP:             $VCP_URL ($VCP_MODE)"
fi
confirm "Continue?" yes || { info "Installation cancelled."; exit 0; }
fi

validate_state_home "$VELRON_HOME_PATH"
if [ "$INSTALL_SERVER" = true ] && [ "$WRITE_SERVER_CONFIG" = true ]; then
  valid_host "$SERVER_HOST" bind || die "Invalid server bind host."
  allowed_hosts_json "$SERVER_ALLOWED_HOSTS" >/dev/null
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/velron-installer.XXXXXX")
BINARIES_COMMITTED=false
SERVER_SWAPPING=false
CLIENT_SWAPPING=false
cleanup() {
  cleanup_status=$?
  if [ -n "${serverCommandPid:-}" ]; then
    kill -KILL "$serverCommandPid" 2>/dev/null || :
    wait "$serverCommandPid" 2>/dev/null || :
  fi
  for component in server client; do
    if [ "$component" = server ]; then
      destination=${SERVER_RUNTIME:-}; swapping=$SERVER_SWAPPING
    else
      destination=${CLIENT_RUNTIME:-}; swapping=$CLIENT_SWAPPING
    fi
    [ -n "$destination" ] || continue
    if [ "$BINARIES_COMMITTED" = false ] && [ "$swapping" = true ]; then
      if [ -f "$destination.previous.$$" ]; then
        mv -f "$destination.previous.$$" "$destination" || {
          warn "Could not restore $destination; recover it from $destination.previous.$$" >&2
          cleanup_status=1
          continue
        }
      else
        rm -f "$destination" || cleanup_status=1
      fi
    fi
    rm -f "$destination.new.$$" "$destination.previous.$$" || cleanup_status=1
  done
  rm -rf "$TEMP_DIR"
  trap - EXIT
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
SUMS_PATH="$TEMP_DIR/SHA256SUMS.txt"
stage download
info "Downloading release checksums..."
download "$LATEST_BASE_URL/SHA256SUMS.txt" "$SUMS_PATH"

# Verify the complete selected set before replacing any installed component.
if [ "$INSTALL_SERVER" = true ]; then
  stage server
  SERVER_ASSET="velron-$OS_NAME-$ARCH_NAME"
  SERVER_DOWNLOAD="$TEMP_DIR/$SERVER_ASSET"
  info "Downloading $SERVER_ASSET..."
  download "$LATEST_BASE_URL/$SERVER_ASSET" "$SERVER_DOWNLOAD"
  verify_asset "$SERVER_DOWNLOAD" "$SERVER_ASSET" "$SUMS_PATH"
  SERVER_RUNTIME="$RUNTIME_DIR/velron-runtime"
  SERVER_COMMAND="$COMMAND_DIR/velron"
fi
if [ "$INSTALL_CLIENT" = true ]; then
  stage client
  CLIENT_ASSET="velron-client-$OS_NAME-$ARCH_NAME"
  CLIENT_DOWNLOAD="$TEMP_DIR/$CLIENT_ASSET"
  info "Downloading $CLIENT_ASSET..."
  download "$LATEST_BASE_URL/$CLIENT_ASSET" "$CLIENT_DOWNLOAD"
  verify_asset "$CLIENT_DOWNLOAD" "$CLIENT_ASSET" "$SUMS_PATH"
  CLIENT_RUNTIME="$RUNTIME_DIR/velron-client-runtime"
  CLIENT_COMMAND="$COMMAND_DIR/velron-client"
fi

mkdir -p "$RUNTIME_DIR" "$COMMAND_DIR" "$VELRON_HOME_PATH"
chmod 700 "$VELRON_HOME_PATH"
# Stage on the destination filesystem and keep prior binaries until both swaps finish.
for component in server client; do
  if [ "$component" = server ]; then
    [ "$INSTALL_SERVER" = true ] || continue
    destination=$SERVER_RUNTIME; source=$SERVER_DOWNLOAD
  else
    [ "$INSTALL_CLIENT" = true ] || continue
    destination=$CLIENT_RUNTIME; source=$CLIENT_DOWNLOAD
  fi
  [ ! -d "$destination" ] || die "Runtime destination is a directory: $destination"
  cp "$source" "$destination.new.$$"
  chmod 755 "$destination.new.$$"
  if [ -e "$destination" ]; then cp -p "$destination" "$destination.previous.$$"; fi
done
for component in server client; do
  if [ "$component" = server ]; then
    [ "$INSTALL_SERVER" = true ] || continue
    SERVER_SWAPPING=true; destination=$SERVER_RUNTIME
  else
    [ "$INSTALL_CLIENT" = true ] || continue
    CLIENT_SWAPPING=true; destination=$CLIENT_RUNTIME
  fi
  mv -f "$destination.new.$$" "$destination"
done
BINARIES_COMMITTED=true

stage configure
if [ "$INSTALL_SERVER" = true ]; then
  server_env_content=$(printf 'VELRON_HOME=%s\n' "$(shell_quote "$VELRON_HOME_PATH")")
  write_private_file "$SERVER_ENV_PATH" "$server_env_content"
  write_launcher "$SERVER_COMMAND" "$SERVER_RUNTIME" "$SERVER_ENV_PATH"
  if [ "$WRITE_SERVER_CONFIG" = true ]; then
    allowed_json=$(allowed_hosts_json "$SERVER_ALLOWED_HOSTS")
    server_json=$(cat <<EOF
{
  "schemaVersion": 1,
  "host": "$(json_escape "$SERVER_HOST")",
  "port": $SERVER_HTTP_PORT,
  "localVcpPort": $SERVER_VCP_PORT,
  "allowedHosts": $allowed_json,
  "managementSecureCookies": false,
  "maxConcurrentRuns": 4,
  "maxRunStartsPerMinute": 60,
  "maxRunContextBytes": 8388608
}
EOF
)
    write_private_file "$VELRON_HOME_PATH/config.json" "$server_json"
  fi
fi
if [ "$INSTALL_CLIENT" = true ]; then
  client_env_content=$(printf 'VELRON_HOME=%s\n' "$(shell_quote "$VELRON_HOME_PATH")")
  if [ "$VCP_MODE" = remote ]; then
    client_env_content=$(printf '%s\nVELRON_VCP_URL=%s\nVELRON_VCP_TOKEN=%s\n' "$client_env_content" "$(shell_quote "$VCP_URL")" "$(shell_quote "$VCP_TOKEN")")
  fi
  write_private_file "$CLIENT_ENV_PATH" "$client_env_content"
  write_launcher "$CLIENT_COMMAND" "$CLIENT_RUNTIME" "$CLIENT_ENV_PATH" client
fi

ensure_path "$COMMAND_DIR"
success "Added Velron commands to PATH"

if [ "$INSTALL_CLIENT" = true ]; then
  stage integrate
  OTHER_CONFIG="$VELRON_HOME_PATH/stdio-mcp.json"
  other_json=$(cat <<EOF
{
  "mcpServers": {
    "velron": {
      "type": "stdio",
      "command": "$(json_escape "$CLIENT_COMMAND")",
      "args": ["mcp"]
    }
  }
}
EOF
)
  write_private_file "$OTHER_CONFIG" "$other_json"
  success "Wrote stdio MCP configuration to $OTHER_CONFIG"
  info "The installed Client launcher reads connection settings from $CLIENT_ENV_PATH."
  case "$INTEGRATION_CHOICE" in
    1) installHostMcp codex ;;
    2) installHostMcp claude ;;
    3) installHostMcp codex; installHostMcp claude ;;
    4) info "Merge the velron entry from this JSON into your MCP host settings; keep other entries." ;;
  esac
fi

if [ "$INSTALL_SERVER" = true ]; then
  stage startup
  detectServerCommands
  if [ "$ENABLE_AUTOSTART" = true ]; then
    configure_autostart "$SERVER_COMMAND"
  else
    remove_autostart
    info "Velron Server autostart is disabled"
  fi
  if [ "$START_SERVER_NOW" = true ]; then
    if [ "${AUTOSTART_KIND:-}" = systemd ]; then
      systemctl --user restart velron.service
    elif [ "${AUTOSTART_KIND:-}" = launchd ]; then
      launchctl bootout "gui/$(id -u)/com.codenamemc.velron" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codenamemc.velron.plist" >/dev/null 2>&1 || die "LaunchAgent could not be loaded. Check launchctl diagnostics and retry."
      launchctl kickstart -k "gui/$(id -u)/com.codenamemc.velron" >/dev/null 2>&1 || die "LaunchAgent could not be started."
    elif [ "$serverCommands" = true ]; then
      # on detaches itself. Its private Management URL must not reach GUI logs.
      runServerCommand 130 "$TEMP_DIR/server-on.txt" on || die "Velron Server could not start. Check velron status and velron stream."
      assertServerRunning
    else
      nohup "$SERVER_COMMAND" >"$VELRON_HOME_PATH/server.log" 2>"$VELRON_HOME_PATH/server-error.log" &
      STARTED_SERVER_PID=$!
    fi
    wait_server_ready
    success "Velron Server is responding and authentication is ready"
    info "Management token file (private): $VELRON_HOME_PATH/management-token"
  fi
fi

say ""
success "Velron installation is complete."
stage complete
say "Open a new terminal, then run:"
if [ "$INSTALL_SERVER" = true ]; then
  say "  velron$backgroundArgument"
  [ "$serverCommands" != true ] || say "  velron status / velron off / velron stream"
fi
[ "$INSTALL_CLIENT" = true ] && say "  velron-client --help"
if [ "$INSTALL_CLIENT" = true ]; then
  info "Restart your MCP host to load the stdio Client and its new call_agent schema."
  info "For workspace tools, pass the existing project directory's absolute path as call_agent.workspaceDir."
  info "If upgrading from a Velron plugin, remove that old host plugin and any separately registered Velron PreToolUse Hook or duplicate MCP entry. The installer does not change those settings."
fi
