using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal static class AppDevelopmentGuideReader
{
    internal const int MaximumTopicBytes = 16_000;
    internal const string InvalidTopicCode = "development_guide_topic_invalid";
    private static readonly AppDevelopmentGuideTopic[] Topics =
    [
        new("overview", "Workflow and readers"), new("source", "Source, workspaces and Git"),
        new("docker", "Docker runtime and dependencies"), new("identity", "Identity and direct HTTP protocol"),
        new("sdk", "SDK capabilities by stack"), new("preview", "Child Core preview"),
        new("checks", "Checks and recovery"), new("finish", "Completion and source retention"),
    ];
    private static readonly IReadOnlyDictionary<string, string> Content = Load();
    private static readonly string Revision = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(
        string.Join("\n", Topics.Select(topic => topic.Id + "\n" + topic.Title + "\n" + Content[topic.Id])))));

    internal static AppDevelopmentGuide Read(string? topic = null)
    {
        topic ??= "overview";
        if (!Content.TryGetValue(topic, out var text))
            throw new AppLifecycleException(InvalidTopicCode, "Unknown guide topic. Read overview for the supported topic IDs.");
        return new(Revision, text, CoreStatusResponse.PlatformVersionString, "app.0.1", topic, Topics);
    }

    private static IReadOnlyDictionary<string, string> Load()
    {
        var content = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var topic in Topics)
        {
            using var stream = typeof(AppDevelopmentGuideReader).Assembly.GetManifestResourceStream(
                $"Hosty.AppDevelopmentGuide.{topic.Id}.md") ?? throw new InvalidOperationException("Packaged guide topic is missing.");
            using var reader = new StreamReader(stream);
            var text = reader.ReadToEnd();
            if (string.IsNullOrWhiteSpace(text) || Encoding.UTF8.GetByteCount(text) > MaximumTopicBytes)
                throw new InvalidOperationException("Packaged guide topic is empty or exceeds the response budget.");
            content.Add(topic.Id, text);
        }
        return content;
    }
}
