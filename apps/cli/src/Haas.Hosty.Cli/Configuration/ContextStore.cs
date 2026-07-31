namespace Haas.Hosty.Cli.Configuration;

using System.Text.Json;
using System.Text.Json.Serialization;
using Haas.Hosty.Cli.Commands;

/// <summary>
/// Named remote hosts the CLI knows how to reach, kubectl-style.
/// </summary>
/// <remarks>
/// Only the host origin and which context is current live here. The credential itself never does — it
/// goes to <see cref="CredentialStore"/> — so this file can be read, copied or backed up without
/// carrying anything worth stealing.
/// </remarks>
internal sealed partial class ContextStore(HostyEnvironment environment)
{
    private string Path => System.IO.Path.Combine(environment.ConfigDirectory, "contexts.json");

    public HostyContexts Read()
    {
        if (!File.Exists(Path))
        {
            return new HostyContexts(null, []);
        }

        try
        {
            using var stream = File.OpenRead(Path);
            return JsonSerializer.Deserialize(stream, ContextJsonContext.Default.HostyContexts)
                ?? new HostyContexts(null, []);
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            // A corrupted or unreadable file must not wedge every command that merely wants to know
            // whether a context exists; it reads as "none configured" and the next login rewrites it.
            return new HostyContexts(null, []);
        }
    }

    public void Write(HostyContexts contexts)
    {
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(Path, JsonSerializer.Serialize(contexts, ContextJsonContext.Default.HostyContexts));
    }

    public HostyContext? Resolve(string? name)
    {
        var contexts = Read();
        var wanted = string.IsNullOrWhiteSpace(name) ? contexts.Current : name;
        return string.IsNullOrWhiteSpace(wanted)
            ? null
            : contexts.Contexts.FirstOrDefault(context => string.Equals(context.Name, wanted, StringComparison.Ordinal));
    }

    public void Upsert(HostyContext context, bool makeCurrent)
    {
        var existing = Read();
        var contexts = existing.Contexts
            .Where(candidate => !string.Equals(candidate.Name, context.Name, StringComparison.Ordinal))
            .Append(context)
            .OrderBy(candidate => candidate.Name, StringComparer.Ordinal)
            .ToArray();
        Write(new HostyContexts(
            makeCurrent || string.IsNullOrWhiteSpace(existing.Current) ? context.Name : existing.Current,
            contexts));
    }

    public bool Remove(string name)
    {
        var existing = Read();
        var remaining = existing.Contexts
            .Where(candidate => !string.Equals(candidate.Name, name, StringComparison.Ordinal))
            .ToArray();
        if (remaining.Length == existing.Contexts.Count)
        {
            return false;
        }

        var current = string.Equals(existing.Current, name, StringComparison.Ordinal)
            ? remaining.FirstOrDefault()?.Name
            : existing.Current;
        Write(new HostyContexts(current, remaining));
        CredentialStore.Delete(environment, name);
        return true;
    }

    public bool SetCurrent(string name)
    {
        var existing = Read();
        if (!existing.Contexts.Any(candidate => string.Equals(candidate.Name, name, StringComparison.Ordinal)))
        {
            return false;
        }

        Write(existing with { Current = name });
        return true;
    }

    [JsonSourceGenerationOptions(
        PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true)]
    [JsonSerializable(typeof(HostyContexts))]
    internal partial class ContextJsonContext : JsonSerializerContext;
}

internal sealed record HostyContexts(string? Current, IReadOnlyList<HostyContext> Contexts);

internal sealed record HostyContext(string Name, string Origin, string? User = null);
