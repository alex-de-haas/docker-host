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
// - HOSTY_CORE_PUBLIC_ORIGIN is written into the same store. An earlier revision only echoed it,
//   because the store had no slot for it yet; that shipped, and on a host that carried a public
//   origin the value went with the deleted file. Core then fell back to its listen URL and handed
//   `http://localhost:{port}` to every app, so Shell's browser dialled loopback and sign-in links
//   pointed at a host nobody outside the machine can reach. The slot exists now, so the value moves
//   with everything else.
// - A non-default HOSTY_DATA_ROOT cannot be folded anywhere — the pointer cannot live inside the
//   root it points to — so the operator is told to select it via --data-root/HOSTY_DATA_ROOT.
//
// A value the store already carries is never overwritten: the operator set it after the fact (quite
// possibly to recover from the loss above), and that choice is newer than the retired file's.
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

        // Everything the store can hold, gathered before a single write so one unusable value never
        // leaves the file half-migrated.
        var fold = new Dictionary<string, string>(StringComparer.Ordinal);
        var blocked = false;
        if (values.GetValueOrDefault("HOSTY_CORE_PORT") is { } rawPort &&
            int.TryParse(rawPort.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var port) &&
            port is > 0 and <= 65535 &&
            port != 7070)
        {
            fold["HOSTY_CORE_PORT"] = port.ToString(CultureInfo.InvariantCulture);
        }

        if (values.GetValueOrDefault("HOSTY_CORE_PUBLIC_ORIGIN") is { } rawOrigin &&
            !string.IsNullOrWhiteSpace(rawOrigin))
        {
            if (TryNormalizeOrigin(rawOrigin, out var origin))
            {
                fold["HOSTY_CORE_PUBLIC_ORIGIN"] = origin;
            }
            else
            {
                // Not foldable and not silently droppable: this is the value an operator signs in
                // through, so say so and keep the file as the record of it. The value itself is NOT
                // echoed — one of the ways it can be invalid is carrying userinfo, and a notice is
                // console output that lands in scrollback and logs. The file holds it; point there.
                blocked = true;
                notices.Add(
                    $"launch.env ('{path}') carries a HOSTY_CORE_PUBLIC_ORIGIN that is not a usable origin: " +
                    "it must be an absolute http(s) address with no path, query, fragment or userinfo, and " +
                    "not an unspecified address (0.0.0.0, [::]). The file is left in place so the value is " +
                    "not lost — read it there, set a valid one with " +
                    "`hosty core settings set HOSTY_CORE_PUBLIC_ORIGIN <origin>`, and delete the file.");
            }
        }

        var folded = !blocked;
        if (folded && fold.Count > 0)
        {
            if (TryFoldIntoSettings(environment.RootDirectory, fold, out var settingsPath, out var kept, out var foldError))
            {
                var moved = fold.Keys.Where(key => !kept.Contains(key)).ToArray();
                if (moved.Length > 0)
                {
                    notices.Add(
                        $"launch.env is retired: moved {string.Join(" and ", moved.Select(key => $"{key}={fold[key]}"))} " +
                        $"into the data root's settings store ({settingsPath}). Change them later with " +
                        "`hosty core settings set <KEY> <value>`.");
                }

                foreach (var key in kept)
                {
                    notices.Add(
                        $"launch.env also carried {key}={fold[key]}, but the settings store already has a value " +
                        "for it — the store's value is newer and was kept. Check it with " +
                        $"`hosty core settings get {key}`.");
                }
            }
            else
            {
                folded = false;
                notices.Add(
                    $"launch.env carries {string.Join(", ", fold.Keys)}, which could not be moved into " +
                    $"'{settingsPath}' ({foldError}). The file is left in place; move the values with " +
                    "`hosty core settings set <KEY> <value>` and delete it.");
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

    // Mirrors Core's CoreOriginSettings.TryNormalize so the operator hears about an unusable origin
    // here, while the file that records it still exists, instead of having it accepted and then
    // dropped by Core's own read path. Canonical form is the authority — scheme, host and port — which
    // is the shape Core stores.
    private static bool TryNormalizeOrigin(string? raw, out string origin)
    {
        origin = "";
        if (string.IsNullOrWhiteSpace(raw) ||
            !Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") ||
            !string.IsNullOrWhiteSpace(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.PathAndQuery.Trim('/')) ||
            !string.IsNullOrWhiteSpace(uri.Fragment))
        {
            return false;
        }

        // A bind address, never somewhere a browser can be sent.
        if (System.Net.IPAddress.TryParse(uri.Host.Trim('[', ']'), out var address) &&
            (address.Equals(System.Net.IPAddress.Any) || address.Equals(System.Net.IPAddress.IPv6Any)))
        {
            return false;
        }

        origin = uri.GetLeftPart(UriPartial.Authority);
        return true;
    }

    // Merges the gathered values into {dataRoot}/core/settings.json without disturbing anything else
    // the file holds — the store is Core-owned, so this writes the minimum: the `server` group (plus
    // the schema version when creating the file). JsonNode keeps unknown groups intact byte-for-byte
    // semantically; Core rewrites the file in its own shape on its next settings save. Keys the store
    // already carries are reported through `kept` and left untouched.
    private static bool TryFoldIntoSettings(
        string dataRoot,
        IReadOnlyDictionary<string, string> values,
        out string settingsPath,
        out IReadOnlyCollection<string> kept,
        out string error)
    {
        var coreRoot = Path.Combine(dataRoot, "core");
        settingsPath = Path.Combine(coreRoot, "settings.json");
        error = string.Empty;
        var alreadyStored = new List<string>();
        kept = alreadyStored;
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

            foreach (var (key, value) in values)
            {
                if (server[key] is not null)
                {
                    alreadyStored.Add(key);
                    continue;
                }

                server[key] = value;
            }

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
