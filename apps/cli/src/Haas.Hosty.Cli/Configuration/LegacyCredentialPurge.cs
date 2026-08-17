namespace Haas.Hosty.Cli.Configuration;

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>
/// Removes the credentials the removed <c>hosty login</c> used to store.
/// </summary>
/// <remarks>
/// <para>
/// Deleting the command was not enough. Anyone who had signed in before upgrading still had a bearer
/// token on the machine — in the macOS login keychain, or in an owner-only file under the config
/// directory — and the only supported way to remove it went out with <c>hosty logout</c>. Leaving a
/// live credential behind with no way to get rid of it is a worse state than the one being cleaned up.
/// </para>
/// <para>
/// It runs once, on any command, and does nothing at all when there is nothing to remove — which is
/// every machine that never signed in, and every machine after the first run.
/// </para>
/// <para>
/// Deleting the local copy does <b>not</b> revoke the credential: it stays valid on the host until it
/// is revoked from Shell. So this says what it did and where the other half lives, rather than
/// implying the token is now dead.
/// </para>
/// </remarks>
internal static class LegacyCredentialPurge
{
    private const string KeychainService = "hosty-cli";

    /// <summary>
    /// Purges what is there, and returns a line to show the operator when it removed anything.
    /// </summary>
    /// <param name="configDirectory">
    /// Taken rather than the whole environment because that is all this needs, which also lets it be
    /// tested against a temp directory instead of a process-wide <c>HOSTY_HOME</c> the rest of the
    /// suite would race on.
    /// </param>
    public static string? Run(string configDirectory)
    {
        var contextsFile = Path.Combine(configDirectory, "contexts.json");
        var tokenDirectory = Path.Combine(configDirectory, "contexts");
        if (!File.Exists(contextsFile) && !Directory.Exists(tokenDirectory))
        {
            return null;
        }

        // Keychain entries are keyed by context name, and the only record of those names is the file
        // about to be deleted — so they are read first. Deleting the index first would strand every
        // keychain entry permanently, which is the exact failure this exists to prevent.
        var removed = 0;
        foreach (var name in ReadContextNames(contextsFile))
        {
            if (TryDeleteFromKeychain(name))
            {
                removed++;
            }
        }

        removed += DeleteQuietly(contextsFile) ? 1 : 0;
        if (Directory.Exists(tokenDirectory))
        {
            foreach (var file in SafeEnumerate(tokenDirectory))
            {
                removed += DeleteQuietly(file) ? 1 : 0;
            }

            try
            {
                Directory.Delete(tokenDirectory);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A leftover directory is harmless; the credentials inside it were the point.
            }
        }

        return removed == 0
            ? null
            : "Removed the credential saved by the former 'hosty login'. The CLI is local-only now. "
                + "That credential is still valid on the host until you revoke it in Shell.";
    }

    private static IEnumerable<string> ReadContextNames(string contextsFile)
    {
        if (!File.Exists(contextsFile))
        {
            yield break;
        }

        string[] names;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(contextsFile));
            names = document.RootElement.TryGetProperty("contexts", out var contexts) &&
                contexts.ValueKind == JsonValueKind.Array
                    ? contexts.EnumerateArray()
                        .Select(entry => entry.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String
                            ? name.GetString()
                            : null)
                        .Where(name => !string.IsNullOrWhiteSpace(name))
                        .Select(name => name!)
                        .ToArray()
                    : [];
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // A corrupt file still gets deleted below; it simply cannot tell us which keychain entries
            // to look for.
            yield break;
        }

        foreach (var name in names)
        {
            yield return name;
        }
    }

    private static bool TryDeleteFromKeychain(string contextName)
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return false;
        }

        try
        {
            using var process = Process.Start(new ProcessStartInfo("security")
            {
                ArgumentList = { "delete-generic-password", "-s", KeychainService, "-a", contextName },
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            });
            if (process is null)
            {
                return false;
            }

            process.WaitForExit();
            // A non-zero exit is the ordinary "no such entry", not a failure worth reporting.
            return process.ExitCode == 0;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return false;
        }
    }

    private static IEnumerable<string> SafeEnumerate(string directory)
    {
        try
        {
            return Directory.EnumerateFiles(directory, "*.token").ToArray();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    private static bool DeleteQuietly(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return false;
            }

            File.Delete(path);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
