using System.Diagnostics;

namespace Haas.Hosty.Core;

internal static class NativeProcessEnvironment
{
    // Native toolchains need OS profile/installation discovery as well as PATH. Keep this
    // explicit: inheriting Core's whole environment would also forward app/provider secrets.
    private static readonly string[] Essentials =
    [
        "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
        "SystemRoot", "SystemDrive", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL",
        "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ALLUSERSPROFILE",
        "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
        "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
        "ComSpec", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432",
        "NUMBER_OF_PROCESSORS", "DOTNET_ROOT", "DOTNET_ROOT(x86)", "DOTNET_ROOT_X64", "DOTNET_ROOT_X86", "DOTNET_ROOT_ARM64",
    ];

    internal static void ResetToSystemEssentials(ProcessStartInfo start, string? privateHome = null)
    {
        var inherited = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in start.Environment) inherited[pair.Key] = pair.Value;
        start.Environment.Clear();
        foreach (var key in Essentials)
            if (inherited.TryGetValue(key, out var value) && value is not null) start.Environment[key] = value;

        if (privateHome is null) return;
        var home = Path.GetFullPath(privateHome);
        Directory.CreateDirectory(home);
        start.Environment["HOME"] = home;
        start.Environment["USERPROFILE"] = home;
        // Windows NuGet reads these variables directly, without falling back to USERPROFILE.
        // A child must discover its own configuration/cache, never its parent's AppData.
        var roaming = Path.Combine(home, "AppData", "Roaming");
        var local = Path.Combine(home, "AppData", "Local");
        Directory.CreateDirectory(roaming);
        Directory.CreateDirectory(local);
        start.Environment["APPDATA"] = roaming;
        start.Environment["LOCALAPPDATA"] = local;
        start.Environment.Remove("HOMEDRIVE");
        start.Environment.Remove("HOMEPATH");
        if (OperatingSystem.IsWindows())
        {
            var root = Path.GetPathRoot(home)!;
            start.Environment["HOMEDRIVE"] = root.TrimEnd(Path.DirectorySeparatorChar);
            start.Environment["HOMEPATH"] = Path.DirectorySeparatorChar + home[root.Length..];
        }
    }
}
