$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot '../../install.ps1'), [ref]$tokens, [ref]$errors
)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)) {
    Invoke-Expression $definition.Extent.Text
}
# Run the installer's actual initialization, which the adapter/startup tests skip.
$assignment = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -eq '$architectureName'
}, $true)
if (-not $assignment) { throw 'Architecture initialization was not found.' }
if ($env:OS -eq 'Windows_NT') {
    Invoke-Expression $assignment.Extent.Text
    if ($architectureName -notin @('x64', 'arm64')) { throw 'Native architecture detection failed.' }
}

$originalArchitecture = $env:PROCESSOR_ARCHITECTURE
$originalNativeArchitecture = $env:PROCESSOR_ARCHITEW6432
try {
    foreach ($case in @(
        @{ Process = 'AMD64'; Native = $null; Expected = 'x64' }
        @{ Process = 'ARM64'; Native = $null; Expected = 'arm64' }
        @{ Process = 'amd64'; Native = ''; Expected = 'x64' }
        @{ Process = 'arm64'; Native = ' '; Expected = 'arm64' }
        @{ Process = 'x86'; Native = 'AMD64'; Expected = 'x64' }
        @{ Process = 'x86'; Native = 'ARM64'; Expected = 'arm64' }
        @{ Process = 'AMD64'; Native = 'ARM64'; Expected = 'arm64' }
        @{ Process = $null; Native = 'AMD64'; Expected = 'x64' }
    )) {
        $env:PROCESSOR_ARCHITECTURE = $case.Process
        $env:PROCESSOR_ARCHITEW6432 = $case.Native
        Invoke-Expression $assignment.Extent.Text
        if ($architectureName -ne $case.Expected) {
            throw "Wrong asset architecture for process $($case.Process), native $($case.Native): $architectureName"
        }
    }
    foreach ($case in @(
        @{ Process = 'x86'; Native = $null }
        @{ Process = 'ARM'; Native = $null }
        @{ Process = 'IA64'; Native = $null }
        @{ Process = $null; Native = $null }
        @{ Process = 'AMD64'; Native = 'unknown' }
    )) {
        $env:PROCESSOR_ARCHITECTURE = $case.Process
        $env:PROCESSOR_ARCHITEW6432 = $case.Native
        $rejected = $false
        try { Invoke-Expression $assignment.Extent.Text } catch {
            if ($_.Exception.Message -notlike 'Unsupported Windows architecture:*') { throw }
            $rejected = $true
        }
        if (-not $rejected) { throw 'Unsupported Windows architecture was accepted.' }
    }
    Write-Output 'PowerShell syntax, native/emulated x64 and ARM64, and unsupported architecture checks passed.'
} finally {
    $env:PROCESSOR_ARCHITECTURE = $originalArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $originalNativeArchitecture
}
