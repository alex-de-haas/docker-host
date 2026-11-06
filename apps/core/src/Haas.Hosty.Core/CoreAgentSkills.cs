using System.Text;

namespace Haas.Hosty.Core;

/// <summary>Portable guidance shipped in the running Core artifact, independent of installed apps.</summary>
internal static class CoreAgentSkills
{
    internal const string PlatformName = "hosty-platform";
    internal const string IntroductionPath = "references/introduction.md";
    internal static string PlatformId => AgentSkillLibrary.Id("core", PlatformName);
    internal static readonly AgentSkillEntry[] Entries = Load();

    internal static AgentPlatformIntroduction Introduction()
    {
        var file = Entries.Single(e => e.Info.Id == PlatformId).Files.Single(f => f.Path == IntroductionPath);
        return new(PlatformId, CoreStatusResponse.PlatformVersionString, IntroductionPath, Encoding.UTF8.GetString(file.Content));
    }

    private static AgentSkillEntry[] Load()
    {
        var assembly = typeof(CoreAgentSkills).Assembly;
        var entries = new List<AgentSkillEntry>();
        foreach (var name in new[] { PlatformName, "hosty-app-skill" })
        {
            var prefix = $"Hosty.AgentSkills/{name}/";
            var files = assembly.GetManifestResourceNames().Where(r => r.Replace('\\', '/').StartsWith(prefix, StringComparison.Ordinal))
                .Select(resource =>
                {
                    using var stream = assembly.GetManifestResourceStream(resource)!;
                    using var buffer = new MemoryStream();
                    stream.CopyTo(buffer);
                    return new AgentSkillFile(resource.Replace('\\', '/')[prefix.Length..], buffer.ToArray());
                }).OrderBy(f => f.Path, StringComparer.Ordinal).ToArray();
            var package = AgentSkillPackages.Validate(files, name);
            if (name == PlatformName && files.Single(f => f.Path == IntroductionPath).Content.Length is 0 or > 8000)
                throw new InvalidOperationException("The packaged platform introduction must contain at most 8,000 bytes.");
            entries.Add(new(new(AgentSkillLibrary.Id("core", name), name, package.Description, "core",
                null, null, null, null, name, null, files.Length, files.Sum(f => f.Content.LongLength),
                DateTimeOffset.UnixEpoch, CoreStatusResponse.PlatformVersionString,
                name == PlatformName ? IntroductionPath : null), files));
        }
        return entries.ToArray();
    }

    internal static void RejectReservedNames(IEnumerable<string> names)
    {
        if (names.Any(name => Entries.Any(e => e.Info.Name.Equals(name, StringComparison.OrdinalIgnoreCase))))
            throw new AppLifecycleException("skill_name_conflict", "This native skill name is supplied by Core. Use the built-in package or choose a different name.");
    }
}
