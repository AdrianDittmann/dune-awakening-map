param([string]$Out = (Join-Path $PSScriptRoot '..\release'))
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Push-Location (Join-Path $root 'app')
pnpm build
$failed = $LASTEXITCODE
Pop-Location
if ($failed) { throw 'Web app build failed' }
Push-Location (Join-Path $root 'launcher')
cargo build --release
$failed = $LASTEXITCODE
Pop-Location
if ($failed) { throw 'Launcher build failed' }

$name = 'Dune-Awakening-Map'
New-Item -ItemType Directory -Force $Out -ErrorAction Stop | Out-Null
$stage = Join-Path $Out $name
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction Stop }
New-Item -ItemType Directory -Force (Join-Path $stage 'app') -ErrorAction Stop | Out-Null
Copy-Item (Join-Path $root 'app\dist\*') (Join-Path $stage 'app') -Recurse -ErrorAction Stop
Remove-Item (Join-Path $stage 'app\page.html') -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root 'launcher\target\release\dune-awakening-map.exe') (Join-Path $stage 'Dune Awakening Map.exe') -ErrorAction Stop
Copy-Item (Join-Path $root 'LICENSE') $stage -ErrorAction Stop

$zip = Join-Path $Out "$name-windows.zip"
if (Test-Path $zip) { Remove-Item $zip -ErrorAction Stop }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal -ErrorAction Stop
Get-Item $zip | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
