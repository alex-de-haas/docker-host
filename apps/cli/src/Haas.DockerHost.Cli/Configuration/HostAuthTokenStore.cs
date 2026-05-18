namespace Haas.DockerHost.Cli.Configuration;

using System.Text;
using System.Text.Json;

internal sealed class HostAuthTokenStore(DockerHostEnvironment environment)
{
    private const string TokenOverrideVariable = "DOCKER_HOST_CLI_TOKEN";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    public HostAuthTokenCredential? Load()
    {
        if (!File.Exists(environment.AuthConfigPath))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<HostAuthTokenCredential>(
                File.ReadAllText(environment.AuthConfigPath, Encoding.UTF8),
                JsonOptions);
        }
        catch (JsonException)
        {
            throw new ConfigurationException($"Unable to parse auth configuration '{environment.AuthConfigPath}'.");
        }
    }

    public string? GetTokenForHost(Uri hostUrl)
    {
        var overrideToken = Environment.GetEnvironmentVariable(TokenOverrideVariable);
        if (!string.IsNullOrWhiteSpace(overrideToken))
        {
            return overrideToken.Trim();
        }

        var credential = Load();
        if (credential is null)
        {
            return null;
        }

        return string.Equals(
            NormalizeHostUrl(credential.HostUrl),
            NormalizeHostUrl(hostUrl),
            StringComparison.OrdinalIgnoreCase)
            ? credential.Token
            : null;
    }

    public bool HasEnvironmentOverride()
        => !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(TokenOverrideVariable));

    public void Save(HostAuthTokenCredential credential)
    {
        Directory.CreateDirectory(environment.ConfigDirectory);
        var normalizedCredential = credential with
        {
            HostUrl = NormalizeHostUrl(credential.HostUrl),
            Token = credential.Token.Trim(),
        };
        var tempPath = environment.AuthConfigPath + ".tmp";

        File.WriteAllText(
            tempPath,
            JsonSerializer.Serialize(normalizedCredential, JsonOptions) + Environment.NewLine,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        RestrictPermissions(tempPath);
        File.Move(tempPath, environment.AuthConfigPath, overwrite: true);
        RestrictPermissions(environment.AuthConfigPath);
    }

    public bool Delete()
    {
        if (!File.Exists(environment.AuthConfigPath))
        {
            return false;
        }

        File.Delete(environment.AuthConfigPath);
        return true;
    }

    public static string NormalizeHostUrl(string hostUrl)
        => NormalizeHostUrl(new Uri(hostUrl));

    public static string NormalizeHostUrl(Uri hostUrl)
        => hostUrl.GetLeftPart(UriPartial.Authority).TrimEnd('/');

    private static void RestrictPermissions(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}

internal sealed record HostAuthTokenCredential(
    string HostUrl,
    string Token,
    string? TokenId,
    string? Label,
    DateTimeOffset StoredAt);
