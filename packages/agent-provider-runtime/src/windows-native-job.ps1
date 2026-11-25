param([Parameter(Mandatory = $true)][ValidatePattern('^hosty-native-[a-f0-9-]{36}$')][string]$PipeName, [string]$RecoveryFile)
$ErrorActionPreference = 'Stop'
try {
    # Windows PowerShell and the .NET Framework are stock Windows components. No SDK, download,
    # account import or administrator configuration is performed by this launcher.
    $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-native-job.cs') -Raw
    Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Runtime.Serialization.dll', 'System.Xml.dll')
    if ($RecoveryFile) { exit ([HostyNativeJob]::CloseOrFence($RecoveryFile, $PipeName.Substring(13))) }
    exit ([HostyNativeJob]::Run($PipeName))
}
catch {
    [Console]::Error.WriteLine('The provider Windows native job bridge could not establish execution proof.')
    exit 70
}
