# Velron Installer

This repository is the canonical source and release home for the Velron desktop Installer
and the shared `install.sh` / `install.ps1` installation engines. The Installer downloads
Velron Server and Client from [velronRelease](https://github.com/CodingManFocus/velronRelease),
verifies their SHA-256 checksums, and walks through the initial setup.

## One-line install

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/CodingManFocus/velronInstaller/main/install.ps1 | iex
```

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/CodingManFocus/velronInstaller/main/install.sh | sh
```

Both commands open an interactive terminal wizard. It lets you:

- install Velron Server, Velron Client, or both;
- choose the Velron data directory and command directory;
- configure the Server bind host, management port, pinned local VCP port, and allowed hosts;
- view or replace the Client VCP URL and securely enter the token required by a remote Server;
- register the stdio Velron Client for Codex, Claude Code, or both;
- generate a generic stdio MCP configuration for another host;
- add `velron` and `velron-client` to the user `PATH`;
- register Velron Server to start when the user signs in, and optionally start it immediately.

The default Client endpoint shown by the wizard is
`wss://127.0.0.1:4143/vcp/v1`. Accepting it keeps automatic local discovery enabled: Client reads
the active port, access token, and pinned CA from the shared Velron data directory. A custom remote
URL must use `wss://`, must end in `/vcp/v1`, and requires a VCP access token.

## Open the Installer instead

Prefer a desktop setup window? Download an Installer below. Its Korean/English GUI follows
Velron’s visual style and provides the same Server, Client, connection, PATH, and startup options.
An internet connection is required.

| Platform | Installer |
| --- | --- |
| Windows (Intel / AMD) | [Velron-Installer-windows-x64.exe](https://github.com/CodingManFocus/velronInstaller/releases/latest/download/Velron-Installer-windows-x64.exe) |
| Windows (ARM) | [Velron-Installer-windows-arm64.exe](https://github.com/CodingManFocus/velronInstaller/releases/latest/download/Velron-Installer-windows-arm64.exe) |
| macOS (Apple Silicon / Intel) | [Velron-Installer-macos-universal.zip](https://github.com/CodingManFocus/velronInstaller/releases/latest/download/Velron-Installer-macos-universal.zip) |
| Linux | [Velron-Installer-linux.tar.gz](https://github.com/CodingManFocus/velronInstaller/releases/latest/download/Velron-Installer-linux.tar.gz) |

On Windows, open the `.exe`. On macOS, extract the ZIP and open `Velron Installer.app`.
On Linux, extract the archive and open `Velron-Installer.desktop` (allow launching if your desktop
asks), or run `sh launch.sh` in that folder. The same desktop wizard opens on every platform.
Choose folders and settings, review your choices, then follow progress and any remaining steps
inside the window. The GUI does not require an interactive terminal.

The Windows and macOS launchers do not yet have a trusted publisher signature; your OS may ask for
approval before opening them. [Installer details and source](installer/README.md) and
[SHA-256 checksums](https://github.com/CodingManFocus/velronInstaller/releases/latest/download/SHA256SUMS-installers.txt)
are available separately.

## Default locations

| Platform | Commands | Runtime binaries | Data and configuration |
| --- | --- | --- | --- |
| Windows | `%LOCALAPPDATA%\Programs\Velron\bin` | Same as commands | `%USERPROFILE%\.velron` |
| macOS/Linux | `~/.local/bin` | `~/.local/share/velron/bin` | `~/.velron` |

All locations can be changed in the wizard where doing so is safe. The Server startup registration
uses a per-user Startup shortcut on Windows, a LaunchAgent on macOS, and a systemd user service
(or desktop autostart fallback) on Linux.

For releases with process commands, Windows Startup and Linux desktop autostart run `velron on`.
systemd and launchd run `velron run`, so the service manager retains the foreground process.
Reinstalling with autostart enabled replaces the Installer-owned registration with these arguments.
The Installer checks the downloaded Server's help output first; older releases keep their original
argument-free startup command. Application auto-update does not rewrite OS startup registrations.

Use `velron on`, `velron off`, `velron status`, and `velron stream` to control or inspect the installed
Server. `velron` and `velron run` still run it in the current terminal. These commands use the same
configured data directory as the startup registration. For systemd, an intentional `velron off`
does not trigger `Restart=on-failure`; use `systemctl --user start velron.service` to restart under
systemd supervision. On macOS, use `launchctl kickstart gui/$(id -u)/com.codenamemc.velron`.

## MCP connection and workspace paths

Velron Client is a regular stdio MCP server. The installer registers the absolute Client command with
`codex mcp add` or `claude mcp add --transport stdio --scope user`. It uses the host CLI to update its
configuration and preserves any existing MCP entry named `velron` for you to review. If a selected CLI
is unavailable or cannot register the entry, the installer prints a command to run after resolving it.

The installer also saves `stdio-mcp.json` in the chosen Velron data directory for manual setup. Merge
its `velron` entry into the host's existing `mcpServers` object without replacing unrelated entries.
On macOS/Linux the registered launcher reads `client.env` from that data directory. On Windows the
installer configures the connection environment. Restart your MCP host after installation.

For Agents that use VCP workspace tools, supply `workspaceDir` in each `call_agent` invocation. It must
be the absolute path of an existing project directory on the computer running Velron Client. Agents
without workspace tools may omit it. The installer no longer asks for a fixed project directory.

```json
{
  "agentId": "code-scout",
  "prompt": "Inspect this project's structure.",
  "workspaceDir": "/home/user/projects/example"
}
```

On Windows, use a path such as `C:\\Users\\user\\projects\\example` in JSON. Relative paths such as
`.` and `../project` are rejected. The MCP caller selects this directory; it is not a signed claim
about the host's current working directory.

When upgrading from an older Velron plugin, remove that plugin from Codex or Claude Code. Also remove
any separately registered Velron `PreToolUse` Hook and duplicate MCP entry, then register the new
stdio entry and restart the host. The installer does not automatically delete host plugins or Hooks.
The old `setup-plugin` and `hook` commands and the `VELRON_WORKSPACE_ROOT` fallback are no longer used.

Host configuration details: [Codex MCP](https://developers.openai.com/codex/mcp) and
[Claude Code MCP](https://code.claude.com/docs/en/mcp-quickstart).

## Application downloads

Server and Client builds for Windows, macOS, and Linux on x64 and ARM64, plus
`SHA256SUMS.txt`, remain in the [latest Velron application release](https://github.com/CodingManFocus/velronRelease/releases/latest).
Installer releases live separately in [velronInstaller](https://github.com/CodingManFocus/velronInstaller/releases/latest).
Each repository's Latest release therefore identifies only its own product.

## Development and releases

The initial source was migrated from `CodingManFocus/velronRelease` at
[`bd63950bd93f8e5a0f95e25781f7a0dc74c82c8a`](https://github.com/CodingManFocus/velronRelease/commit/bd63950bd93f8e5a0f95e25781f7a0dc74c82c8a).

Develop the desktop application in `installer/` and the shared installation engines at the
repository root. See [Installer development](installer/README.md#development) for commands.

The **Installer builds and releases** workflow tests and builds every platform on each push to
`main`. It also supports **Run workflow** on `main`; pull requests run checks and builds without
publishing. After every check passes, it creates a uniquely tagged draft release in this
repository, uploads the four installers and their checksum manifest, and downloads all five
assets to verify their bytes. Only then does it publish the release and mark it **Latest**.

The release job uses this repository's short-lived `GITHUB_TOKEN`; no personal access token or
cross-repository secret is needed. Failed verification leaves the draft unpublished. Previously
published releases and assets are never overwritten. An outdated main build is skipped so it
cannot replace a newer revision's Latest release. Server and Client release publication in
`velronRelease` is independent and remains manual.

See [release behavior](installer/README.md#release-publication) for tags and recovery.

Use is subject to the terms in [LICENSE](LICENSE).
