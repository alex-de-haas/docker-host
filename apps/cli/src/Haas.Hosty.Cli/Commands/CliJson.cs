namespace Haas.Hosty.Cli.Commands;

using System.Text.Json;
using System.Text.Json.Serialization.Metadata;

/// <summary>
/// Native AOT-safe JSON helpers. Every DTO is registered in a source-generated
/// <see cref="System.Text.Json.Serialization.JsonSerializerContext"/> nested in the command class that owns it
/// (so no two types ever share a generated property name), and those contexts are combined into a single
/// resolver here. Nothing falls back to the reflection-based serializer, so the published binary is free of
/// IL2026/IL3050 warnings.
/// </summary>
internal static class CliJson
{
    /// <summary>Web defaults (camelCase, case-insensitive reads, numbers-from-string) over the combined source-gen resolver.</summary>
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        // Enforce the DTOs' nullable annotations on reads: a missing/null value for a non-nullable
        // property throws JsonException (surfaced as a clean "invalid response" by CommandLine) instead
        // of null-collapsing into a non-nullable slot and NRE-ing deep in a render path (L-H4).
        RespectNullableAnnotations = true,
        TypeInfoResolver = JsonTypeInfoResolver.Combine(
            AppsCommand.AppsJsonContext.Default,
            StorageCommand.StorageJsonContext.Default,
            AuthCommand.AuthJsonContext.Default,
            CoreCommand.CoreJsonContext.Default,
            OpenCommand.OpenJsonContext.Default,
            UpdateCommand.UpdateJsonContext.Default,
            UsersCommand.UsersJsonContext.Default,
            SetupCommand.SetupJsonContext.Default,
            LoginCommand.LoginJsonContext.Default,
            Configuration.ContextStore.ContextJsonContext.Default,
            CoreControlClient.ControlJsonContext.Default),
    };

    public static string Serialize<T>(T value)
        => JsonSerializer.Serialize(value, TypeInfo<T>());

    public static ValueTask<T?> DeserializeAsync<T>(Stream stream, CancellationToken cancellationToken = default)
        => JsonSerializer.DeserializeAsync(stream, TypeInfo<T>(), cancellationToken);

    public static JsonTypeInfo<T> TypeInfo<T>()
        => Options.GetTypeInfo(typeof(T)) as JsonTypeInfo<T>
            ?? throw new NotSupportedException(
                $"Type {typeof(T).FullName} is not registered in the source-generated JSON contexts (see Commands/CliJson.cs).");

    public static JsonTypeInfo TypeInfo(Type type)
        => Options.GetTypeInfo(type);
}
