namespace Haas.Hosty.Cli.Configuration;

using System.Text;

internal sealed class LaunchSettingsStore(HostyEnvironment environment)
{
    public string LaunchConfigPath => environment.LaunchConfigPath;

    public LaunchSettings Load()
    {
        var values = CreateDefaultValues();

        if (File.Exists(environment.LaunchConfigPath))
        {
            foreach (var (key, value) in Parse(File.ReadAllLines(environment.LaunchConfigPath)))
            {
                if (!LaunchSettingDefinitions.Contains(key))
                {
                    continue;
                }

                // Older CLIs materialized the pre-generic-bootstrap default manifest URLs into
                // launch.env. Those were never operator intent, so a value still equal to the old
                // default reads as unset — otherwise every upgraded host would carry a pinned
                // location that goes stale the next time a release moves a manifest.
                if (LaunchSettingDefinitions.ScrubbedLegacyDefaults.TryGetValue(key, out var legacyDefault) &&
                    string.Equals(value, legacyDefault, StringComparison.Ordinal))
                {
                    continue;
                }

                values[key] = value;
            }
        }

        return new LaunchSettings(values);
    }

    public LaunchSettings EnsureInstalled()
    {
        try
        {
            Directory.CreateDirectory(environment.RootDirectory);
            Directory.CreateDirectory(environment.ConfigDirectory);
            Directory.CreateDirectory(environment.BinDirectory);
            Directory.CreateDirectory(environment.AppsDirectory);

            var settings = Load();
            settings.Validate(environment);

            Directory.CreateDirectory(settings.ResolveHostDataRoot(environment));
            Save(settings);

            return settings;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new ConfigurationException($"Unable to prepare Hosty directories: {ex.Message}");
        }
    }

    public void Save(LaunchSettings settings)
    {
        settings.Validate(environment);
        Directory.CreateDirectory(environment.ConfigDirectory);

        var builder = new StringBuilder();
        builder.AppendLine("# hosty launch settings");
        builder.AppendLine("# Managed by hosty config.");

        foreach (var definition in LaunchSettingDefinitions.All)
        {
            builder.Append(definition.Key);
            builder.Append('=');
            builder.AppendLine(settings[definition.Key]);
        }

        var tempPath = environment.LaunchConfigPath + ".tmp";
        try
        {
            File.WriteAllText(tempPath, builder.ToString(), new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
            File.Move(tempPath, environment.LaunchConfigPath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new ConfigurationException($"Unable to write launch configuration '{environment.LaunchConfigPath}': {ex.Message}");
        }
    }

    public void Set(string key, string value)
    {
        var definition = LaunchSettingDefinitions.Get(key);
        if (!definition.IsEditable)
        {
            throw new ConfigurationException($"{key} is fixed for the local Host launch model and cannot be changed with config set.");
        }

        var error = definition.Validate(value, environment);
        if (error is not null)
        {
            throw new ConfigurationException($"Invalid {key}: {error}");
        }

        Save(Load().WithValue(key, NormalizeValue(key, value)));
    }

    public void Reset(string key)
    {
        var definition = LaunchSettingDefinitions.Get(key);
        Save(Load().WithValue(key, definition.DefaultValue(environment)));
    }

    private Dictionary<string, string> CreateDefaultValues()
        => LaunchSettingDefinitions.All.ToDictionary(x => x.Key, x => x.DefaultValue(environment), StringComparer.Ordinal);

    private static string NormalizeValue(string key, string value)
        => key switch
        {
            LaunchSettingDefinitions.HostyCorePort or LaunchSettingDefinitions.HostyShellPort => value.Trim(),
            _ => value,
        };

    private static IEnumerable<(string Key, string Value)> Parse(IEnumerable<string> lines)
    {
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

            yield return (line[..separator].Trim(), line[(separator + 1)..].Trim());
        }
    }
}
