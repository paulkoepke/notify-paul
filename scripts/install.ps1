$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
    & (Join-Path $PSScriptRoot 'build-native.ps1')
    $starter = Join-Path $root 'build\NotifyPaul.exe'
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $desktop 'NotifyPaul.lnk'))
    $shortcut.TargetPath = $starter
    $shortcut.Arguments = '--start'
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = (Join-Path $root 'build\notify-paul.ico')
    $shortcut.Save()
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name NotifyPaul -PropertyType String -Value ('"' + $starter + '" --start') -Force | Out-Null
    Write-Output 'Installed. Configure .env, then start NotifyPaul from the desktop.'
} finally { Pop-Location }
