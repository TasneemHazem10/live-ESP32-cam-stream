# Flashes the built firmware to an ESP32-CAM connected through a USB-TTL adapter.
#
#   powershell -File tools/flash-camera.ps1 -Port COM5
#
# Wire it like this and put the board in boot mode (GPIO0 -> GND, then RST):
#   USB-TTL 5V  -> ESP32-CAM 5V
#   USB-TTL GND -> ESP32-CAM GND
#   USB-TTL TX  -> ESP32-CAM U0RXD
#   USB-TTL RX  -> ESP32-CAM U0TXD
#   ESP32-CAM GPIO0 -> GND   (only while flashing)
#
# Run tools/build-firmware.ps1 first so the .bin files exist.

param(
  [string]$Port = '',
  [int]$Baud = 460800
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$fw = Join-Path $repo 'public\firmware'

foreach ($f in 'bootloader.bin', 'partitions.bin', 'boot_app0.bin', 'esp32cam-mirsad.bin') {
  if (-not (Test-Path (Join-Path $fw $f))) { throw "Missing $f - run tools/build-firmware.ps1 first." }
}

if (-not $Port) {
  $ports = [System.IO.Ports.SerialPort]::GetPortNames()
  if ($ports.Count -eq 0) { throw 'No serial ports found. Plug in the USB-TTL adapter (and install its driver).' }
  $Port = $ports[0]
  Write-Host "Using $Port (pass -Port COMx to choose another)."
}

$esptool = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Arduino15\packages\esp32\tools\esptool*\esptool.exe') -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $esptool) { throw 'esptool.exe not found - install the ESP32 core with arduino-cli first.' }

& $esptool.FullName --chip esp32 --port $Port --baud $Baud --before default_reset --after hard_reset `
  write_flash --flash_mode dio --flash_freq 40m --flash_size 4MB `
  0x1000 (Join-Path $fw 'bootloader.bin') `
  0x8000 (Join-Path $fw 'partitions.bin') `
  0xe000 (Join-Path $fw 'boot_app0.bin') `
  0x10000 (Join-Path $fw 'esp32cam-mirsad.bin')

if ($LASTEXITCODE -ne 0) { throw 'Flashing failed.' }
Write-Host ''
Write-Host 'Flashed. Disconnect GPIO0 from GND, press RST, then open the live page.'
