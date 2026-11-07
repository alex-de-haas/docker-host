using System.Diagnostics;

namespace Haas.Hosty.Core.Tests;

public sealed class NativeProcessEnvironmentTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-native-environment-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void Reset_PreservesWindowsToolDiscoveryAndDropsAmbientAuthority()
    {
        var start = new ProcessStartInfo();
        start.Environment.Clear();
        var system = new Dictionary<string, string>
        {
            ["Path"] = @"C:\Windows\System32;C:\Program Files\dotnet",
            ["USERPROFILE"] = @"C:\Users\operator",
            ["APPDATA"] = @"C:\Users\operator\AppData\Roaming",
            ["LOCALAPPDATA"] = @"C:\Users\operator\AppData\Local",
            ["PROGRAMDATA"] = @"C:\ProgramData",
            ["ALLUSERSPROFILE"] = @"C:\ProgramData",
            ["ProgramFiles"] = @"C:\Program Files",
            ["ProgramFiles(x86)"] = @"C:\Program Files (x86)",
            ["ProgramW6432"] = @"C:\Program Files",
            ["CommonProgramFiles"] = @"C:\Program Files\Common Files",
            ["ComSpec"] = @"C:\Windows\System32\cmd.exe",
            ["PATHEXT"] = ".COM;.EXE;.BAT;.CMD",
            ["DOTNET_ROOT_X64"] = @"C:\Program Files\dotnet",
            ["PROCESSOR_ARCHITECTURE"] = "AMD64",
        };
        foreach (var pair in system) start.Environment[pair.Key] = pair.Value;
        foreach (var key in new[] { "OPENAI_API_KEY", "HOSTY_APP_SERVICE_TOKEN", "GITHUB_TOKEN", "GIT_CONFIG_GLOBAL", "NUGET_AUTH_TOKEN", "DOCKER_CONFIG", "NODE_OPTIONS" })
            start.Environment[key] = "must-not-cross-boundary";

        NativeProcessEnvironment.ResetToSystemEssentials(start);

        foreach (var pair in system)
            Assert.Equal(pair.Value, start.Environment.Single(value => value.Key.Equals(pair.Key, StringComparison.OrdinalIgnoreCase)).Value);
        Assert.DoesNotContain(start.Environment.Values, value => value == "must-not-cross-boundary");
    }

    [Fact]
    public void Reset_PrivateHomeReplacesAllInheritedUserProfileLocations()
    {
        var start = new ProcessStartInfo();
        foreach (var key in new[] { "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH" })
            start.Environment[key] = "parent-profile-must-not-be-reused";
        start.Environment["NUGET_PACKAGES"] = "parent-package-cache";
        var home = Path.Combine(root, "child", "home");

        NativeProcessEnvironment.ResetToSystemEssentials(start, home);

        Assert.Equal(home, start.Environment["HOME"]);
        Assert.Equal(home, start.Environment["USERPROFILE"]);
        Assert.Equal(Path.Combine(home, "AppData", "Roaming"), start.Environment["APPDATA"]);
        Assert.Equal(Path.Combine(home, "AppData", "Local"), start.Environment["LOCALAPPDATA"]);
        Assert.True(Directory.Exists(start.Environment["APPDATA"]));
        Assert.True(Directory.Exists(start.Environment["LOCALAPPDATA"]));
        Assert.DoesNotContain(start.Environment.Values, value => value == "parent-profile-must-not-be-reused" || value == "parent-package-cache");
        if (OperatingSystem.IsWindows())
            Assert.Equal(home, start.Environment["HOMEDRIVE"] + start.Environment["HOMEPATH"]);
    }

    [WindowsNativeFact]
    public async Task Windows_FilteredPrivateProfileSupportsRealNuGetPathDiscovery()
    {
        var home = Path.Combine(root, "child", "home");
        var start = new ProcessStartInfo("dotnet") { WorkingDirectory = Path.GetTempPath() };
        foreach (var arg in new[] { "nuget", "locals", "all", "--list" }) start.ArgumentList.Add(arg);
        NativeProcessEnvironment.ResetToSystemEssentials(start, home);
        start.Environment["DOTNET_SKIP_FIRST_TIME_EXPERIENCE"] = "1";
        start.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
        start.Environment["DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE"] = "true";
        start.Environment["DOTNET_NOLOGO"] = "1";

        var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(45), CancellationToken.None, 16384);

        Assert.False(result.TimedOut);
        Assert.True(result.ExitCode == 0, result.StandardOutput + result.StandardError);
        Assert.Contains("global-packages:", result.StandardOutput, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(Path.Combine(home, "AppData", "Local"), result.StandardOutput, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("path1", result.StandardOutput + result.StandardError, StringComparison.OrdinalIgnoreCase);
    }

    public void Dispose()
    {
        if (Directory.Exists(root)) Directory.Delete(root, true);
    }
}
