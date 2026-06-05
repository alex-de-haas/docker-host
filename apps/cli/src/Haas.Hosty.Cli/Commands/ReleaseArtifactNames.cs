namespace Haas.Hosty.Cli.Commands;

using System.Runtime.InteropServices;

internal static class ReleaseArtifactNames
{
    internal static string GetCliArtifactName()
        => GetPlatformArtifactName("hosty", "CLI");

    internal static string GetCoreArtifactName()
        => GetPlatformArtifactName("hosty-core", "Core");

    internal static string GetInstalledCoreExecutableName()
        => RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "hosty-core.exe" : "hosty-core";

    private static string GetPlatformArtifactName(string executableName, string componentName)
    {
        var architecture = RuntimeInformation.OSArchitecture switch
        {
            Architecture.Arm64 => "arm64",
            Architecture.X64 => "x64",
            _ => throw new PlatformNotSupportedException($"Unsupported architecture {RuntimeInformation.OSArchitecture}."),
        };

        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return $"{executableName}-darwin-{architecture}";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return $"{executableName}-linux-{architecture}";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            if (architecture != "x64")
            {
                throw new PlatformNotSupportedException($"Windows {componentName} release assets are published for x64 only.");
            }

            return $"{executableName}-windows-x64.exe";
        }

        throw new PlatformNotSupportedException($"Unsupported OS {RuntimeInformation.OSDescription}.");
    }
}
