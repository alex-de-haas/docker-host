using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class AuditStore(CoreDataPaths paths)
{
    public async Task AppendAsync(AuditRecord record, CancellationToken cancellationToken = default)
    {
        var directory = Path.GetDirectoryName(paths.AuditLogPath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var line = JsonSerializer.Serialize(record, CoreJsonSerializerContext.Default.AuditRecord);
        await File.AppendAllTextAsync(paths.AuditLogPath, $"{line}{Environment.NewLine}", cancellationToken);
    }

    public async Task<IReadOnlyList<AuditRecord>> ReadRecentAsync(int limit = 100, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(paths.AuditLogPath))
        {
            return [];
        }

        var lines = await File.ReadAllLinesAsync(paths.AuditLogPath, cancellationToken);
        return lines
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .Reverse()
            .Take(Math.Clamp(limit, 1, 500))
            .Select(line => JsonSerializer.Deserialize(line, CoreJsonSerializerContext.Default.AuditRecord))
            .OfType<AuditRecord>()
            .ToArray();
    }
}

internal sealed record AuditRecord(
    string Id,
    string Action,
    string ResourceType,
    string? ResourceId,
    string Outcome,
    string? ActorUserId,
    DateTimeOffset CreatedAt,
    IReadOnlyDictionary<string, string> Details);
