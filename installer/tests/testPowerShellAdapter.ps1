$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$installerPath = Join-Path $PSScriptRoot '../../install.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $installerPath), [ref]$tokens, [ref]$errors
)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }

# Load the real input adapter and pure helper functions, without running the installer.
$definitions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($definition in $definitions) { Invoke-Expression $definition.Extent.Text }
$adapter = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Extent.Text.StartsWith('if ($NonInteractive)') -and
    $node.Extent.Text.Contains('$env:VELRON_INSTALL_COMPONENTS')
}, $true)
if (-not $adapter) { throw 'Non-interactive adapter was not found.' }
$NonInteractive = $true
$fixture = Join-Path ([IO.Path]::GetTempPath()) "velron-adapter-$([guid]::NewGuid().ToString('N'))"
$originalEnvironment = @{}
$values = @{
    COMPONENTS = 'both'; HOME = $fixture; COMMAND_DIR = (Join-Path $fixture 'commands')
    SERVER_HOST = '127.0.0.1'; HTTP_PORT = '5151'; VCP_PORT = '5153'; ALLOWED_HOSTS = 'example.com, 192.168.1.5'
    KEEP_CONFIG = 'true'; AUTOSTART = 'false'; START_NOW = 'false'; CONNECTION = 'remote'
    VCP_URL = 'wss://example.com:4141/vcp/v1'; VCP_TOKEN = ('a' * 43); INTEGRATION = 'both'
}
try {
    foreach ($key in $values.Keys) {
        $name = "VELRON_INSTALL_$key"
        $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
        [Environment]::SetEnvironmentVariable($name, $values[$key], 'Process')
    }
    Invoke-Expression $adapter.Extent.Text
    if (-not $installServer -or -not $installClient -or $serverHttpPort -ne 5151 -or $serverVcpPort -ne 5153 -or
        $integrationChoice -ne 3 -or $vcpToken.Length -ne 43 -or $vcpMode -ne 'remote' -or
        $serverAllowedHosts.Count -ne 2 -or $enableAutostart -or $startServerNow -or -not $writeServerConfig) {
        throw 'GUI settings were not faithfully mapped to the installation engine.'
    }
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture 'config.json'), '{}')
    $env:VELRON_INSTALL_COMPONENTS = 'client'
    $env:VELRON_INSTALL_CONNECTION = 'local'
    Invoke-Expression $adapter.Extent.Text
    if ($installServer -or -not $installClient -or $vcpToken -or $writeServerConfig) { throw 'Client/local/preserve mapping failed.' }
    $env:VELRON_INSTALL_COMPONENTS = 'invalid'
    $rejected = $false
    try { Invoke-Expression $adapter.Extent.Text } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid component input was accepted.' }
    foreach ($hostValue in @('[::1]', 'localhost:4141', 'invalid_host', '2001:::1')) {
        $rejected = $false
        try { Assert-ServerHost $hostValue } catch { $rejected = $true }
        if (-not $rejected) { throw "Invalid bind host accepted: $hostValue" }
    }
    foreach ($hostValue in @('127.0.0.1', 'example.test', '::1', '2001:db8::1')) { Assert-ServerHost $hostValue }
    Assert-ServerHost '[::1]' -Allowed
    if ($env:OS -eq 'Windows_NT') {
        foreach ($statePath in @($HOME, 'D:\Velron', '\\server\share\Velron')) {
            $rejected = $false
            try { Assert-StateHome $statePath (Join-Path $HOME 'commands') } catch { $rejected = $true }
            if (-not $rejected) { throw "Invalid Windows state directory accepted: $statePath" }
        }
        Assert-StateHome (Join-Path $HOME '.velron-test-dedicated') (Join-Path $HOME 'commands')
    }

    # Use the actual transaction helper with a synthetic second-swap failure.
    $stageFixture = Join-Path $fixture 'transaction'
    [IO.Directory]::CreateDirectory($stageFixture) | Out-Null
    $assets = @()
    foreach ($component in @('server', 'client')) {
        $source = Join-Path $stageFixture "$component.download"
        $destination = Join-Path $stageFixture "$component.exe"
        [IO.File]::WriteAllText($source, "new-$component")
        [IO.File]::WriteAllText($destination, "old-$component")
        $assets += @{ Source = $source; Destination = $destination; Staged = $null; Backup = $null; RetainBackup = $false }
    }
    function Move-Item {
        param([string]$LiteralPath, [string]$Destination, [switch]$Force)
        if ((Split-Path -Leaf $LiteralPath) -like 'client.exe.new.*') { throw 'Synthetic second swap failure' }
        Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
    }
    try {
        $rejected = $false
        try { Install-StagedAssets $assets } catch { $rejected = $true }
        if (-not $rejected) { throw 'Synthetic swap failure was not surfaced.' }
        foreach ($component in @('server', 'client')) {
            if ([IO.File]::ReadAllText((Join-Path $stageFixture "$component.exe")) -ne "old-$component") {
                throw "Transaction failed to restore $component."
            }
        }
        if (@(Get-ChildItem -LiteralPath $stageFixture | Where-Object { $_.Name -match '\.(new|previous)\.' }).Count -ne 0) {
            throw 'Transaction left staging or backup files after successful rollback.'
        }
    } finally { Remove-Item Function:\Move-Item }
    Write-Output 'PowerShell syntax, GUI settings, local mode, config preservation, and invalid input checks passed.'
} finally {
    foreach ($name in $originalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
