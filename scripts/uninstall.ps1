$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Get-ItemProperty -Path $key -Name NotifyPaul -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $key -Name NotifyPaul
}
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'NotifyPaul.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
Write-Output 'Autostart and shortcut removed. Exit NotifyPaul from the tray. Configuration, logs and channel selection are preserved.'
