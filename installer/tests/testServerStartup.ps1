$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot '../../install.ps1'), [ref]$tokens, [ref]$errors
)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    Invoke-Expression $definition.Extent.Text
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) "velron startup 'quotes $([guid]::NewGuid().ToString('N'))"
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$originalMode = $env:VELRON_TEST_STARTUP_MODE
try {
    $source = Join-Path $fixture 'fixture.cs'
    $serverPath = Join-Path $fixture 'velron.exe'
    [IO.File]::WriteAllText($source, @'
using System;
class Fixture {
    static int Main(string[] args) {
        string mode = Environment.GetEnvironmentVariable("VELRON_TEST_STARTUP_MODE");
        if (mode == "timeout") System.Threading.Thread.Sleep(10000);
        if (args.Length != 1) return 99;
        if (args[0] == "--help") {
            if (mode == "help-failure") return 7;
            Console.WriteLine(mode == "legacy" ? "Usage: velron" : "Usage: velron [on|off|status|stream|run]");
        } else if (args[0] == "on") {
            if (mode == "on-failure") return 17;
            Console.WriteLine("Management: http://localhost/?token=synthetic-private-token");
        } else if (args[0] == "status") {
            Console.WriteLine(mode == "stopped" ? "Velron is not running." : "Velron is running (background, PID 123).");
            Console.WriteLine("Management: http://localhost/?token=synthetic-private-token");
        } else return 98;
        return 0;
    }
}
'@)
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    & $compiler /nologo /target:exe "/out:$serverPath" $source
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the native CLI fixture.' }
    $env:VELRON_TEST_STARTUP_MODE = 'modern'
    if (-not (Test-ServerCommands $serverPath)) { throw 'Modern commands were not detected.' }
    $output = Start-ManagedServer $serverPath | Out-String
    if ($output.Contains('synthetic-private-token')) { throw 'Private Management URL leaked into installation output.' }
    $env:VELRON_TEST_STARTUP_MODE = 'legacy'
    if (Test-ServerCommands $serverPath) { throw 'Legacy release was mistaken for a modern CLI.' }
    foreach ($mode in @('on-failure', 'stopped', 'help-failure')) {
        $env:VELRON_TEST_STARTUP_MODE = $mode
        $rejected = $false
        try {
            if ($mode -eq 'help-failure') { Test-ServerCommands $serverPath | Out-Null }
            else { Start-ManagedServer $serverPath }
        } catch {
            $rejected = $true
            if ($_.ToString().Contains('synthetic-private-token')) { throw 'Private Management URL leaked in an error.' }
        }
        if (-not $rejected) { throw "Startup incorrectly accepted $mode." }
    }
    $env:VELRON_TEST_STARTUP_MODE = 'timeout'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $rejected = $false
    try { Invoke-ServerCommand $serverPath '--help' 1 | Out-Null } catch { $rejected = $true }
    if (-not $rejected -or $clock.Elapsed.TotalSeconds -ge 5) { throw 'Command timeout was not bounded.' }

    # Exercise a real shortcut in the fixture directory, without changing user Startup.
    $shell = New-Object -ComObject WScript.Shell
    $shortcutPath = Join-Path $fixture 'Velron Server.lnk'
    foreach ($modern in @($false, $true, $false)) {
        Set-StartupShortcutCommand ($shell.CreateShortcut($shortcutPath)) $serverPath $fixture $modern
        $saved = $shell.CreateShortcut($shortcutPath)
        $expectedArguments = if ($modern) { 'on' } else { '' }
        if ($saved.TargetPath -ne $serverPath -or $saved.WorkingDirectory -ne $fixture -or $saved.Arguments -ne $expectedArguments) {
            throw 'Startup shortcut did not preserve the executable path and replace its arguments.'
        }
    }
    Write-Output 'Native CLI compatibility, startup status, timeout, private output, and shortcut migration checks passed.'
} finally {
    $env:VELRON_TEST_STARTUP_MODE = $originalMode
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
