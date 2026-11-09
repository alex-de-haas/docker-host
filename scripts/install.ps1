#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Start,
    [string]$Feed = $env:HOSTY_INSTALL_FEED,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$DefaultRepo = "alex-de-haas/docker-host"

function Fail {
    param([Parameter(Mandatory = $true)][string]$Message)

    Write-Error "hosty install: $Message"
    exit 1
}

function Show-Usage {
    @"
Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 [-Start] [-Feed <id>]
  pwsh -NoProfile -File scripts/install.ps1 [-Start] [-Feed <id>]

Remote install:
  irm https://raw.githubusercontent.com/alex-de-haas/docker-host/main/scripts/install.ps1 | iex

Environment overrides:
  HOSTY_INSTALL_REPO              GitHub repository, default alex-de-haas/docker-host
  HOSTY_INSTALL_FEED              Feed ID; otherwise the publisher's default
  HOSTY_INSTALL_INDEX             HTTPS feed index; defaults to the selected repository
  HOSTY_INSTALL_TAG               Explicit legacy GitHub Release pin; incompatible with -Feed
  HOSTY_INSTALL_DIR               Directory for hosty.exe, default %USERPROFILE%\.hosty\bin
  HOSTY_INSTALL_SKIP_PATH_UPDATE  Set to 1 to skip user PATH updates
  HOSTY_INSTALL_START             Set to 1 to run hosty init after install (recommended apps, noninteractive)
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

function Get-ReleaseProperty($Object, [string]$Name, $Fallback = $null) {
    if ($null -eq $Object) { return $Fallback }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Fallback }
    return $property.Value
}

function Assert-ReleaseHttps([string]$Reference) {
    $uri = $null
    if (-not [Uri]::TryCreate($Reference, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -cne 'https' -or
        $uri.UserInfo -or $uri.Fragment -or $Reference -match '[\x00-\x1f\x7f]') { Fail 'Release sources require HTTPS without credentials or fragments.' }
    return $uri
}

function Invoke-ReleaseDownload([string]$Url, [string]$Destination, [long]$Limit = 1048576) {
    $uri = Assert-ReleaseHttps $Url
    for ($redirect = 0; $redirect -le 5; $redirect++) {
        $request = [Net.HttpWebRequest]::Create($uri)
        $request.AllowAutoRedirect = $false
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 30000
        $response = $request.GetResponse()
        try {
            $status = [int]$response.StatusCode
            if ($status -ge 300 -and $status -lt 400) {
                $uri = Assert-ReleaseHttps ([Uri]::new($uri, $response.Headers['Location']).AbsoluteUri)
                continue
            }
            if ($status -ne 200 -or $response.ContentLength -gt $Limit) { Fail 'The release download is unavailable or exceeds its declared size.' }
            $inputStream = $response.GetResponseStream()
            $outputStream = [IO.File]::Create($Destination)
            try {
                $buffer = New-Object byte[] 81920
                $total = 0L
                while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                    $total += $count
                    if ($total -gt $Limit) { Fail 'The release download exceeded its size limit.' }
                    $outputStream.Write($buffer, 0, $count)
                }
            } finally { $outputStream.Dispose(); $inputStream.Dispose() }
            return
        } finally { $response.Dispose() }
    }
    Fail 'Too many release source redirects.'
}

