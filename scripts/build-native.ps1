$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x compiler is required (included with Windows).' }

# Convert the supplied sprite into a multi-resolution ICO, without changing the artwork.
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile((Join-Path $root 'sprites\notify-paul-icon.png'))
$images = @()
try {
    foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
        $bitmap = New-Object System.Drawing.Bitmap($size, $size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $scale = [Math]::Min($size / $source.Width, $size / $source.Height)
        $width = [int]($source.Width * $scale)
        $height = [int]($source.Height * $scale)
        $graphics.DrawImage($source, [int](($size - $width) / 2), [int](($size - $height) / 2), $width, $height)
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += ,@{ Size = $size; Bytes = $stream.ToArray() }
        $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
} finally { $source.Dispose() }
$iconPath = Join-Path $root 'sprites\notify-paul.ico'
$file = [System.IO.File]::Create($iconPath)
$writer = New-Object System.IO.BinaryWriter($file)
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($image in $images) {
        $dimension = if ($image.Size -eq 256) { 0 } else { $image.Size }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$image.Bytes.Length); $writer.Write([uint32]$offset)
        $offset += $image.Bytes.Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image.Bytes) }
} finally { $writer.Dispose(); $file.Dispose() }
Copy-Item -LiteralPath $iconPath -Destination (Join-Path $output 'notify-paul.ico') -Force
$executable = Join-Path $output 'NotifyPaul.exe'
& $compiler /nologo /target:winexe /optimize+ "/out:$executable" "/win32icon:$iconPath" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.Management.dll (Join-Path $root 'native\NotifyPaul.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
# Version managers such as fnm expose node.exe through per-shell links that disappear later.
$nodeFile = Get-Item -LiteralPath $nodePath
$nodeDirectory = Get-Item -LiteralPath (Split-Path -Parent $nodePath)
if ($nodeFile.LinkType -and $nodeFile.Target) {
    $nodePath = [string]@($nodeFile.Target)[0]
    if (-not [System.IO.Path]::IsPathRooted($nodePath)) { $nodePath = Join-Path $nodeDirectory.FullName $nodePath }
} elseif ($nodeDirectory.LinkType -and $nodeDirectory.Target) {
    $nodePath = Join-Path ([string]@($nodeDirectory.Target)[0]) $nodeFile.Name
}
$nodePath = [System.IO.Path]::GetFullPath($nodePath)
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Node.js executable could not be resolved.' }
[System.IO.File]::WriteAllText((Join-Path $output 'node-path.txt'), $nodePath, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'Windows helper and sprite icon built.'
