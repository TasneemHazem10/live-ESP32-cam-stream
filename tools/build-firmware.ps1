# Compiles the camera firmware and copies the flashable images into the website.
#
#   powershell -File tools/build-firmware.ps1
#
# Needs arduino-cli + the esp32 core + WiFiManager:
#   arduino-cli core install esp32:esp32 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
#   arduino-cli lib install WiFiManager
#
# The sketch is self-contained (PubSubClient + partitions.csv are in its folder),
# so the only outside dependency is WiFiManager.

$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
$sketch = Join-Path $repo 'firmware\esp32cam-wifimanager'
$out = Join-Path $env:TEMP 'mirsad-fw-build'
$dest = Join-Path $repo 'public\firmware'

$cli = (Get-Command arduino-cli -ErrorAction SilentlyContinue).Source
if (-not $cli) { $cli = Join-Path $env:TEMP 'arduino-cli\arduino-cli.exe' }
if (-not (Test-Path $cli)) { throw 'arduino-cli not found.' }

$core = Join-Path $env:LOCALAPPDATA 'Arduino15\packages\esp32\hardware\esp32'
$coreVersion = (Get-ChildItem $core -Directory | Sort-Object Name -Descending | Select-Object -First 1).Name
Write-Host "ESP32 core: $coreVersion"

# partitions.csv in the sketch folder is used automatically, but the core also
# needs PSRAM enabled for the camera buffers.
$fqbn = 'esp32:esp32:esp32:PSRAM=enabled,PartitionScheme=custom,FlashMode=dio,CPUFreq=240,FlashFreq=40'

Write-Host "Compiling $sketch ..."
& $cli compile --fqbn $fqbn --output-dir $out $sketch
if ($LASTEXITCODE -ne 0) { throw 'Compile failed.' }

$map = [ordered]@{
  'esp32cam-wifimanager.ino.bootloader.bin' = 'bootloader.bin'
  'esp32cam-wifimanager.ino.partitions.bin' = 'partitions.bin'
  'esp32cam-wifimanager.ino.bin'            = 'esp32cam-mirsad.bin'
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($src in $map.Keys) {
  $from = Join-Path $out $src
  if (-not (Test-Path $from)) { throw "Missing build output: $from" }
  Copy-Item $from (Join-Path $dest $map[$src]) -Force
  Write-Host ("  {0} -> {1} ({2} KB)" -f $src, $map[$src], [math]::Round((Get-Item $from).Length / 1KB))
}

# boot_app0.bin selects app0 in the otadata partition; it ships with the core.
$bootApp0 = Get-ChildItem (Join-Path $core "$coreVersion\tools\partitions\boot_app0.bin") -ErrorAction SilentlyContinue
if (-not $bootApp0) {
  $bootApp0 = Get-ChildItem $env:LOCALAPPDATA -Filter boot_app0.bin -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
}
if (-not $bootApp0) { throw 'boot_app0.bin not found in the esp32 core.' }
Copy-Item $bootApp0.FullName (Join-Path $dest 'boot_app0.bin') -Force
Write-Host "  boot_app0.bin -> boot_app0.bin"

Write-Host ''
Write-Host 'Done. Commit public/firmware/ and push so /flash.html serves the new image.'
