# Velron desktop Installer

A native desktop window with one shared Korean/English interface for Windows, macOS, and Linux.
The interface uses Velron's light palette, blue accent, rounded controls, logo, and Paperlogy
wordmark. The Electron runtime is included; users do not install Node.js or open a terminal.

## Installation flow

1. Choose Server + Client, Server only, or Client only.
2. Pick the data/configuration and command folders with native directory dialogs or enter paths.
3. Keep existing Server settings, or set the bind host, HTTP/VCP ports, and allowed hosts.
   Choose sign-in startup and whether to start the Server immediately.
4. Use automatic local discovery or enter a remote `wss://.../vcp/v1` address and access token.
   Connect Codex, Claude Code, both, or another stdio MCP host.
5. Review settings and install. Follow real engine phases and logs in the same window.
6. Open Velron, find the MCP configuration file, and review remaining integration steps.

Only relevant steps appear for the selected components. Existing MCP entries are preserved.
Unavailable CLIs and registration failures are shown as follow-up work, with full instructions
in the expanded log. Cancellation stops the installer process tree; already-installed files and
settings remain. Errors offer log copying and a return to the review step for another attempt.

The GUI bundles the root `install.sh` and `install.ps1` from the same commit. It invokes their
`--non-interactive` / `-NonInteractive` mode with validated `VELRON_INSTALL_*` environment values.
Both UI modes share checksum verification, download, configuration, PATH, MCP, and startup logic.
The normal One-line install remains interactive. Server/Client binaries are downloaded from the
[latest application release in velronRelease](https://github.com/CodingManFocus/velronRelease/releases/latest),
so an internet connection is required. Installer source, engines, builds, and releases are maintained
in [velronInstaller](https://github.com/CodingManFocus/velronInstaller).

All selected runtime downloads are verified before any installed runtime is replaced. The engines
stage both replacements and retain previous binaries while swapping; an ordinary swap failure
restores the previous selected set. This transaction covers binary replacement, not later PATH,
MCP, configuration, or startup changes. A power loss or forced process-tree termination can still
interrupt a swap; keep a backup before upgrading an important installation. On Windows, close
Server and Client processes before upgrading. The Installer reports a locked executable and
preserves/restores the previous binaries where the OS permits; it does not forcibly terminate
running applications to replace them.

When immediate startup is selected, success requires a live Server process/service and the expected
unauthenticated management response. This checks management listener readiness; it does not test
configured model providers. Startup failures point to `server-error.log`, `server.log`, or the user
service journal. The GUI's **Open Velron** checks a numeric loopback endpoint, reads the private
`management-token` file, and hands it to the browser in a URL fragment. The token is never returned
to the renderer or included in Installer logs. Automatic sign-in requires a loopback/wildcard bind;
custom network binds receive instructions to enable local access. The runtime writes the token file
when it starts, so installations that defer startup must start Server before signing in.

The data directory must be separate from root, user home, working directory, and command directory.
On Windows it must be a dedicated local subdirectory of the user's profile; the PowerShell engine
rejects junctions and symlinks below that profile. Existing GUI Server settings are validated against
the full runtime settings schema. POSIX reinstalls replace the Installer-owned PATH block with the
new command directory. Installed local Client launchers clear inherited remote URL/token and port
overrides so that automatic local discovery takes effect.

## Downloads and compatibility

The **Installer builds and releases** workflow builds and checks these files, saves them together
as the `installer-release-files` Actions artifact, and publishes complete verified releases on
`main`. Download them from the [latest Installer release](https://github.com/CodingManFocus/velronInstaller/releases/latest):

| File | Platform |
| --- | --- |
| `Velron-Installer-windows-x64.exe` | Windows x64, portable GUI executable |
| `Velron-Installer-windows-arm64.exe` | Windows ARM64, portable GUI executable |
| `Velron-Installer-macos-universal.zip` | Apple Silicon and Intel, containing `Velron Installer.app` |
| `Velron-Installer-linux.tar.gz` | x64 and ARM64 applications plus an architecture-selecting desktop launcher |
| `SHA256SUMS-installers.txt` | SHA-256 checksums for all four downloads |

Use a desktop OS supported by the pinned Electron version. Linux needs the usual GTK/NSS desktop
libraries and Chromium sandbox support. The launcher does not disable the sandbox. The Electron
archive uses unprivileged user namespaces where the OS permits them. On systems that restrict
them, a system administrator must configure the included `chrome-sandbox` helper (root ownership
and mode `4755`) in the selected architecture's directory before the GUI can launch.
CI configures that helper for its native checks, then removes privileged permissions before
creating the portable archive.
The Electron
runtime makes downloads larger than the previous terminal launchers. Windows and macOS do not
yet have a trusted publisher signature/notarization; normal OS security prompts still apply.

## Development

```sh
cd installer
npm ci
npm start
npm test
npx playwright install chromium
npm run test:ui
node tests/nativeSmoke.cjs
```

On Linux CI, run the native smoke check with `xvfb-run -a`. `VELRON_SMOKE_EXECUTABLE` selects a
packaged executable for that check. `VELRON_TEST_CHROMIUM` optionally selects a local Chromium
for UI tests. Engine tests use temporary directories and fake downloads, and do not install
Velron onto the developer's account. Native smoke tests open the real window and verify the
sandboxed bridge and input validation without starting an installation.

Build on the corresponding OS with `npm run build:windows`, `npm run build:macos`, or
`npm run build:linux`. CI packages both Linux architectures into the shared archive, builds a
universal macOS application, checks native source and packaged windows, and captures screenshots.
Windows and Linux ARM64 builds are cross-compiled; native smoke checks execute the runner's
architecture, while macOS additionally verifies both universal slices with `lipo`.

The repository requires Node.js 22.12 or newer. Pull requests run checks and builds without
publication. Pushes to `main` and manual **Run workflow** runs on `main` also publish a release,
only after the shared shell/PowerShell checks and all three OS build jobs pass.
The checksum helper can also be run locally from the repository root:

```sh
node installer/scripts/prepareReleaseFiles.cjs dist
```

It rejects missing, empty, or non-regular installer files, then streams their SHA-256 hashes into
`SHA256SUMS-installers.txt`. Unit tests exercise the publisher against a fake GitHub service,
including failed uploads, missing/duplicate assets, corrupted downloads, and stale source commits.

## Release publication

1. Push the intended changes to `CodingManFocus/velronInstaller` on `main`, or select
   **Actions → Installer builds and releases → Run workflow → main**.
2. CI tests and builds the four platform installers. The release job creates a draft tagged
   `installer-<full source SHA>-<workflow run ID>-<run attempt>`, targeting the exact source commit.
   A rerun receives a new tag; existing published assets are never replaced or deleted.
3. CI uploads all four installers plus `SHA256SUMS-installers.txt`, checks the complete asset set
   and sizes, then downloads and hashes every uploaded file. A failure keeps the release as an
   unpublished draft and leaves the previous Latest release available.
4. After verification, CI publishes the draft and marks it **Latest**. VelronWeb and the links
   below immediately resolve through this repository's latest-release pointer:

```text
https://github.com/CodingManFocus/velronInstaller/releases/latest/download/Velron-Installer-windows-x64.exe
https://github.com/CodingManFocus/velronInstaller/releases/latest/download/Velron-Installer-windows-arm64.exe
https://github.com/CodingManFocus/velronInstaller/releases/latest/download/Velron-Installer-macos-universal.zip
https://github.com/CodingManFocus/velronInstaller/releases/latest/download/Velron-Installer-linux.tar.gz
https://github.com/CodingManFocus/velronInstaller/releases/latest/download/SHA256SUMS-installers.txt
```

Publication is restricted to this repository's `main` branch and uses only its `GITHUB_TOKEN`
with `contents: write` on the release job. Build/check jobs have read-only repository access.
Workflow runs are serialized per branch; the publisher also checks the current `main` commit
before creating a draft and again before publication. If a newer commit arrives, the older
run cannot promote its build. Run the workflow again on current `main` to recover after a failure;
unused failed drafts can be reviewed and removed manually.

Published tags and assets are immutable by this workflow: it never updates them. GitHub's
optional repository **Immutable releases** setting can additionally enforce this at the platform
level. The publisher is compatible with that setting because all asset uploads happen in a draft.
The `installer-latest` marker release from the old shared repository is no longer used.
The installation engines still fetch application payloads from `CodingManFocus/velronRelease`;
this workflow has no access to publish there.

## Implementation boundaries

- `app/installOptions.cjs`: defaults, validation, and conversion to environment values.
- `app/installRunner.cjs`: fixed engine invocation, phases/logs, token redaction, cancellation.
- `app/main.cjs`: native window, file dialogs, allowlisted IPC, and completion actions.
- `app/preload.cjs`: narrow context-isolated bridge; no arbitrary command or filesystem access.
- `ui/`: local-only interface, translations, design tokens, and licensed branding assets.
- Root scripts: shared installation engine with an additional non-interactive input adapter.

The renderer has no Node integration, network access, navigation, child windows, or requested
permissions. Tokens are passed only in the child environment and redacted from retained logs;
UI preferences and tokens are not saved by the Installer. The installed Client's connection
configuration behavior remains the responsibility of the shared engine.
