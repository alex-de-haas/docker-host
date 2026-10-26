using System.Text;
using System.Text.RegularExpressions;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;

namespace Haas.Hosty.Core;

/// <summary>Reads the portable Agent Skills format without executing package code.</summary>
internal static partial class AgentSkillPackages
{
    public const int MaxFiles = 512;
    public const long MaxBytes = 16 * 1024 * 1024;
    public const int MaxInstructionsBytes = 256 * 1024;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    [GeneratedRegex("^[a-z0-9]+(?:-[a-z0-9]+)*$", RegexOptions.CultureInvariant)]
    private static partial Regex NamePattern();

    public static AppLifecycleException Invalid(string message) => new("skill_package_invalid", message);

    public static string RelativePath(string value, bool allowEmpty = false)
    {
        if (value is null) throw Invalid("Package paths cannot be null.");
        if (allowEmpty && value.Length == 0) return "";
        if (value.Length > 512 || value.Contains('\\') || value.Contains(':') ||
            value.Split('/').Any(p => p.Length == 0 || p is "." or ".." ||
                p.Any(c => char.IsControl(c) || c is '<' or '>' or '"' or '|' or '?' or '*') ||
                p.EndsWith('.') || p.EndsWith(' ') || IsReservedDevice(p)))
            throw Invalid("Package paths must be portable relative paths without traversal.");
        return value;
    }

    private static bool IsReservedDevice(string segment)
    {
        var stem = segment.Split('.')[0].ToUpperInvariant();
        return stem is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$" ||
            stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)) &&
            stem[3] is >= '1' and <= '9';
    }

    public static async Task<AgentSkillPackage> ReadAsync(string directory, CancellationToken ct, bool matchDirectoryName = true)
    {
        var root = Path.GetFullPath(directory);
        if (!Directory.Exists(root)) throw Invalid("The skill directory does not exist.");
        var files = new List<AgentSkillFile>();
        long bytes = 0;
        async Task Visit(string folder, int depth)
        {
            if (depth > 16) throw Invalid("Package directory nesting exceeds 16 levels.");
            foreach (var item in Directory.EnumerateFileSystemEntries(folder).Order(StringComparer.Ordinal))
            {
                ct.ThrowIfCancellationRequested();
                var attributes = File.GetAttributes(item);
                if ((attributes & FileAttributes.ReparsePoint) != 0)
                    throw Invalid("Skills cannot contain symbolic links or reparse points.");
                var relative = RelativePath(Path.GetRelativePath(root, item).Replace(Path.DirectorySeparatorChar, '/'));
                if (relative.Split('/').Any(p => p.Equals(".git", StringComparison.OrdinalIgnoreCase)))
                    throw Invalid("Git metadata cannot be part of a skill package.");
                if ((attributes & FileAttributes.Directory) != 0) { await Visit(item, depth + 1); continue; }
                await AppSourceService.RequireRegularFileAsync(item, ct);
                var length = new FileInfo(item).Length;
                if (files.Count >= MaxFiles || length > MaxBytes || bytes + length > MaxBytes)
                    throw Invalid("A skill may contain at most 512 files and 16 MiB.");
                bytes += length;
                await using var input = File.OpenRead(item);
                using var buffer = new MemoryStream();
                var chunk = new byte[16384];
                int count;
                while ((count = await input.ReadAsync(chunk, ct)) > 0)
                {
                    if (buffer.Length + count > length) throw Invalid("The package changed while it was read.");
                    buffer.Write(chunk, 0, count);
                }
                var content = buffer.ToArray();
                if (content.LongLength != length) throw Invalid("The package changed while it was read.");
                var executable = !OperatingSystem.IsWindows() &&
                    (File.GetUnixFileMode(item) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0;
                files.Add(new(relative, content, executable));
            }
        }
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0)
            throw Invalid("The skill root cannot be a symbolic link.");
        await Visit(root, 0);
        return Validate(files.ToArray(), matchDirectoryName ? Path.GetFileName(root) : null);
    }

    public static AgentSkillPackage Validate(AgentSkillFile[] files, string? directoryName = null)
    {
        if (files.Length is 0 or > MaxFiles || files.Sum(f => f.Content.LongLength) > MaxBytes)
            throw Invalid("A skill may contain at most 512 files and 16 MiB.");
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var file in files)
        {
            RelativePath(file.Path);
            if (!paths.Add(file.Path)) throw Invalid("Package file paths must be unique on all supported hosts.");
            var parts = file.Path.Split('/');
            if (parts.Any(p => p.Equals(".git", StringComparison.OrdinalIgnoreCase)))
                throw Invalid("Git metadata cannot be part of a skill package.");
        }
        foreach (var path in paths)
        {
            for (var slash = path.IndexOf('/'); slash >= 0; slash = path.IndexOf('/', slash + 1))
                if (paths.Contains(path[..slash])) throw Invalid("A package path cannot be both a file and a directory.");
        }
        var instructions = files.SingleOrDefault(f => f.Path == "SKILL.md")?.Content
            ?? throw Invalid("A skill requires SKILL.md at its root.");
        if (instructions.Length > MaxInstructionsBytes) throw Invalid("SKILL.md exceeds 256 KiB.");
        string text;
        try { text = Utf8.GetString(instructions).TrimStart('\uFEFF'); }
        catch (DecoderFallbackException) { throw Invalid("SKILL.md must be UTF-8."); }
        var lines = text.Replace("\r\n", "\n").Split('\n');
        if (lines[0] != "---") throw Invalid("SKILL.md requires YAML frontmatter.");
        var end = Array.FindIndex(lines, 1, l => l == "---");
        if (end < 0) throw Invalid("SKILL.md frontmatter is not terminated.");
        string? name = null, description = null;
        try
        {
            var parser = new Parser(new StringReader(string.Join('\n', lines[1..end])));
            parser.Consume<StreamStart>();
            parser.Consume<DocumentStart>();
            parser.Consume<MappingStart>();
            var keys = new HashSet<string>(StringComparer.Ordinal);
            while (!parser.Accept<MappingEnd>(out _))
            {
                var key = parser.Consume<Scalar>().Value;
                if (!keys.Add(key)) throw Invalid("SKILL.md frontmatter contains a duplicate key.");
                if (key is "name" or "description")
                {
                    var scalar = parser.Consume<Scalar>();
                    if (!scalar.Anchor.IsEmpty || !scalar.Tag.IsEmpty) throw Invalid("Skill metadata must contain plain scalar values.");
                    if (key == "name") name = scalar.Value;
                    else description = scalar.Value;
                }
                else parser.SkipThisAndNestedEvents();
            }
            parser.Consume<MappingEnd>();
            parser.Consume<DocumentEnd>();
            parser.Consume<StreamEnd>();
        }
        catch (YamlException) { throw Invalid("SKILL.md contains invalid YAML metadata."); }
        if (name is null || name.Length > 64 || !NamePattern().IsMatch(name))
            throw Invalid("Skill name must be 1–64 lowercase letters, digits and single hyphens.");
        if (directoryName is not null && name != directoryName)
            throw Invalid("Skill name must match its directory name.");
        if (string.IsNullOrWhiteSpace(description) || description.Length > 1024)
            throw Invalid("Skill description must contain 1–1024 characters.");
        return new(name, description, files);
    }
}
