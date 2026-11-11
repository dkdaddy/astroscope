<#
.SYNOPSIS
  Write a disk image (e.g. astroscope-usb.img) to a USB stick using only
  built-in Windows PowerShell. Run from an Administrator PowerShell.

.EXAMPLE
  .\write-usb.ps1                          # lists USB disks, then asks
  .\write-usb.ps1 -DiskNumber 2 -Image C:\Users\me\astroscope-usb.img
#>
param(
  [int]$DiskNumber = -1,
  [string]$Image = (Join-Path $env:USERPROFILE 'astroscope-usb.img'),
  # Only compare the stick with the image; do not write.
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'

function Copy-ImageToDevice([string]$Source, [string]$Target, [long]$Length) {
  $buf = New-Object byte[] (4MB)
  $in = [IO.File]::OpenRead($Source)
  $out = New-Object IO.FileStream($Target, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite, 4MB, [IO.FileOptions]::WriteThrough)
  try {
    $done = 0L
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      if ($n % 512) { throw "Image size is not a multiple of 512 bytes" }
      $out.Write($buf, 0, $n)
      $done += $n
      Write-Progress -Activity "Writing $Source" -Status ("{0:N0} / {1:N0} MB" -f ($done / 1MB), ($Length / 1MB)) -PercentComplete ($done * 100 / $Length)
    }
    $out.Flush()
  } finally { $in.Close(); $out.Close(); Write-Progress -Activity 'Writing' -Completed }
}

function Get-PrefixHash([string]$Path, [long]$Length) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $buf = New-Object byte[] (4MB)
  $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite, 4MB)
  try {
    $left = $Length
    while ($left -gt 0) {
      $want = [int][Math]::Min($buf.Length, $left)
      $n = $fs.Read($buf, 0, $want)
      if ($n -le 0) { throw "Unexpected end of $Path" }
      [void]$sha.TransformBlock($buf, 0, $n, $null, 0)
      $left -= $n
      Write-Progress -Activity "Verifying" -PercentComplete (($Length - $left) * 100 / $Length)
    }
    [void]$sha.TransformFinalBlock($buf, 0, 0)
    -join ($sha.Hash | ForEach-Object { $_.ToString('x2') })
  } finally { $fs.Close(); Write-Progress -Activity 'Verifying' -Completed }
}

if (-not (Test-Path $Image)) { throw "Image not found: $Image" }
$imgLen = (Get-Item $Image).Length

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run this from an Administrator PowerShell (right-click Windows Terminal > Run as administrator)." }

$usb = @(Get-Disk | Where-Object { $_.BusType -eq 'USB' -and -not $_.IsBoot -and -not $_.IsSystem })
if ($usb.Count -eq 0) { throw "No USB disks found. Plug in the stick and try again." }

$usb | Select-Object Number, FriendlyName, @{n = 'SizeGB'; e = { [math]::Round($_.Size / 1GB, 1) } }, PartitionStyle | Format-Table -AutoSize | Out-Host

if ($DiskNumber -lt 0) { $DiskNumber = [int](Read-Host 'Disk number of the USB stick to ERASE') }
$disk = $usb | Where-Object Number -eq $DiskNumber
if (-not $disk) { throw "Disk $DiskNumber is not one of the USB disks listed above; refusing." }
if ($disk.Size -lt $imgLen) { throw "Disk $DiskNumber is smaller than the image." }
$dev = "\\.\PhysicalDrive$DiskNumber"

if ($VerifyOnly) {
  Write-Host 'Comparing stick with image...'
  $a = Get-PrefixHash $Image $imgLen
  $b = Get-PrefixHash $dev $imgLen
  if ($a -eq $b) { Write-Host 'MATCH: the stick is identical to the image.' -ForegroundColor Green }
  else { Write-Host 'MISMATCH: the stick differs from the image.' -ForegroundColor Red }
  return
}

Write-Host ("ALL DATA on disk {0} ({1}, {2:N1} GB) will be destroyed." -f $disk.Number, $disk.FriendlyName, ($disk.Size / 1GB)) -ForegroundColor Yellow
if ((Read-Host "Type the disk number ($DiskNumber) again to continue") -ne "$DiskNumber") { throw 'Aborted.' }

# Remove partitions so Windows has no mounted volume on the stick.
if ($disk.PartitionStyle -ne 'RAW') { Clear-Disk -Number $DiskNumber -RemoveData -RemoveOEM -Confirm:$false }
Set-Disk -Number $DiskNumber -IsReadOnly $false -ErrorAction SilentlyContinue

Copy-ImageToDevice $Image $dev $imgLen

Write-Host 'Verifying...'
$a = Get-PrefixHash $Image $imgLen
$b = Get-PrefixHash $dev $imgLen
if ($a -ne $b) { throw "VERIFY FAILED: the stick does not match the image. Try again or use another stick." }
Write-Host "Done and verified. Eject the stick and boot the mini PC from it." -ForegroundColor Green
