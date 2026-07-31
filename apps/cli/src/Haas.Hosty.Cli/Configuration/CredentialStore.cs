namespace Haas.Hosty.Cli.Configuration;

using System.Diagnostics;
using System.Runtime.InteropServices;

/// <summary>
/// Where a context's access token is kept.
/// </summary>
/// <remarks>
/// <para>
/// On macOS the value goes to the login keychain through the <c>security</c> tool, so it is protected by
/// the same thing that protects every other credential on the machine and never appears in the Hosty
/// config directory.
/// </para>
/// <para>
/// Everywhere else it goes to an owner-only file under the Hosty root. This is weaker and is stated
/// plainly rather than dressed up: on Linux the alternative is a Secret Service session that a headless
/// box often does not have, and on Windows DPAPI would mean a package reference this AOT binary does not
/// otherwise need. A file with 0600 permissions matches how the CLI already stores every other local
/// secret, and the credential it holds is revocable from Shell the moment it is suspect.
/// </para>
/// </remarks>
internal static class CredentialStore
{
    private const string KeychainService = "hosty-cli";

    public static bool UsesSystemKeychain => RuntimeInformation.IsOSPlatform(OSPlatform.OSX);

    /// <summary>Human-readable name of where the credential ends up, for the CLI to report honestly.</summary>
    public static string LocationDescription(HostyEnvironment environment)
        => UsesSystemKeychain ? "macOS login keychain" : FilePath(environment, "<context>");

    public static void Save(HostyEnvironment environment, string contextName, string token)
    {
        if (UsesSystemKeychain && TryKeychainSave(contextName, token))
        {
            // Do not leave a stale copy behind if this context previously fell back to a file.
            DeleteFile(environment, contextName);
            return;
        }

        var path = FilePath(environment, contextName);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, token);
        RestrictToOwner(path);
    }

    public static string? Load(HostyEnvironment environment, string contextName)
    {
        if (UsesSystemKeychain)
        {
            var fromKeychain = TryKeychainLoad(contextName);
            if (!string.IsNullOrWhiteSpace(fromKeychain))
            {
                return fromKeychain;
            }
        }

        var path = FilePath(environment, contextName);
        return File.Exists(path) ? File.ReadAllText(path).Trim() : null;
    }

    public static void Delete(HostyEnvironment environment, string contextName)
    {
        if (UsesSystemKeychain)
        {
            RunSecurity(["delete-generic-password", "-s", KeychainService, "-a", contextName], out _);
        }

        DeleteFile(environment, contextName);
    }

    private static void DeleteFile(HostyEnvironment environment, string contextName)
    {
        var path = FilePath(environment, contextName);
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }

    private static string FilePath(HostyEnvironment environment, string contextName)
        => Path.Combine(environment.ConfigDirectory, "contexts", $"{contextName}.token");

    private static bool TryKeychainSave(string contextName, string token)
        // -U updates an existing entry instead of failing; -w takes the value on the command line, which
        // is visible to a process listing for the moment it runs. That is the documented cost of using
        // `security` without an interactive prompt, and it is on the user's own machine.
        => RunSecurity(["add-generic-password", "-U", "-s", KeychainService, "-a", contextName, "-w", token], out _);

    private static string? TryKeychainLoad(string contextName)
        => RunSecurity(["find-generic-password", "-s", KeychainService, "-a", contextName, "-w"], out var output)
            ? output.Trim()
            : null;

    private static bool RunSecurity(string[] arguments, out string output)
    {
        output = string.Empty;
        try
        {
            var startInfo = new ProcessStartInfo("security")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (var argument in arguments)
            {
                startInfo.ArgumentList.Add(argument);
            }

            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return false;
            }

            output = process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            process.WaitForExit();
            return process.ExitCode == 0;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException or IOException)
        {
            // No `security` on PATH, or it could not be launched: fall back to the file rather than
            // failing the login.
            return false;
        }
    }

    private static void RestrictToOwner(string path)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            // NTFS inherits ACLs from the user-profile directory this lives under; there is no chmod to
            // apply and no portable managed API here that AOT keeps.
            return;
        }

        try
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (Exception ex) when (ex is IOException or PlatformNotSupportedException or UnauthorizedAccessException)
        {
            // A filesystem that cannot express the mode (a mounted share, say) must not fail the login;
            // the token stays revocable regardless.
        }
    }
}
