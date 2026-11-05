$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions
$assembly = [Reflection.Assembly]::LoadFrom((Join-Path $root 'build\NotifyPaul.exe'))
$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$json = '{"tooltip":"NotifyPaul","items":[{"id":"channel:telegram","text":"Telegram","checked":true},{"id":"autostart","text":"Autostart","checked":false,"enabled":false}]}'
$menu = $serializer.Deserialize($json, $assembly.GetType('MenuModel'))
if ($menu.items.Length -ne 2 -or -not $menu.items[0].checked -or $menu.items[1].enabled) { throw 'Native menu protocol failed.' }
$icon = New-Object System.Drawing.Icon((Join-Path $root 'build\notify-paul.ico'), 32, 32)
try { if ($icon.Width -ne 32 -or $icon.Height -ne 32) { throw 'Native icon invalid.' } } finally { $icon.Dispose() }
foreach ($name in @('build-native.ps1', 'install.ps1', 'uninstall.ps1')) {
    $tokens = $null; $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw "PowerShell syntax invalid: $name" }
}
$bytes = [System.IO.File]::ReadAllBytes((Join-Path $root 'build\NotifyPaul.exe'))
$pe = [BitConverter]::ToInt32($bytes, 0x3c)
$subsystem = [BitConverter]::ToUInt16($bytes, $pe + 24 + 68)
if ($subsystem -ne 2) { throw 'Helper is not a Windows GUI executable (would show a console).' }
Write-Output 'Native protocol, 32px sprite icon, GUI subsystem and installation-script syntax passed.'
