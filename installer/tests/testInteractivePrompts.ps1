param([string]$InstallerPath = (Join-Path $PSScriptRoot '../../install.ps1'))

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $InstallerPath), [ref]$tokens, [ref]$errors
)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)) {
    Invoke-Expression $definition.Extent.Text
}
$adapter = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.IfStatementAst] -and
    $node.Extent.Text.StartsWith('if ($NonInteractive)') -and
    $node.Extent.Text.Contains('$env:VELRON_INSTALL_COMPONENTS')
}, $true)
if (-not $adapter) { throw 'Interactive input adapter was not found.' }

$NonInteractive = $false
$defaultHttpPort = 4141
$defaultVcpPort = 4143
$architectureName = 'x64'
$fixture = Join-Path ([IO.Path]::GetTempPath()) "velron interactive $([guid]::NewGuid().ToString('N'))"
$commandDirectory = Join-Path $fixture 'commands'
$configPath = Join-Path $fixture 'config.json'
$originalLocalAppData = $env:LOCALAPPDATA
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$env:LOCALAPPDATA = $fixture

function Read-Host {
    param([string]$Prompt)
    $prompts.Add($Prompt)
    if ($answers.Count -eq 0) { throw "Unexpected interactive prompt: $Prompt" }
    return $answers.Dequeue()
}

try {
    foreach ($case in @(
        @{ Choice = '1'; Existing = $true; Keep = $true }
        @{ Choice = '1'; Existing = $true; Keep = $false }
        @{ Choice = '1'; Existing = $false; Keep = $false }
        @{ Choice = '2'; Existing = $true; Keep = $true }
        @{ Choice = '3'; Existing = $true; Keep = $true }
    )) {
        if ($case.Existing) { [IO.File]::WriteAllText($configPath, '{"localVcpPort":5153}') }
        elseif (Test-Path -LiteralPath $configPath) { Remove-Item -LiteralPath $configPath }
        $answers = [Collections.Generic.Queue[string]]::new()
        $prompts = [Collections.Generic.List[string]]::new()
        foreach ($answer in @($case.Choice, $fixture, $commandDirectory)) { $answers.Enqueue($answer) }
        $expectedServer = $case.Choice -in @('1', '2')
        $expectedClient = $case.Choice -in @('1', '3')
        $expectedWriteConfig = $expectedServer -and -not ($case.Existing -and $case.Keep)
        if ($expectedServer) {
            if ($case.Existing) {
                $keepAnswer = if ($case.Keep) { '' } else { 'n' }
                $answers.Enqueue($keepAnswer)
            }
            if ($expectedWriteConfig) {
                foreach ($answer in @('', '5151', '5153', 'example.test')) { $answers.Enqueue($answer) }
            }
            $answers.Enqueue('n') # autostart
            $answers.Enqueue('n') # start now
        }
        if ($expectedClient) {
            $answers.Enqueue('') # default local connection
            $answers.Enqueue('4') # generic MCP configuration
        }
        $answers.Enqueue('y') # continue to installation

        # Execute only input collection, including the real confirmation strings.
        # Downloads, user configuration writes and startup changes are excluded.
        Invoke-Expression $adapter.Extent.Text
        if ($answers.Count -ne 0) { throw 'Not all scripted answers were consumed.' }
        if ($installServer -ne $expectedServer -or $installClient -ne $expectedClient -or
            $writeServerConfig -ne $expectedWriteConfig -or $velronHome -ne $fixture -or
            $installDirectory -ne $commandDirectory -or $enableAutostart -or $startServerNow) {
            throw 'Interactive choices were not mapped correctly.'
        }
        if ($expectedServer -and $serverVcpPort -ne 5153) { throw 'Server VCP port was not preserved or configured.' }
        if ($expectedWriteConfig -and ($serverHttpPort -ne 5151 -or $serverAllowedHosts[0] -ne 'example.test')) {
            throw 'New Server settings were not collected correctly.'
        }
        if ($expectedClient -and ($vcpMode -ne 'local' -or $vcpToken -or $integrationChoice -ne 4)) {
            throw 'Client settings were not collected correctly.'
        }
        $keepPrompt = "Keep the existing Server config at ${configPath}? [Y/n]"
        if ($prompts.Contains($keepPrompt) -ne ($expectedServer -and $case.Existing)) {
            throw 'Existing-config confirmation did not include the exact path and question mark.'
        }
        if ($case.Existing -and [IO.File]::ReadAllText($configPath) -ne '{"localVcpPort":5153}') {
            throw 'Input collection changed the existing configuration.'
        }
    }
    Write-Output 'Interactive prompts, existing/new config, Server-only and Client-only choices passed.'
} finally {
    Remove-Item Function:\Read-Host
    $env:LOCALAPPDATA = $originalLocalAppData
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
