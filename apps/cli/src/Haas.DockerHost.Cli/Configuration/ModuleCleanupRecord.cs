namespace Haas.DockerHost.Cli.Configuration;

using System.Text.Json;

internal sealed record ModuleCleanupLoadResult(IReadOnlyList<ModuleCleanupRecord> Modules, string? Error);

internal sealed record ModuleCleanupContainerRecord(string Key, string ContainerName, string? ImageReference);

internal sealed record ModuleCleanupRecord(string Id, IReadOnlyList<ModuleCleanupContainerRecord> Containers)
{
    public string ContainerName => Containers.FirstOrDefault()?.ContainerName ?? BuildModuleDockerName(Id);

    public string? ImageReference => Containers.FirstOrDefault(container => !string.IsNullOrWhiteSpace(container.ImageReference))?.ImageReference;

    public IEnumerable<string> ImageReferences => Containers
        .Select(container => container.ImageReference)
        .OfType<string>()
        .Where(image => !string.IsNullOrWhiteSpace(image));

    public IEnumerable<ModuleCleanupContainerRecord> GetContainersInStopOrder()
        => Containers.Reverse();

    public static ModuleCleanupLoadResult LoadFromDataRoot(string dataRoot)
    {
        var modulesStorePath = Path.Combine(dataRoot, "modules.json");
        if (!File.Exists(modulesStorePath))
        {
            return new ModuleCleanupLoadResult([], null);
        }

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(modulesStorePath));
            if (!document.RootElement.TryGetProperty("modules", out var modulesElement) ||
                modulesElement.ValueKind != JsonValueKind.Array)
            {
                return new ModuleCleanupLoadResult([], null);
            }

            var modules = new List<ModuleCleanupRecord>();
            foreach (var moduleElement in modulesElement.EnumerateArray())
            {
                var record = TryRead(moduleElement);
                if (record is not null)
                {
                    modules.Add(record);
                }
            }

            return new ModuleCleanupLoadResult(modules, null);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            return new ModuleCleanupLoadResult([], ex.Message);
        }
    }

    private static ModuleCleanupRecord? TryRead(JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Object ||
            !TryGetString(element, "id", out var id))
        {
            return null;
        }

        var containers = TryReadContainers(element, id);
        return new ModuleCleanupRecord(id, containers);
    }

    private static IReadOnlyList<ModuleCleanupContainerRecord> TryReadContainers(JsonElement element, string moduleId)
    {
        if (element.TryGetProperty("containers", out var containersElement) &&
            containersElement.ValueKind == JsonValueKind.Array)
        {
            var containers = containersElement
                .EnumerateArray()
                .Select((containerElement, index) => TryReadContainer(containerElement, moduleId, index))
                .Where(container => container is not null)
                .Cast<ModuleCleanupContainerRecord>()
                .ToList();

            if (containers.Count > 0)
            {
                return containers;
            }
        }

        var containerName = TryGetString(element, "containerName", out var legacyContainerName)
            ? legacyContainerName
            : BuildModuleDockerName(moduleId);

        return
        [
            new ModuleCleanupContainerRecord(
                "main",
                containerName,
                TryReadImageReference(element))
        ];
    }

    private static ModuleCleanupContainerRecord? TryReadContainer(JsonElement element, string moduleId, int index)
    {
        if (element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        var key = TryGetString(element, "key", out var storedKey)
            ? storedKey
            : $"container-{index + 1}";
        var containerName = TryGetString(element, "containerName", out var storedContainerName)
            ? storedContainerName
            : BuildModuleContainerDockerName(moduleId, key);

        return new ModuleCleanupContainerRecord(key, containerName, TryReadImageReference(element));
    }

    private static string? TryReadImageReference(JsonElement element)
    {
        if (!element.TryGetProperty("image", out var imageElement) ||
            imageElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (TryGetString(imageElement, "reference", out var reference))
        {
            return reference;
        }

        if (!TryGetString(imageElement, "repository", out var repository))
        {
            return null;
        }

        return TryGetString(imageElement, "tag", out var tag)
            ? $"{repository}:{tag}"
            : null;
    }

    private static bool TryGetString(JsonElement element, string propertyName, out string value)
    {
        value = string.Empty;
        if (!element.TryGetProperty(propertyName, out var property) ||
            property.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        var candidate = property.GetString();
        if (string.IsNullOrWhiteSpace(candidate))
        {
            return false;
        }

        value = candidate;
        return true;
    }

    private static string BuildModuleDockerName(string moduleId)
    {
        var normalized = string.Join(
            '-',
            moduleId
                .ToLowerInvariant()
                .Split(
                    moduleId.Where(character => !char.IsAsciiLetterOrDigit(character)).Distinct().ToArray(),
                    StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

        return $"mod-{(string.IsNullOrWhiteSpace(normalized) ? "module" : normalized)}";
    }

    private static string BuildModuleContainerDockerName(string moduleId, string containerKey)
    {
        var moduleName = BuildModuleDockerName(moduleId);

        var normalizedContainer = string.Join(
            '-',
            containerKey
                .ToLowerInvariant()
                .Split(
                    containerKey.Where(character => !char.IsAsciiLetterOrDigit(character)).Distinct().ToArray(),
                    StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

        return $"{moduleName}-{(string.IsNullOrWhiteSpace(normalizedContainer) ? "container" : normalizedContainer)}";
    }
}
