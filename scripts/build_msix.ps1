<#
.SYNOPSIS
  Packages the Tauri v2 release binary + sidecars + Thai fonts + Store logos into a Microsoft Store-ready .MSIX package.
  Microsoft Partner Center signs the .MSIX automatically upon ingestion ($0 code signing).
#>
param(
  [string]$Version = "1.11.0.0",
  [string]$IdentityName = "AutoSubAIDesktopProStudio.AutoSubAIDesktopProStudi",
  [string]$Publisher = "CN=D843CECA-99DD-4DF2-B1CA-3183C4431187",
  [string]$PublisherDisplayName = "AutoSubAI Desktop Pro Studio",
  [string]$DisplayName = "AutoSubAI Desktop Pro Studio",
  [string]$OutDir = "release_files"
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Stage = Join-Path $Root "msix_stage"
$AssetsDir = Join-Path $Stage "Assets"
$ResDir = Join-Path $Stage "resources"
$OutPath = Join-Path $Root $OutDir

if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $AssetsDir | Out-Null
New-Item -ItemType Directory -Force -Path $ResDir | Out-Null
New-Item -ItemType Directory -Force -Path $OutPath | Out-Null

# 1. Copy main Tauri executable (built with --features ms-store)
$ExeSrc = Join-Path $Root "src-tauri\target\release\autosubai-desktop.exe"
if (-not (Test-Path $ExeSrc)) {
  $ExeSrc = Join-Path $Root "src-tauri\target\release\AutoSubAI.exe"
}
if (-not (Test-Path $ExeSrc)) { throw "Release exe not found in src-tauri\target\release" }
Copy-Item $ExeSrc (Join-Path $Stage "AutoSubAI.exe") -Force

# Copy WebView2Loader.dll if emitted alongside release exe
$Wv2 = Join-Path $Root "src-tauri\target\release\WebView2Loader.dll"
if (Test-Path $Wv2) { Copy-Item $Wv2 (Join-Path $Stage "WebView2Loader.dll") -Force }

# 2. Copy bundled sidecar binaries (FFmpeg 6.1.1 + whisper-cli Vulkan GPU)
$FfmpegSrc = Join-Path $Root "src-tauri\binaries\ffmpeg-x86_64-pc-windows-msvc.exe"
$WhisperSrc = Join-Path $Root "src-tauri\binaries\whisper-cli-x86_64-pc-windows-msvc.exe"
if (-not (Test-Path $FfmpegSrc)) { throw "FFmpeg sidecar missing: $FfmpegSrc" }
if (-not (Test-Path $WhisperSrc)) { throw "whisper-cli sidecar missing: $WhisperSrc" }
Copy-Item $FfmpegSrc (Join-Path $Stage "ffmpeg.exe") -Force
Copy-Item $WhisperSrc (Join-Path $Stage "whisper-cli.exe") -Force

# 3. Copy Thai fonts + MIT third-party licenses
Copy-Item (Join-Path $Root "src-tauri\resources\*") $ResDir -Recurse -Force

# 4. Generate exact-pixel Microsoft Store PNG visual assets from icon-source.png
Add-Type -AssemblyName System.Drawing
$IconSource = Join-Path $Root "icon-source.png"
if (-not (Test-Path $IconSource)) { throw "icon-source.png missing: $IconSource" }
$SrcImg = [System.Drawing.Image]::FromFile($IconSource)

function Save-ScaledPng([string]$DestPath, [int]$W, [int]$H, [bool]$PadWide = $false) {
  $bmp = New-Object System.Drawing.Bitmap($W, $H, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  if ($PadWide) {
    $side = [Math]::Min($W, $H) - 20
    $x = [int](($W - $side) / 2)
    $y = [int](($H - $side) / 2)
    $g.DrawImage($SrcImg, $x, $y, $side, $side)
  } else {
    $g.DrawImage($SrcImg, 0, 0, $W, $H)
  }
  $g.Dispose()
  $bmp.Save($DestPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Save-ScaledPng (Join-Path $AssetsDir "StoreLogo.png")       50  50  $false
Save-ScaledPng (Join-Path $AssetsDir "Square44x44Logo.png") 44  44  $false
Save-ScaledPng (Join-Path $AssetsDir "Square71x71Logo.png") 71  71  $false
Save-ScaledPng (Join-Path $AssetsDir "Square150x150Logo.png") 150 150 $false
Save-ScaledPng (Join-Path $AssetsDir "Square310x310Logo.png") 310 310 $false
Save-ScaledPng (Join-Path $AssetsDir "Wide310x150Logo.png") 310 150 $true
$SrcImg.Dispose()

# 5. Write AppxManifest.xml with exact Microsoft Partner Center Product Identity
$ManifestXml = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity
    Name="$IdentityName"
    Publisher="$Publisher"
    Version="$Version"
    ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>$DisplayName</DisplayName>
    <PublisherDisplayName>$PublisherDisplayName</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="th-TH" />
    <Resource Language="en-US" />
  </Resources>
  <Applications>
    <Application
      Id="AutoSubAIDesktop"
      Executable="AutoSubAI.exe"
      EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="$DisplayName"
        Description="Thai AI Subtitles, Unlimited Free Built-in Offline Transcription, Confidential Meeting Minutes and Pro Video Finishing Studio."
        BackgroundColor="transparent"
        Square150x150Logo="Assets\Square150x150Logo.png"
        Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile
          Wide310x150Logo="Assets\Wide310x150Logo.png"
          Square310x310Logo="Assets\Square310x310Logo.png"
          Square71x71Logo="Assets\Square71x71Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@

$ManifestPath = Join-Path $Stage "AppxManifest.xml"
[System.IO.File]::WriteAllText($ManifestPath, $ManifestXml, (New-Object System.Text.UTF8Encoding($false)))

# 6. Locate Windows SDK makeappx.exe and pack .MSIX
$MakeAppx = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' } |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $MakeAppx) { throw "Windows SDK makeappx.exe not found on runner" }
Write-Host "Using makeappx: $MakeAppx"

$MsixFile = Join-Path $OutPath "AutoSubAI_${Version}_x64_MicrosoftStore.msix"
& $MakeAppx pack /d $Stage /p $MsixFile /o
if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed with code $LASTEXITCODE" }

Get-Item $MsixFile | Select-Object Name, @{N='SizeMB';E={[Math]::Round($_.Length/1MB,2)}}
Remove-Item -Recurse -Force $Stage
