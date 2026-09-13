param([switch]$NonInteractive)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($NonInteractive) {
    $ProgressPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
}

# Installer source/releases live in velronInstaller; application payloads stay here.
$repository = 'CodingManFocus/velronRelease'
$latestBaseUrl = "https://github.com/$repository/releases/latest/download"
$defaultHttpPort = 4141
$defaultVcpPort = 4143
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-Stage([string]$Name) {
    if ($NonInteractive) { Write-Output "VELRON_INSTALL_STAGE:$Name" }
}

function Read-GuiBoolean([string]$Name) {
    $value = [Environment]::GetEnvironmentVariable("VELRON_INSTALL_$Name")
    if ($value -notin @('true', 'false')) { throw "Invalid boolean setting: $Name" }
    return $value -eq 'true'
}

function Write-Info([string]$Message) {
    Write-Host 'i ' -ForegroundColor Blue -NoNewline
    Write-Host $Message
}

function Write-Success([string]$Message) {
    Write-Host "$([char]0x2713) " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-WarningMessage([string]$Message) {
    Write-Host '! ' -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}

function Read-Value([string]$Label, [string]$Default = '') {
    if ($Default) {
        $answer = Read-Host "$Label [$Default]"
    } else {
        $answer = Read-Host $Label
    }
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

function Read-SecretValue([string]$Label) {
    $secure = Read-Host $Label -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Read-Menu([string]$Title, [string[]]$Items) {
    Write-Host ''
    Write-Host $Title -ForegroundColor White
    for ($index = 0; $index -lt $Items.Count; $index++) {
        Write-Host "  $($index + 1)) " -ForegroundColor Blue -NoNewline
        Write-Host $Items[$index]
    }
    while ($true) {
        $answer = Read-Host 'Select [1]'
        if ([string]::IsNullOrWhiteSpace($answer)) { return 1 }
        $choice = 0
        if ([int]::TryParse($answer, [ref]$choice) -and $choice -ge 1 -and $choice -le $Items.Count) {
            return $choice
        }
        Write-WarningMessage "Enter a number from 1 to $($Items.Count)."
    }
}

function Read-Confirmation([string]$Label, [bool]$Default = $true) {
    $hint = if ($Default) { 'Y/n' } else { 'y/N' }
    while ($true) {
        $answer = (Read-Host "$Label [$hint]").Trim().ToLowerInvariant()
        if (-not $answer) { return $Default }
        if ($answer -in @('y', 'yes')) { return $true }
        if ($answer -in @('n', 'no')) { return $false }
        Write-WarningMessage 'Enter y or n.'
    }
}

function Resolve-AbsolutePath([string]$Value) {
    $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim())
    if ($expanded -eq '~') { $expanded = $HOME }
    if ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
        $expanded = Join-Path $HOME $expanded.Substring(2)
    }
    if (-not [IO.Path]::IsPathRooted($expanded)) {
        throw "Path must be absolute: $expanded"
    }
    return [IO.Path]::GetFullPath($expanded)
}

function Read-Port([string]$Label, [int]$Default) {
    while ($true) {
        $text = Read-Value $Label "$Default"
        $port = 0
        if ([int]::TryParse($text, [ref]$port) -and $port -ge 1 -and $port -le 65535) {
            return $port
        }
        Write-WarningMessage 'Enter an integer between 1 and 65535.'
    }
}

function Assert-ServerHost([string]$Value, [switch]$Allowed) {
    if (-not $Value -or $Value.Length -gt 253) { throw 'Invalid server host.' }
    $hostValue = $Value
    if ($hostValue.StartsWith('[') -or $hostValue.EndsWith(']')) {
        if (-not $Allowed -or $hostValue -notmatch '^\[([^\]]+)\]$') { throw 'Bind IPv6 hosts must not use brackets.' }
        $hostValue = $Matches[1]
        $address = $null
        if (-not [Net.IPAddress]::TryParse($hostValue, [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetworkV6) { throw 'Invalid IPv6 allowed host.' }
        return
    }
    if ($hostValue.Contains(':')) {
        $address = $null
        if (-not [Net.IPAddress]::TryParse($hostValue, [ref]$address) -or $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetworkV6) { throw 'Host must be an IP address or hostname without a port.' }
        return
    }
    foreach ($label in $hostValue.Split('.')) {
        if ($label.Length -lt 1 -or $label.Length -gt 63 -or $label -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$') { throw 'Invalid DNS hostname.' }
    }
}

function Assert-StateHome([string]$StateHome, [string]$CommandDirectory) {
    $state = [IO.Path]::GetFullPath($StateHome).TrimEnd('\', '/')
    $profile = [IO.Path]::GetFullPath($HOME).TrimEnd('\', '/')
    if ($state -notmatch '^[A-Za-z]:\\' -or -not $state.StartsWith("$profile\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Velron data must be a dedicated subdirectory of your local Windows user profile, such as %USERPROFILE%\.velron.'
    }
    if ($state -ieq ([IO.Path]::GetFullPath($CommandDirectory).TrimEnd('\', '/')) -or $state -ieq ([IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\', '/'))) {
        throw 'Velron data cannot be the command directory or the current working directory.'
    }
    # A junction could make a lexical profile descendant resolve outside that profile.
    $ancestor = $state
    while ($ancestor -and $ancestor -ine $profile) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Choose a Velron data path without symlinks or junctions below the user profile.'
        }
        $ancestor = Split-Path -Parent $ancestor
    }
}

function Invoke-ServerCommand([string]$ServerPath, [string]$Argument, [int]$TimeoutSeconds = 15) {
    $commandProcess = [Diagnostics.Process]::new()
    $commandProcess.StartInfo = [Diagnostics.ProcessStartInfo]::new()
    $commandProcess.StartInfo.FileName = $ServerPath
    $commandProcess.StartInfo.Arguments = $Argument
    $commandProcess.StartInfo.WorkingDirectory = Split-Path -Parent $ServerPath
    $commandProcess.StartInfo.UseShellExecute = $false
    $commandProcess.StartInfo.CreateNoWindow = $true
    $commandProcess.StartInfo.RedirectStandardOutput = $true
    $commandProcess.StartInfo.RedirectStandardError = $true
    try {
        if (-not $commandProcess.Start()) { throw 'Could not launch Velron command.' }
        $outputTask = $commandProcess.StandardOutput.ReadToEndAsync()
        $errorTask = $commandProcess.StandardError.ReadToEndAsync()
        if (-not $commandProcess.WaitForExit($TimeoutSeconds * 1000)) {
            $commandProcess.Kill()
            throw "Velron $Argument timed out. Check velron status and velron stream."
        }
        if (-not $outputTask.Wait(1000) -or -not $errorTask.Wait(1000)) {
            throw "Velron $Argument did not close its output streams."
        }
        if ($commandProcess.ExitCode -ne 0) {
            throw "Velron $Argument failed (exit $($commandProcess.ExitCode)). Check velron status and velron stream."
        }
        # Output can contain a private Management URL. Never send it to GUI logs.
        return $outputTask.Result
    } finally { $commandProcess.Dispose() }
}

function Test-ServerCommands([string]$ServerPath) {
    $helpText = Invoke-ServerCommand $ServerPath '--help'
    return $helpText -cmatch '(?m)^Usage: velron \[on\|off\|status\|stream\|run\]\r?$'
}

function Assert-ServerRunning([string]$ServerPath) {
    $statusText = Invoke-ServerCommand $ServerPath 'status'
    if ($statusText -cnotmatch '(?m)^Velron is running \((background|foreground), PID [0-9]+\)\.\r?$') {
        throw 'Velron Server is not confirmed running. Check velron status and velron stream.'
    }
}

function Start-ManagedServer([string]$ServerPath) {
    Invoke-ServerCommand $ServerPath 'on' 130 | Out-Null
    Assert-ServerRunning $ServerPath
}

function Wait-ServerReady([Diagnostics.Process]$Process, [string]$StateHome, [string]$ServerPath = '') {
    $settings = Get-Content -Raw -LiteralPath (Join-Path $StateHome 'config.json') | ConvertFrom-Json
    Assert-ServerHost $settings.host
    $bindHost = $settings.host
    if ($bindHost -eq '0.0.0.0') { $bindHost = '127.0.0.1' }
    elseif ($bindHost -eq '::') { $bindHost = '::1' }
    if ($bindHost.Contains(':')) { $bindHost = "[$bindHost]" }
    $uri = "http://${bindHost}:$($settings.port)/api/health"
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($Process) {
            $Process.Refresh()
            if ($Process.HasExited) { throw "Velron Server exited before becoming ready. Check $StateHome\server-error.log and server.log." }
        }
        $response = $null; $reader = $null; $ready = $false
        try {
            $request = [Net.HttpWebRequest]::Create($uri)
            $request.Proxy = $null
            $request.AllowAutoRedirect = $false
            $request.Timeout = 2000
            $request.ReadWriteTimeout = 2000
            try { $response = $request.GetResponse() }
            catch [Net.WebException] { $response = $_.Exception.Response }
            if ($response -and [int]$response.StatusCode -eq 401) {
                $reader = [IO.StreamReader]::new($response.GetResponseStream())
                $buffer = New-Object char[] 8192
                $count = $reader.ReadBlock($buffer, 0, $buffer.Length)
                if ($count -lt $buffer.Length) {
                    $body = (-join $buffer[0..($count - 1)]) | ConvertFrom-Json
                    $ready = $body.error.code -eq 'management_authentication_required'
                }
            }
        } catch { $ready = $false }
        finally {
            if ($reader) { $reader.Dispose() }
            if ($response) { $response.Close() }
        }
        if ($ready) {
            Start-Sleep -Seconds 1
            if ($Process) {
                $Process.Refresh()
                if ($Process.HasExited) { throw "Velron Server exited. Check $StateHome\server-error.log." }
            }
            if ($ServerPath) { Assert-ServerRunning $ServerPath }
            return
        }
        Start-Sleep -Seconds 1
    }
    throw "Velron Server did not become ready. Check $StateHome\server-error.log and server.log; confirm the configured ports are available."
}

function Assert-VcpUrl([string]$Value) {
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'wss' -or
        $uri.AbsolutePath -ne '/vcp/v1' -or
        $uri.Query -or
        $uri.Fragment -or
        $uri.UserInfo) {
        throw 'Remote VCP URL must use wss://, target exactly /vcp/v1, and contain no credentials, query, or fragment.'
    }
}

function Write-PrivateUtf8File([string]$Path, [string]$Content) {
    $directory = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = "$Path.tmp.$PID"
    [IO.File]::WriteAllText($temporary, $Content, $script:utf8NoBom)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-VerifiedAsset([string]$AssetName, [string]$ChecksumsPath, [string]$TemporaryDirectory) {
    $downloadPath = Join-Path $TemporaryDirectory $AssetName
    Write-Info "Downloading $AssetName..."
    Invoke-WebRequest -UseBasicParsing -Uri "$script:latestBaseUrl/$AssetName" -OutFile $downloadPath
    $line = Get-Content -LiteralPath $ChecksumsPath | Where-Object {
        $_ -match "^[0-9a-fA-F]{64}\s+\*?$([regex]::Escape($AssetName))$"
    } | Select-Object -First 1
    if (-not $line) { throw "No checksum was published for $AssetName." }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw "SHA-256 verification failed for $AssetName." }
    Write-Success "Verified $AssetName"
    return $downloadPath
}

function Install-StagedAssets([object[]]$Assets) {
    $changed = [Collections.Generic.List[object]]::new()
    try {
        # Verify all downloads before calling this function; stage all replacements next.
        foreach ($asset in $Assets) {
            [IO.Directory]::CreateDirectory((Split-Path -Parent $asset.Destination)) | Out-Null
            if (Test-Path -LiteralPath $asset.Destination -PathType Container) { throw "Runtime destination is a directory: $($asset.Destination)" }
            $asset.Staged = "$($asset.Destination).new.$PID"
            $asset.Backup = "$($asset.Destination).previous.$PID"
            Copy-Item -LiteralPath $asset.Source -Destination $asset.Staged -Force
            if (Test-Path -LiteralPath $asset.Destination -PathType Leaf) {
                Copy-Item -LiteralPath $asset.Destination -Destination $asset.Backup -Force
            }
        }
        foreach ($asset in $Assets) {
            Move-Item -LiteralPath $asset.Staged -Destination $asset.Destination -Force
            $changed.Add($asset)
        }
    } catch {
        $installError = $_
        for ($index = $changed.Count - 1; $index -ge 0; $index--) {
            $asset = $changed[$index]
            try {
                if (Test-Path -LiteralPath $asset.Backup -PathType Leaf) {
                    Move-Item -LiteralPath $asset.Backup -Destination $asset.Destination -Force
                } else { Remove-Item -LiteralPath $asset.Destination -Force }
            } catch {
                $asset.RetainBackup = $true
                Write-WarningMessage "Could not restore $($asset.Destination). Recover it from $($asset.Backup)."
            }
        }
        throw "Could not replace the selected runtimes. Close Velron Server and MCP Client processes, then retry. $($installError.Exception.Message)"
    } finally {
        foreach ($asset in $Assets) {
            if ($asset.Staged -and (Test-Path -LiteralPath $asset.Staged)) { Remove-Item -LiteralPath $asset.Staged -Force -ErrorAction SilentlyContinue }
            if ($asset.Backup -and -not $asset.RetainBackup -and (Test-Path -LiteralPath $asset.Backup)) {
                Remove-Item -LiteralPath $asset.Backup -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

function Add-UserPath([string]$Directory) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $Directory.TrimEnd('\') })) {
        $newPath = (@($Directory) + $parts) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    }
    if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $Directory.TrimEnd('\') })) {
        $env:Path = "$Directory;$env:Path"
    }
}

function Set-OptionalUserEnvironment([string]$Name, [string]$Value) {
    if ($Value) {
        [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
        [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    } else {
        [Environment]::SetEnvironmentVariable($Name, $null, 'User')
        [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
    }
}

function Set-StartupShortcutCommand($Shortcut, [string]$ServerPath, [string]$WorkingDirectory, [bool]$ServerCommands) {
    $Shortcut.TargetPath = $ServerPath
    $Shortcut.WorkingDirectory = $WorkingDirectory
    $Shortcut.Arguments = if ($ServerCommands) { 'on' } else { '' }
    $Shortcut.Description = 'Start Velron Server when signing in'
    $Shortcut.Save()
}

function Install-StartupShortcut([string]$ServerPath, [string]$WorkingDirectory, [bool]$ServerCommands) {
    $startupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    [IO.Directory]::CreateDirectory($startupDirectory) | Out-Null
    $shortcutPath = Join-Path $startupDirectory 'Velron Server.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    Set-StartupShortcutCommand $shortcut $ServerPath $WorkingDirectory $ServerCommands
    Write-Success 'Registered Velron Server in Startup'
}

function Remove-StartupShortcut {
    $startupDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    $shortcutPath = Join-Path $startupDirectory 'Velron Server.lnk'
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
}

function Invoke-HostCommandSilently([string]$HostName, [string[]]$Arguments) {
    # Host diagnostics may include configured environment variables and tokens.
    $ErrorActionPreference = 'Continue'
    try {
        & $HostName @Arguments *> $null
        return $LASTEXITCODE
    } catch {
        return -1
    }
}

function Install-HostMcp(
    [ValidateSet('codex', 'claude')][string]$HostName,
    [string]$ClientPath,
    [System.Collections.IDictionary]$ClientEnvironment,
    [string]$ConfigPath
) {
    $hostLabel = if ($HostName -eq 'codex') { 'Codex' } else { 'Claude Code' }
    $commandArguments = if ($HostName -eq 'codex') {
        @('mcp', 'add', 'velron')
    } else {
        @('mcp', 'add', '--transport', 'stdio', '--scope', 'user', 'velron')
    }
    $commandText = "$HostName $($commandArguments -join ' ')"
    foreach ($name in $ClientEnvironment.Keys) {
        $commandArguments += @('--env', "$name=$($ClientEnvironment[$name])")
        # Print references to the installed user environment, never its secret values.
        $commandText += ' --env "{0}=$env:{0}"' -f $name
    }
    $commandArguments += @('--', $ClientPath, 'mcp')
    $quotedClientPath = "'" + $ClientPath.Replace("'", "''") + "'"
    $commandText += " -- $quotedClientPath mcp"

    if (-not (Get-Command $HostName -ErrorAction SilentlyContinue)) {
        Write-WarningMessage "$hostLabel CLI was not found. Install it, open a new terminal, and run:"
        Write-Host "  $commandText"
        Write-Info "The equivalent stdio MCP configuration is saved at $ConfigPath"
        return
    }

    if ((Invoke-HostCommandSilently $HostName @('mcp', 'get', '--help')) -ne 0) {
        Write-WarningMessage "Could not inspect $hostLabel MCP settings. Check existing entries, then run:"
        Write-Host "  $commandText"
        return
    }

    if ((Invoke-HostCommandSilently $HostName @('mcp', 'get', 'velron')) -eq 0) {
        Write-WarningMessage "$hostLabel already has a velron MCP entry; it was preserved."
        Write-Host "  Review it with: $HostName mcp get velron"
        if ($HostName -eq 'codex') {
            Write-Host '  To replace that entry, first run: codex mcp remove velron'
        } else {
            Write-Host '  To replace that entry, first run: claude mcp remove velron'
            Write-Host '  Select the existing entry''s scope if prompted.'
        }
        Write-Host '  Then register the new Client with:'
        Write-Host "  $commandText"
        return
    }

    if ((Invoke-HostCommandSilently $HostName $commandArguments) -eq 0) {
        Write-Success "Registered Velron as a stdio MCP server for $hostLabel"
    } else {
        Write-WarningMessage "$hostLabel MCP registration did not finish. Review the host settings, then run:"
        Write-Host "  $commandText"
        Write-Info "The equivalent stdio MCP configuration is saved at $ConfigPath"
    }
}

Write-Host 'Velron installer' -ForegroundColor Blue
Write-Host 'Server, Client, stdio MCP, PATH, and startup setup'

$architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$architectureName = switch ($architecture) {
    'x64' { 'x64' }
    'arm64' { 'arm64' }
    default { throw "Unsupported Windows architecture: $architecture" }
}

if ($NonInteractive) {
    if ($env:VELRON_INSTALL_COMPONENTS -notin @('both', 'server', 'client')) { throw 'Invalid component selection.' }
    $installServer = $env:VELRON_INSTALL_COMPONENTS -in @('both', 'server')
    $installClient = $env:VELRON_INSTALL_COMPONENTS -in @('both', 'client')
    $velronHome = Resolve-AbsolutePath $env:VELRON_INSTALL_HOME
    $installDirectory = Resolve-AbsolutePath $env:VELRON_INSTALL_COMMAND_DIR
    $serverHost = $env:VELRON_INSTALL_SERVER_HOST
    $serverHttpPort = [int]$env:VELRON_INSTALL_HTTP_PORT
    $serverVcpPort = [int]$env:VELRON_INSTALL_VCP_PORT
    if ($serverHttpPort -lt 1 -or $serverHttpPort -gt 65535 -or $serverVcpPort -lt 1 -or $serverVcpPort -gt 65535 -or $serverHttpPort -eq $serverVcpPort) {
        throw 'HTTP and VCP ports must be distinct integers from 1 to 65535.'
    }
    Assert-ServerHost $serverHost
    $serverAllowedHosts = @($env:VELRON_INSTALL_ALLOWED_HOSTS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    foreach ($allowedHost in $serverAllowedHosts) {
        Assert-ServerHost $allowedHost -Allowed
    }
    $keepConfig = Read-GuiBoolean 'KEEP_CONFIG'
    $writeServerConfig = -not ($keepConfig -and (Test-Path -LiteralPath (Join-Path $velronHome 'config.json') -PathType Leaf))
    $enableAutostart = Read-GuiBoolean 'AUTOSTART'
    $startServerNow = Read-GuiBoolean 'START_NOW'
    $vcpMode = $env:VELRON_INSTALL_CONNECTION
    $vcpUrl = "wss://127.0.0.1:$serverVcpPort/vcp/v1"
    $vcpToken = ''
    if ($vcpMode -eq 'remote') {
        $vcpUrl = $env:VELRON_INSTALL_VCP_URL
        Assert-VcpUrl $vcpUrl
        $vcpToken = $env:VELRON_INSTALL_VCP_TOKEN
        if ($vcpToken -notmatch '^[A-Za-z0-9_-]{43}$') { throw 'Invalid VCP access token.' }
    } elseif ($vcpMode -ne 'local') { throw 'Invalid connection mode.' }
    $integrationChoice = switch ($env:VELRON_INSTALL_INTEGRATION) {
        'codex' { 1 }; 'claude' { 2 }; 'both' { 3 }; 'other' { 4 }
        default { throw 'Invalid MCP host selection.' }
    }
} else {
$installChoice = Read-Menu 'What do you want to install?' @('Server and Client', 'Server only', 'Client only')
$installServer = $installChoice -in @(1, 2)
$installClient = $installChoice -in @(1, 3)

$defaultVelronHome = Join-Path $HOME '.velron'
$velronHome = Resolve-AbsolutePath (Read-Value 'Velron data and configuration directory' $defaultVelronHome)
$defaultInstallDirectory = Join-Path $env:LOCALAPPDATA 'Programs\Velron\bin'
$installDirectory = Resolve-AbsolutePath (Read-Value 'Command directory (added to PATH)' $defaultInstallDirectory)

$serverHost = '127.0.0.1'
$serverHttpPort = $defaultHttpPort
$serverVcpPort = $defaultVcpPort
$serverAllowedHosts = @()
$writeServerConfig = $false
$enableAutostart = $false
$startServerNow = $false
if ($installServer) {
    $existingConfigPath = Join-Path $velronHome 'config.json'
    if ((Test-Path -LiteralPath $existingConfigPath -PathType Leaf) -and
        (Read-Confirmation "Keep the existing Server config at $existingConfigPath?" $true)) {
        try {
            $existingConfig = Get-Content -Raw -LiteralPath $existingConfigPath | ConvertFrom-Json
            if ($existingConfig.localVcpPort) { $serverVcpPort = [int]$existingConfig.localVcpPort }
        } catch {
            Write-WarningMessage 'The existing config could not be read by the installer; Velron will validate it when started.'
        }
    } else {
        $writeServerConfig = $true
        $serverHost = Read-Value 'Server bind host' $serverHost
        $serverHttpPort = Read-Port 'Management HTTP port' $serverHttpPort
        $serverVcpPort = Read-Port 'Pinned local VCP port' $serverVcpPort
        if ($serverHttpPort -eq $serverVcpPort) { throw 'HTTP and VCP ports must differ.' }
        $allowedText = Read-Value 'Additional allowed hosts (comma-separated, optional)'
        if ($allowedText) { $serverAllowedHosts = @($allowedText -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    }
    $enableAutostart = Read-Confirmation 'Start Velron Server automatically when you sign in?' $true
    $startServerNow = Read-Confirmation 'Start Velron Server after installation?' $true
}

$vcpMode = 'local'
$vcpUrl = "wss://127.0.0.1:$serverVcpPort/vcp/v1"
$vcpToken = ''
$integrationChoice = 0
if ($installClient) {
    Write-Host ''
    Write-Host 'Client connection' -ForegroundColor White
    Write-Host 'Press Enter to use automatic local discovery. Enter a different wss:// URL for a remote Server.'
    $enteredVcpUrl = Read-Value 'VCP URL' $vcpUrl
    if ($enteredVcpUrl -ne $vcpUrl) {
        Assert-VcpUrl $enteredVcpUrl
        $vcpMode = 'remote'
        $vcpUrl = $enteredVcpUrl
        $vcpToken = Read-SecretValue 'VCP access token'
        if ($vcpToken -notmatch '^[A-Za-z0-9_-]{43}$') {
            throw 'VCP token must be a 43-character base64url value.'
        }
    }
    $integrationChoice = Read-Menu 'Where should Velron Client be connected?' @(
        'Codex',
        'Claude Code',
        'Codex and Claude Code',
        'Other... (generic stdio MCP)'
    )
    Write-Info 'The agent supplies the absolute workspaceDir path in each call_agent invocation.'
}

Write-Host ''
Write-Host 'Installation summary' -ForegroundColor White
$components = if ($installServer -and $installClient) { 'Server + Client' } elseif ($installServer) { 'Server' } else { 'Client' }
Write-Host "  Platform:        windows-$architectureName"
Write-Host "  Components:      $components"
Write-Host "  Velron home:     $velronHome"
Write-Host "  Command path:    $installDirectory"
if ($installClient) { Write-Host "  VCP:             $vcpUrl ($vcpMode)" }
if (-not (Read-Confirmation 'Continue?' $true)) {
    Write-Info 'Installation cancelled.'
    return
}
}

Assert-StateHome $velronHome $installDirectory
if ($installServer -and $writeServerConfig) {
    Assert-ServerHost $serverHost
    if ($serverAllowedHosts.Count -gt 256) { throw 'At most 256 allowed hosts are supported.' }
    foreach ($allowedHost in $serverAllowedHosts) { Assert-ServerHost $allowedHost -Allowed }
}

$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "velron-installer-$([guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
try {
    $checksumsPath = Join-Path $temporaryDirectory 'SHA256SUMS.txt'
    Write-Stage 'download'
    Write-Info 'Downloading release checksums...'
    Invoke-WebRequest -UseBasicParsing -Uri "$latestBaseUrl/SHA256SUMS.txt" -OutFile $checksumsPath
    $serverPath = Join-Path $installDirectory 'velron.exe'
    $clientPath = Join-Path $installDirectory 'velron-client.exe'
    $assets = @()
    if ($installServer) {
        Write-Stage 'server'
        $source = Get-VerifiedAsset "velron-windows-$architectureName.exe" $checksumsPath $temporaryDirectory
        $assets += @{ Source = $source; Destination = $serverPath; Staged = $null; Backup = $null; RetainBackup = $false }
    }
    if ($installClient) {
        Write-Stage 'client'
        $source = Get-VerifiedAsset "velron-client-windows-$architectureName.exe" $checksumsPath $temporaryDirectory
        $assets += @{ Source = $source; Destination = $clientPath; Staged = $null; Backup = $null; RetainBackup = $false }
    }

    Install-StagedAssets $assets
    [IO.Directory]::CreateDirectory($velronHome) | Out-Null

    Write-Stage 'configure'
    [Environment]::SetEnvironmentVariable('VELRON_HOME', $velronHome, 'User')
    [Environment]::SetEnvironmentVariable('VELRON_HOME', $velronHome, 'Process')
    if ($installClient) {
        if ($vcpMode -eq 'remote') {
            Set-OptionalUserEnvironment 'VELRON_VCP_URL' $vcpUrl
            Set-OptionalUserEnvironment 'VELRON_VCP_TOKEN' $vcpToken
        } else {
            Set-OptionalUserEnvironment 'VELRON_VCP_URL' ''
            Set-OptionalUserEnvironment 'VELRON_VCP_TOKEN' ''
            Set-OptionalUserEnvironment 'VELRON_LOCAL_VCP_PORT' ''
        }
    }

    if ($installServer -and $writeServerConfig) {
        $serverConfig = [ordered]@{
            schemaVersion = 1
            host = $serverHost
            port = $serverHttpPort
            localVcpPort = $serverVcpPort
            allowedHosts = $serverAllowedHosts
            managementSecureCookies = $false
            maxConcurrentRuns = 4
            maxRunStartsPerMinute = 60
            maxRunContextBytes = 8388608
        }
        Write-PrivateUtf8File (Join-Path $velronHome 'config.json') (($serverConfig | ConvertTo-Json -Depth 4) + "`n")
    }

    Add-UserPath $installDirectory
    Write-Success 'Added Velron commands to the user PATH'

    if ($installClient) {
        $clientEnvironment = [ordered]@{ VELRON_HOME = $velronHome }
        if ($vcpMode -eq 'local') {
            $clientEnvironment['VELRON_VCP_URL'] = ''
            $clientEnvironment['VELRON_VCP_TOKEN'] = ''
            $clientEnvironment['VELRON_LOCAL_VCP_PORT'] = ''
        }
        Write-Stage 'integrate'
        if ($vcpMode -eq 'remote') {
            $clientEnvironment['VELRON_VCP_URL'] = $vcpUrl
            $clientEnvironment['VELRON_VCP_TOKEN'] = $vcpToken
        }
        $stdioConfig = [ordered]@{
            mcpServers = [ordered]@{
                velron = [ordered]@{
                    type = 'stdio'
                    command = $clientPath
                    args = @('mcp')
                    env = $clientEnvironment
                }
            }
        }
        $stdioConfigPath = Join-Path $velronHome 'stdio-mcp.json'
        Write-PrivateUtf8File $stdioConfigPath (($stdioConfig | ConvertTo-Json -Depth 8) + "`n")
        Write-Success "Wrote generic stdio MCP configuration to $stdioConfigPath"
        switch ($integrationChoice) {
            1 { Install-HostMcp codex $clientPath $clientEnvironment $stdioConfigPath }
            2 { Install-HostMcp claude $clientPath $clientEnvironment $stdioConfigPath }
            3 {
                Install-HostMcp codex $clientPath $clientEnvironment $stdioConfigPath
                Install-HostMcp claude $clientPath $clientEnvironment $stdioConfigPath
            }
            4 {
                Write-Info "Merge the velron entry from $stdioConfigPath into your MCP host settings."
            }
        }
        Write-Info 'If upgrading from the old Plugin, remove its host Plugin and Velron PreToolUse Hook registrations manually, then restart the host.'
        Write-Info 'call_agent accepts workspaceDir as an absolute path on the Client machine; no workspace setup or Hook approval is required.'
    }

    if ($installServer) {
        Write-Stage 'startup'
        $serverCommands = Test-ServerCommands $serverPath
        if ($enableAutostart) {
            Install-StartupShortcut $serverPath $installDirectory $serverCommands
        } else {
            Remove-StartupShortcut
            Write-Info 'Velron Server autostart is disabled'
        }
        if ($startServerNow) {
            if ($serverCommands) {
                Start-ManagedServer $serverPath
                Wait-ServerReady $null $velronHome $serverPath
            } else {
                $startArguments = @{
                    FilePath = $serverPath; WorkingDirectory = $installDirectory; PassThru = $true
                    RedirectStandardOutput = (Join-Path $velronHome 'server.log')
                    RedirectStandardError = (Join-Path $velronHome 'server-error.log')
                }
                if ($NonInteractive) { $startArguments.WindowStyle = 'Hidden' }
                $serverProcess = Start-Process @startArguments
                Wait-ServerReady $serverProcess $velronHome
            }
            Write-Success 'Velron Server is responding and authentication is ready'
            Write-Info "Management token file (private): $(Join-Path $velronHome 'management-token')"
        }
    }
} finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}

Write-Host ''
Write-Success 'Velron installation is complete.'
Write-Stage 'complete'
Write-Host 'Open a new terminal, then run:'
if ($installServer) {
    if ($serverCommands) { Write-Host '  velron on'; Write-Host '  velron status / velron off / velron stream' }
    else { Write-Host '  velron' }
}
if ($installClient) { Write-Host '  velron-client --help' }
if ($installClient) { Write-Host 'Restart your MCP host to load the stdio connection.' }
