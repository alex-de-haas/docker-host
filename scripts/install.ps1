#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Start,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$DefaultRepo = "alex-de-haas/docker-host"
$DefaultTag = "cli-dev"

function Fail {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Error "hosty install: $Message"
    exit 1
}

function Show-Usage {
    @"
Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 [-Start]
  pwsh -NoProfile -File scripts/install.ps1 [-Start]

Remote install:
  irm https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.ps1 | iex

Environment overrides:
  HOSTY_INSTALL_REPO              GitHub repository, default alex-de-haas/docker-host
  HOSTY_INSTALL_TAG               GitHub Release tag, default cli-dev
  HOSTY_INSTALL_DIR               Directory for hosty.exe, default %USERPROFILE%\.hosty\bin
  HOSTY_INSTALL_SKIP_PATH_UPDATE  Set to 1 to skip user PATH updates
  HOSTY_INSTALL_START             Set to 1 to run hosty start and open after install
"@ | Write-Host
}

function Test-Windows {
    return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT
}

function Get-HomeDirectory {
    $homeDirectory = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::UserProfile)
    if ([string]::IsNullOrWhiteSpace($homeDirectory)) {
        $homeDirectory = $env:USERPROFILE
    }

    if ([string]::IsNullOrWhiteSpace($homeDirectory)) {
        Fail "USERPROFILE is not set."
    }

    return [System.IO.Path]::GetFullPath($homeDirectory)
}

function Get-NormalizedPathEntry {
    param([Parameter(Mandatory = $true)][string]$PathValue)

    $trimChars = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    try {
        return [System.IO.Path]::GetFullPath($PathValue.Trim()).TrimEnd($trimChars)
    }
    catch {
        return $PathValue.Trim().TrimEnd($trimChars)
    }
}

