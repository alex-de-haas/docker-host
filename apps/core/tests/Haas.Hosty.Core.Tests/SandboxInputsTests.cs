using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class SandboxInputsTests : IDisposable
{
    private readonly string root = Directory.CreateTempSubdirectory("hosty-sandbox-inputs-").FullName;

    [Theory]
    [InlineData(".", "apps/demo-app/next-env.d.ts")]
    [InlineData("apps/demo-app", "generated/next-env.d.ts")]
    public void GeneratedSourceSupportsNestedMountsAndFiles(string mount, string file)
    {
        var path = Path.Combine(root, mount, file);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "// Generated framework metadata");
        SandboxInputs.ValidateGeneratedSource(root, mount, [file]);
    }

    [Theory]
    [InlineData("../outside", "next-env.d.ts")]
    [InlineData(".", "../next-env.d.ts")]
    [InlineData(".", "/etc/passwd")]
    [InlineData(".", "apps/../../next-env.d.ts")]
    public void GeneratedSourceRejectsTraversal(string mount, string file)
        => Assert.Equal("sandbox_path_invalid", Assert.Throws<SandboxException>(
            () => SandboxInputs.ValidateGeneratedSource(root, mount, [file])).Code);

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void GeneratedSourceRejectsLinkedMountsAndFiles(bool linkedMount)
    {
        var target = Path.Combine(root, "target"); Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, "next-env.d.ts"), "// Metadata");
        if (linkedMount) Directory.CreateSymbolicLink(Path.Combine(root, "linked"), target);
        else File.CreateSymbolicLink(Path.Combine(root, "linked"), Path.Combine(target, "next-env.d.ts"));
        Assert.Equal("sandbox_path_invalid", Assert.Throws<SandboxException>(() =>
            SandboxInputs.ValidateGeneratedSource(root, linkedMount ? "linked" : ".",
                [linkedMount ? "next-env.d.ts" : "linked"])).Code);
    }

    [Fact]
    public void GeneratedSourceRequiresAnExistingFile()
        => Assert.Equal("sandbox_recipe_unsupported", Assert.Throws<SandboxException>(
            () => SandboxInputs.ValidateGeneratedSource(root, ".", ["missing.d.ts"])).Code);

    public void Dispose() => Directory.Delete(root, true);
}