function Resolve-PlatformFeed([string]$IndexRef, [string]$Requested, [string]$Rid, [string]$Directory) {
    $indexPath = Join-Path $Directory 'feeds.json'
    Invoke-ReleaseDownload $IndexRef $indexPath
    $index = Get-Content -Raw -LiteralPath $indexPath | ConvertFrom-Json
    if ((Get-ReleaseProperty $index 'schemaVersion') -cne 'hosty-platform-feeds.0.1') { Fail 'Unsupported platform feed index.' }
    $feeds = @(Get-ReleaseProperty $index 'feeds' @())
    if ($feeds.Count -eq 0) { Fail 'The feed index is empty.' }
    $ids = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $defaults = @()
    foreach ($candidate in $feeds) {
        $id = Get-ReleaseProperty $candidate 'id'
        if ($id -isnot [string] -or [string]::IsNullOrWhiteSpace($id) -or $id.Length -gt 128 -or $id -cne $id.Trim() -or
            $id -match '\p{Cc}' -or -not $ids.Add($id)) { Fail 'Invalid or duplicate feed ID.' }
        $null = Assert-ReleaseHttps (Get-ReleaseProperty $candidate 'releaseRef')
        if ((Get-ReleaseProperty $candidate 'releaseSha256') -cnotmatch '^[0-9a-f]{64}$') { Fail 'Missing descriptor SHA256.' }
        $isDefault = Get-ReleaseProperty $candidate 'default' $false
        if ($isDefault -isnot [bool]) { Fail 'Invalid default flag.' }
        if ($isDefault) { $defaults += $candidate }
    }
    if ($defaults.Count -gt 1) { Fail 'The index has multiple default feeds.' }
    if ($Requested) {
        $matches = @($feeds | Where-Object { $_.id -ceq $Requested })
        if ($matches.Count -ne 1) { Fail 'The requested feed is unavailable; no fallback was selected.' }
        $selected = $matches[0]
    } elseif ($feeds.Count -eq 1) { $selected = $feeds[0] }
    elseif ($defaults.Count -eq 1) { $selected = $defaults[0] }
    else { Fail 'Choose a feed explicitly; this index has no default.' }
    $descriptorPath = Join-Path $Directory 'descriptor.json'
    Invoke-ReleaseDownload $selected.releaseRef $descriptorPath
    $descriptorHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $descriptorPath).Hash.ToLowerInvariant()
    if ($descriptorHash -cne $selected.releaseSha256) { Fail 'Release descriptor SHA256 mismatch.' }
    $release = Get-Content -Raw -LiteralPath $descriptorPath | ConvertFrom-Json
    if ((Get-ReleaseProperty $release 'schemaVersion') -cne 'hosty-platform-release.0.1' -or
        (Get-ReleaseProperty $release 'releaseId') -cnotmatch '^[0-9a-f]{64}$' -or
        (Get-ReleaseProperty $release 'sourceCommit') -cnotmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' -or
        [string]::IsNullOrWhiteSpace((Get-ReleaseProperty $release 'version'))) { Fail 'Invalid platform release.' }
    $assets = @(Get-ReleaseProperty $release 'assets' @())
    $identities = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $targets = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($asset in $assets) {
        $role = Get-ReleaseProperty $asset 'role'
        $targetRid = Get-ReleaseProperty $asset 'rid'
        $name = Get-ReleaseProperty $asset 'fileName'
        if ($role -cnotin @('cli', 'core') -or $targetRid -cnotmatch '^[a-zA-Z0-9.-]{1,64}$' -or
            [string]::IsNullOrEmpty($name) -or $name -in @('.', '..') -or $name -match '[/\\:\x00-\x1f\x7f]' -or
            -not $identities.Add("$role/$targetRid")) { Fail 'Invalid or duplicate release asset.' }
        $null = $targets.Add($targetRid)
        $size = Get-ReleaseProperty $asset 'size' 0
        if (($size -isnot [long] -and $size -isnot [int]) -or $size -le 0 -or
            (Get-ReleaseProperty $asset 'sha256') -cnotmatch '^[0-9a-f]{64}$' -or
            (Get-ReleaseProperty $asset 'inputFingerprint') -cnotmatch '^[0-9a-f]{64}$' -or
            [string]::IsNullOrWhiteSpace((Get-ReleaseProperty $asset 'provenance'))) { Fail 'Incomplete asset identity.' }
        $null = Assert-ReleaseHttps (Get-ReleaseProperty $asset 'url')
    }
    foreach ($targetRid in $targets) {
        if (-not $identities.Contains("cli/$targetRid") -or -not $identities.Contains("core/$targetRid")) { Fail 'The release lacks a CLI/Core pair.' }
    }
    if (-not $targets.Contains($Rid)) { Fail 'The release does not support this platform.' }
    $asset = @($assets | Where-Object { $_.role -ceq 'cli' -and $_.rid -ceq $Rid })[0]
    $receipt = @{
        schemaVersion = 'hosty-platform-install.0.1'; rid = $Rid; installedAt = [DateTimeOffset]::UtcNow.ToString('o')
        selection = @{
            source = @{ schemaVersion = 'hosty-platform-update-source.0.1'; indexRef = $IndexRef; feedId = $selected.id; revision = [Guid]::NewGuid().ToString('N') }
            feed = $selected; release = $release; descriptorSha256 = $descriptorHash
            indexSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $indexPath).Hash.ToLowerInvariant()
        }
    }
    [IO.File]::WriteAllText((Join-Path $Directory 'release.json'), ($receipt | ConvertTo-Json -Depth 30 -Compress), [Text.UTF8Encoding]::new($false))
    return $asset
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
$tag = $env:HOSTY_INSTALL_TAG
if ($repo -cnotmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $repo.Contains('..')) { Fail 'Invalid release repository.' }
if ($tag -and ($tag -cnotmatch '^[A-Za-z0-9_.-]+$' -or $tag.Contains('..'))) { Fail 'Invalid explicit release tag.' }
$indexRef = if ([string]::IsNullOrWhiteSpace($env:HOSTY_INSTALL_INDEX)) { "https://raw.githubusercontent.com/$repo/app-releases/platform/feeds.json" } else { $env:HOSTY_INSTALL_INDEX }
if ($tag -and ($Feed -or $env:HOSTY_INSTALL_INDEX)) { Fail 'An explicit tag cannot be combined with a feed or feed index.' }
$installDirectory = if ([string]::IsNullOrWhiteSpace($env:HOSTY_INSTALL_DIR)) {
    Join-Path (Join-Path $homeDirectory ".hosty") "bin"
}
else {
    $env:HOSTY_INSTALL_DIR
}