function Test-PathListContains {
    param(
        [AllowNull()][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$Directory
    )

    if ([string]::IsNullOrWhiteSpace($PathValue)) {
        return $false
    }

    $normalizedDirectory = Get-NormalizedPathEntry $Directory
    foreach ($entry in $PathValue.Split([System.IO.Path]::PathSeparator)) {
        if ([string]::IsNullOrWhiteSpace($entry)) {
            continue
        }

        $normalizedEntry = Get-NormalizedPathEntry $entry
        if ([string]::Equals($normalizedEntry, $normalizedDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Invoke-Download {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $parameters = @{
        Uri = $Url
        OutFile = $Destination
        ErrorAction = "Stop"
    }

    $command = Get-Command Invoke-WebRequest
    if ($command.Parameters.ContainsKey("UseBasicParsing")) {
        $parameters["UseBasicParsing"] = $true
    }

    Invoke-WebRequest @parameters
}

function Get-ExpectedSha256 {
    param(
        [Parameter(Mandatory = $true)][string]$ChecksumsPath,
        [Parameter(Mandatory = $true)][string]$ArtifactName
    )

    foreach ($line in Get-Content -LiteralPath $ChecksumsPath) {
        $parts = $line -split "\s+"
        if ($parts.Length -lt 2) {
            continue
        }

        $name = $parts[$parts.Length - 1].TrimStart("*")
        if ([string]::Equals($name, $ArtifactName, [System.StringComparison]::Ordinal)) {
            return $parts[0].ToLowerInvariant()
        }
    }

    return $null
}

function Install-Executable {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Target
    )

    $targetDirectory = Split-Path -Parent $Target
    New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null

    $targetTemp = "$Target.tmp.$PID"
    Copy-Item -LiteralPath $Source -Destination $targetTemp -Force

    if (-not (Test-Path -LiteralPath $Target)) {
        Move-Item -LiteralPath $targetTemp -Destination $Target
        return
    }

    $backupPath = "$Target.bak"
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $Target -Destination $backupPath -Force

    try {
        Move-Item -LiteralPath $targetTemp -Destination $Target
    }
    catch {
        if ((-not (Test-Path -LiteralPath $Target)) -and (Test-Path -LiteralPath $backupPath)) {
            Move-Item -LiteralPath $backupPath -Destination $Target -Force
        }

        throw
    }

    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
}

function Ensure-UserPath {
    param([Parameter(Mandatory = $true)][string]$InstallDirectory)

    if ($env:HOSTY_INSTALL_SKIP_PATH_UPDATE -eq "1") {
        Write-Host ""
        Write-Host "Skipping user PATH update because HOSTY_INSTALL_SKIP_PATH_UPDATE=1."
        Write-Host "Add hosty to your PATH:"
        Write-Host "  $InstallDirectory"
        return
    }

    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if (Test-PathListContains -PathValue $userPath -Directory $InstallDirectory) {
        Write-Host ""
        Write-Host "hosty PATH entry is already configured for the current user."
    }
    else {
        if ([string]::IsNullOrWhiteSpace($userPath)) {
            $newUserPath = $InstallDirectory
        }
        else {
            $newUserPath = $userPath.TrimEnd([System.IO.Path]::PathSeparator) + [System.IO.Path]::PathSeparator + $InstallDirectory
        }

        [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
        Write-Host ""
        Write-Host "Added hosty to the current user's PATH."
        Write-Host "Open a new terminal for the PATH update to take effect."
    }

    if (-not (Test-PathListContains -PathValue $env:Path -Directory $InstallDirectory)) {
        $env:Path = $InstallDirectory + [System.IO.Path]::PathSeparator + $env:Path
    }
}

function Invoke-Hosty {
    param(
        [Parameter(Mandatory = $true)][string]$HostyPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $HostyPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        Fail "hosty $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

if ($Help) {
    Show-Usage
    exit 0
}

if (-not (Test-Windows)) {
    Fail "unsupported OS. Windows installer supports Windows only."
}

$architecture = if (-not [string]::IsNullOrWhiteSpace($env:PROCESSOR_ARCHITEW6432)) {
    $env:PROCESSOR_ARCHITEW6432
}
else {
    $env:PROCESSOR_ARCHITECTURE
}

if ($architecture -notin @("AMD64", "x86_64")) {
    Fail "unsupported architecture '$architecture'. Windows release assets are published for x64 only."
}

try {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
}
catch {
    # PowerShell 7+ does not require this for GitHub downloads.
}

$homeDirectory = Get-HomeDirectory
$repo = if ([string]::IsNullOrWhiteSpace($env:HOSTY_INSTALL_REPO)) { $DefaultRepo } else { $env:HOSTY_INSTALL_REPO }
$tag = if ([string]::IsNullOrWhiteSpace($env:HOSTY_INSTALL_TAG)) { $DefaultTag } else { $env:HOSTY_INSTALL_TAG }
$installDirectory = if ([string]::IsNullOrWhiteSpace($env:HOSTY_INSTALL_DIR)) {
    Join-Path (Join-Path $homeDirectory ".hosty") "bin"
}
else {
    $env:HOSTY_INSTALL_DIR
}

if ([string]::IsNullOrWhiteSpace($repo)) {
    Fail "HOSTY_INSTALL_REPO cannot be empty."
}

if ([string]::IsNullOrWhiteSpace($tag)) {
    Fail "HOSTY_INSTALL_TAG cannot be empty."
}

if ([string]::IsNullOrWhiteSpace($installDirectory)) {
    Fail "HOSTY_INSTALL_DIR cannot be empty."
}

$pathSeparator = [string][System.IO.Path]::PathSeparator
if ($installDirectory.Contains("`n") -or $installDirectory.Contains("`r") -or $installDirectory.Contains($pathSeparator)) {
    Fail "HOSTY_INSTALL_DIR cannot contain a newline or PATH separator."
}

$installDirectory = [System.IO.Path]::GetFullPath($installDirectory)
$artifact = "hosty-windows-x64.exe"
$baseUrl = "https://github.com/$repo/releases/download/$tag"
$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "hosty-install-$([System.Guid]::NewGuid().ToString('N'))"
$target = Join-Path $installDirectory "hosty.exe"
$startAfterInstall = $Start.IsPresent -or $env:HOSTY_INSTALL_START -eq "1"

New-Item -ItemType Directory -Path $tempDirectory | Out-Null

try {
    $artifactPath = Join-Path $tempDirectory $artifact
    Write-Host "Downloading $artifact from $repo@$tag..."
    Invoke-Download -Url "$baseUrl/$artifact" -Destination $artifactPath

    $checksumsPath = Join-Path $tempDirectory "SHA256SUMS"
    try {
        Invoke-Download -Url "$baseUrl/SHA256SUMS" -Destination $checksumsPath
    }
    catch {
        Fail "failed to download $baseUrl/SHA256SUMS. Checksum verification is required; refusing to install an unverified artifact."
    }

    $expectedSha256 = Get-ExpectedSha256 -ChecksumsPath $checksumsPath -ArtifactName $artifact
    if ([string]::IsNullOrWhiteSpace($expectedSha256)) {
        Fail "SHA256SUMS does not contain an entry for $artifact."
    }

    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath).Hash.ToLowerInvariant()
    if (-not [string]::Equals($expectedSha256, $actualSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        Fail "checksum mismatch for $artifact."
    }

    Write-Host "Verified SHA256 checksum."

    Install-Executable -Source $artifactPath -Target $target
    Write-Host "Installed hosty to $target"

    Invoke-Hosty -HostyPath $target -Arguments @("install")
    Ensure-UserPath -InstallDirectory $installDirectory

    if ($startAfterInstall) {
        Invoke-Hosty -HostyPath $target -Arguments @("start")
        Invoke-Hosty -HostyPath $target -Arguments @("open")
    }
    else {
        Write-Host ""
        Write-Host "Next commands:"
        Write-Host "  $target start"
        Write-Host "  $target open"
    }
}
finally {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$target.tmp.$PID" -Force -ErrorAction SilentlyContinue
}
