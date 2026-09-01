namespace Haas.Hosty.Cli.Configuration;

using System.Globalization;
using System.Text.Json.Nodes;

// One-shot retirement of the legacy launch config ({root}/config/launch.env). The CLI is no longer
// a configuration store: the data root is selected per invocation (--data-root / HOSTY_DATA_ROOT)
// and the port lives in the root's own settings store. On first contact the file's values are
// folded into the per-root store and the file is deleted; what cannot be folded is surfaced as a
// notice instead of silently vanishing:
//
// - HOSTY_CORE_PORT != 7070 is written into {data root}/core/settings.json (the store Core reads
//   the port from at startup).
// - A non-default HOSTY_DATA_ROOT cannot be folded anywhere — the pointer cannot live inside the
//   root it points to — so the operator is told to select it via --data-root/HOSTY_DATA_ROOT.
// - HOSTY_CORE_PUBLIC_ORIGIN remains a plain environment variable Core reads; its store move is a
//   separate plan (core-public-origin), so its value is echoed for the operator to re-apply.
internal static class LaunchEnvMigration
{
    public static IReadOnlyList<string> Run(HostyEnvironment environment)
    {
        var path = environment.LaunchConfigPath;
        if (!File.Exists(path))
        {
            return [];
        }

        var notices = new List<string>();
        Dictionary<string, string> values;
        try
        {
            values = Parse(File.ReadAllLines(path));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return [$"Legacy launch.env at '{path}' could not be read ({ex.Message}); leaving it in place."];
        }

        // The root the file's pointer names, when it names one. Before anything is folded or
        // deleted, the pointer must agree with the root this invocation is about to act on:
        // migrating on a mismatch would run the command against the wrong installation (the first
        // `hosty start` creating a second default-root Core, `hosty uninstall --delete-data`
        // wiping the wrong data) and the delete would erase the only record of the right root. A
        // pointer at the hardcoded default is vacuous — it holds nothing the default doesn't.
        var comparison = environment.IsWindows ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var dataRootRaw = values.GetValueOrDefault("HOSTY_DATA_ROOT", string.Empty).Trim();
        var pointerRoot = dataRootRaw.Length > 0 ? environment.ResolvePath(dataRootRaw) : null;
        var pointerIsMeaningful = pointerRoot is not null &&
            !PathsEqual(pointerRoot, environment.RootDirectory, comparison) &&
            !PathsEqual(pointerRoot, environment.PreferredRootDirectory, comparison);
        if (pointerIsMeaningful)
        {
            if (PathsEqual(environment.RootDirectory, environment.PreferredRootDirectory, comparison))
            {
                // Aimed at the default root only because nothing selected one; the installation
                // lives elsewhere. Stop before acting on the wrong root.
                throw new ConfigurationException(
                    $"This installation's data root is '{pointerRoot}' (recorded in the legacy launch config '{path}'), " +
                    $"but this command is aimed at the default root '{environment.RootDirectory}'. Rerun with " +
                    $"--data-root '{pointerRoot}' (or export HOSTY_DATA_ROOT) to migrate the legacy config and " +
                    "continue; if the pointer is obsolete, delete the file by hand.");
            }

            // The operator explicitly targeted another environment. The pointer describes a
            // different installation, so it is not this invocation's to migrate or delete.
            return [];
        }

        var folded = true;
        if (values.GetValueOrDefault("HOSTY_CORE_PORT") is { } rawPort &&
            int.TryParse(rawPort.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var port) &&
            port is > 0 and <= 65535 &&
            port != 7070)
        {
            if (TryFoldPortIntoSettings(environment.RootDirectory, port, out var settingsPath, out var foldError))
            {
                notices.Add(
                    $"launch.env is retired: moved HOSTY_CORE_PORT={port} into the data root's settings store " +
                    $"({settingsPath}). Change it later with `hosty core settings set HOSTY_CORE_PORT <port>`.");
            }
            else
            {
                folded = false;
                notices.Add(
                    $"launch.env carries HOSTY_CORE_PORT={port}, which could not be moved into " +
                    $"'{settingsPath}' ({foldError}). The file is left in place; move the port with " +
                    "`hosty core settings set HOSTY_CORE_PORT <port>` and delete it.");
            }
        }

        // The pointer named the root this invocation explicitly targeted; once the file is gone,
        // nothing selects that root anymore — remind the operator before the delete below.
        if (pointerRoot is not null &&
            PathsEqual(pointerRoot, environment.RootDirectory, comparison) &&
            !PathsEqual(environment.RootDirectory, environment.PreferredRootDirectory, comparison))
        {
            notices.Add(
                $"launch.env pointed the data root at '{pointerRoot}'. The CLI no longer stores this pointer " +
                "(it cannot live inside the root it points to): keep selecting the environment with " +
                $"--data-root '{pointerRoot}', or export HOSTY_DATA_ROOT.");
        }

        if (values.GetValueOrDefault("HOSTY_CORE_PUBLIC_ORIGIN") is { } origin && !string.IsNullOrWhiteSpace(origin))
        {
            notices.Add(
                $"launch.env carried HOSTY_CORE_PUBLIC_ORIGIN={origin.Trim()}. The CLI no longer injects it: " +
                "export it as a plain environment variable when starting Core.");
        }

        if (folded)
        {
            try
            {
                File.Delete(path);
                notices.Add($"Removed the legacy launch config '{path}'.");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                notices.Add($"Could not remove the legacy launch config '{path}' ({ex.Message}); delete it by hand.");
            }
        }

        return notices;
    }

    // Merges the port into {dataRoot}/core/settings.json without disturbing anything else the file
    // holds — the store is Core-owned, so this writes the minimum: server.HOSTY_CORE_PORT (plus the
    // schema version when creating the file). JsonNode keeps unknown groups intact byte-for-byte
    // semantically; Core rewrites the file in its own shape on its next settings save.
    private static bool TryFoldPortIntoSettings(string dataRoot, int port, out string settingsPath, out string error)
    {
        var coreRoot = Path.Combine(dataRoot, "core");
        settingsPath = Path.Combine(coreRoot, "settings.json");
        error = string.Empty;
        try
        {
            JsonObject document;
            if (File.Exists(settingsPath))
            {
                if (JsonNode.Parse(File.ReadAllText(settingsPath)) is not JsonObject existing)
                {
                    error = "the file does not hold a JSON object";
                    return false;
                }

                document = existing;
            }
            else
            {
                document = new JsonObject { ["schemaVersion"] = "core-settings.0.1" };
            }

            if (document["server"] is not JsonObject server)
            {
                server = new JsonObject();
                document["server"] = server;
            }

            server["HOSTY_CORE_PORT"] = port.ToString(CultureInfo.InvariantCulture);

            Directory.CreateDirectory(coreRoot);
            var temporaryPath = settingsPath + ".tmp";
            File.WriteAllText(temporaryPath, document.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporaryPath, settingsPath, overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            error = ex.Message;
            return false;
        }
    }

    private static bool PathsEqual(string left, string right, StringComparison comparison)
        => string.Equals(
            Path.TrimEndingDirectorySeparator(left),
            Path.TrimEndingDirectorySeparator(right),
            comparison);

    private static Dictionary<string, string> Parse(IEnumerable<string> lines)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var rawLine in lines)
        {
            var line = rawLine.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            var separator = line.IndexOf('=', StringComparison.Ordinal);
            if (separator <= 0)
            {
                continue;
            }

            values[line[..separator].Trim()] = line[(separator + 1)..].Trim();
        }

        return values;
    }
}