if ([string]::IsNullOrWhiteSpace($repo)) {
    Fail "HOSTY_INSTALL_REPO cannot be empty."
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
    if (-not $tag) {
        $selectedAsset = Resolve-PlatformFeed $indexRef $Feed 'win-x64' $tempDirectory
        Write-Host "Downloading the selected feed's CLI release..."
        Invoke-ReleaseDownload $selectedAsset.url $artifactPath $selectedAsset.size
        if ((Get-Item -LiteralPath $artifactPath).Length -ne $selectedAsset.size) { Fail 'CLI asset size mismatch.' }
        $expectedSha256 = $selectedAsset.sha256
    } else {
        Write-Host "Downloading $artifact from explicit pin $repo@$tag..."
        Invoke-Download -Url "$baseUrl/$artifact" -Destination $artifactPath
        $checksumsPath = Join-Path $tempDirectory 'SHA256SUMS'
        Invoke-Download -Url "$baseUrl/SHA256SUMS" -Destination $checksumsPath
        $expectedSha256 = Get-ExpectedSha256 -ChecksumsPath $checksumsPath -ArtifactName $artifact
        if ([string]::IsNullOrWhiteSpace($expectedSha256)) { Fail "SHA256SUMS does not contain an entry for $artifact." }
        $coreSha = Get-ExpectedSha256 -ChecksumsPath $checksumsPath -ArtifactName 'hosty-core-windows-x64.exe'
        if ($coreSha -cnotmatch '^[0-9a-f]{64}$' -or $expectedSha256 -cnotmatch '^[0-9a-f]{64}$') { Fail 'Missing or invalid paired executable checksum.' }
        $pin = @{ schemaVersion = 'hosty-platform-legacy-pin.0.1'; repository = $repo; tag = $tag; rid = 'win-x64'; cliSha256 = $expectedSha256; coreSha256 = $coreSha }
        [IO.File]::WriteAllText((Join-Path $tempDirectory 'legacy-source.json'), ($pin | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    }

    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifactPath).Hash.ToLowerInvariant()
    if (-not [string]::Equals($expectedSha256, $actualSha256, [System.StringComparison]::OrdinalIgnoreCase)) {
        Fail "checksum mismatch for $artifact."
    }

    Write-Host "Verified SHA256 checksum."

    Install-Executable -Source $artifactPath -Target $target
    $receiptPath = Join-Path $tempDirectory 'release.json'
    if (Test-Path -LiteralPath $receiptPath) {
        Move-Item -LiteralPath $receiptPath -Destination "$target.release.json" -Force
        Remove-Item -LiteralPath "$target.legacy-source.json" -Force -ErrorAction SilentlyContinue
    } else {
        Remove-Item -LiteralPath "$target.release.json" -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath (Join-Path $tempDirectory 'legacy-source.json') -Destination "$target.legacy-source.json" -Force
    }
    Write-Host "Installed hosty to $target"

    Invoke-Hosty -HostyPath $target -Arguments @("install")
    Ensure-UserPath -InstallDirectory $installDirectory

    if ($startAfterInstall) {
        Invoke-Hosty -HostyPath $target -Arguments @("init", "--yes")
    }
    else {
        Write-Host ""
        Write-Host "Next command:"
        Write-Host "  $target init"
    }
}
finally {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath "$target.tmp.$PID" -Force -ErrorAction SilentlyContinue
}
