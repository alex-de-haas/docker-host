# Exercise the installer's feed parser without running its Windows installation entry point.
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'install.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    . ([ScriptBlock]::Create($definition.Extent.Text))
}
function Fail([string]$Message) { throw $Message }
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Invoke-ReleaseDownload([string]$Url, [string]$Destination, [long]$Limit = 1048576) {
    $null = Assert-ReleaseHttps $Url
    if (-not $script:documents.ContainsKey($Url)) { throw "Unexpected download $Url" }
    [IO.File]::WriteAllText($Destination, $script:documents[$Url], [Text.UTF8Encoding]::new($false))
}
function Hash([string]$Value) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('hosty-feed-parser-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporary
try {
    $assets = @('cli','core') | ForEach-Object { @{ role=$_;rid='win-x64';fileName="$_.exe";url="https://publisher.test/$_.exe";size=7;sha256=('a'*64);inputFingerprint=('b'*64);provenance='fixture' } }
    $release = @{ schemaVersion='hosty-platform-release.0.1';releaseId=('c'*64);sourceCommit=('d'*40);version='1.0.0';assets=@($assets) }
    $descriptor = $release | ConvertTo-Json -Depth 20 -Compress
    $index = @{ schemaVersion='hosty-platform-feeds.0.1';feeds=@('Frequent','Reviewed','Research') | ForEach-Object { @{ id=$_;default=($_ -ceq 'Reviewed');releaseRef='https://publisher.test/release.json';releaseSha256=(Hash $descriptor) } } }
    $script:documents = @{ 'https://publisher.test/index.json'=($index | ConvertTo-Json -Depth 20 -Compress);'https://publisher.test/release.json'=$descriptor }
    $asset = Resolve-PlatformFeed 'https://publisher.test/index.json' '' 'win-x64' $temporary
    $receipt = Get-Content -Raw (Join-Path $temporary 'release.json') | ConvertFrom-Json
    Assert ($asset.role -ceq 'cli' -and $receipt.selection.source.feedId -ceq 'Reviewed') 'Publisher default or paired receipt was lost.'
    $null = Resolve-PlatformFeed 'https://publisher.test/index.json' 'Research' 'win-x64' $temporary
    $receipt = Get-Content -Raw (Join-Path $temporary 'release.json') | ConvertFrom-Json
    Assert ($receipt.selection.source.feedId -ceq 'Research') 'Explicit feed was replaced by the default.'
    foreach ($invalid in @('research', 'Missing')) {
        $rejected = $false
        try { $null = Resolve-PlatformFeed 'https://publisher.test/index.json' $invalid 'win-x64' $temporary } catch { $rejected = $true }
        Assert $rejected 'Missing or incorrectly cased feed selected a fallback.'
    }
    Remove-Item (Join-Path $temporary 'release.json')
    $script:documents['https://publisher.test/release.json'] = $descriptor + ' '
    $rejected = $false
    try { $null = Resolve-PlatformFeed 'https://publisher.test/index.json' '' 'win-x64' $temporary } catch { $rejected = $true }
    Assert ($rejected -and -not (Test-Path (Join-Path $temporary 'release.json'))) 'Changed descriptor produced an installation receipt.'
    $release.assets = @($assets[0]);$descriptor = $release | ConvertTo-Json -Depth 20 -Compress
    foreach ($entry in $index.feeds) { $entry.releaseSha256 = Hash $descriptor }
    $script:documents['https://publisher.test/index.json'] = $index | ConvertTo-Json -Depth 20 -Compress
    $script:documents['https://publisher.test/release.json'] = $descriptor
    $rejected = $false
    try { $null = Resolve-PlatformFeed 'https://publisher.test/index.json' '' 'win-x64' $temporary } catch { $rejected = $true }
    Assert ($rejected -and -not (Test-Path (Join-Path $temporary 'release.json'))) 'Incomplete pair produced an installation receipt.'
    Write-Host 'PASS: PowerShell feed selection, exact hashes, paired receipts and failure preservation.'
} finally { Remove-Item -Recurse -Force $temporary }
