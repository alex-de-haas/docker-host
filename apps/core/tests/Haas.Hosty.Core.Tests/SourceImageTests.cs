using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static readonly byte[] PreviewPng = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8Z8AAAAASUVORK5CYII=");

    [Theory]
    [InlineData("Binary files a/a and b/a differ", true)]
    [InlineData("GIT binary patch\n", true)]
    [InlineData("+Binary files text in a document", false)]
    [InlineData(" GIT binary patch", false)]
    [InlineData("GIT binary patch is document text", false)]
    public void BinaryPreview_DetectsOnlyLineStartMarkersAfterLargeText(string lastLine, bool binary)
    {
        var patch = string.Concat(Enumerable.Repeat("+ordinary text\n", 250_000)) + lastLine;
        Assert.Equal(binary, AppSourceService.IsBinaryPatch(patch));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ImagePreview_NewImageHasOnlyWorkingTree(bool staged)
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllBytesAsync(Path.Combine(repository, "new.png"), PreviewPng);
        if (staged) await RunGitAsync(repository, ["add", "new.png"]);
        var diff = await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("new.png"));
        Assert.NotNull(diff.Image);
        Assert.Null(diff.Image.Before);
        Assert.Equal("data:image/png;base64," + Convert.ToBase64String(PreviewPng), diff.Image.After!.DataUrl);
        Assert.False(diff.Truncated);
        Assert.Empty(diff.Combined);
    }

    [Theory]
    [InlineData("png", "89504E470D0A1A0A", "image/png")]
    [InlineData("jpg", "FFD8FF", "image/jpeg")]
    [InlineData("gif", "474946383961", "image/gif")]
    [InlineData("webp", "524946460000000057454250", "image/webp")]
    public async Task ImagePreview_HeadBytesRoundTripExactlyAndDeletionHasOnlyBefore(string extension, string signature, string mime)
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var name = $"literal[1].{extension}";
        byte[] bytes = [.. Convert.FromHexString(signature), .. Enumerable.Range(0, 256).Select(value => (byte)value)];
        await File.WriteAllBytesAsync(Path.Combine(repository, name), bytes);
        await RunGitAsync(repository, ["--literal-pathspecs", "add", "--", name]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Image baseline"]);
        File.Delete(Path.Combine(repository, name));
        var diff = await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new(name));
        Assert.NotNull(diff.Image);
        Assert.Null(diff.Image.After);
        Assert.Equal($"data:{mime};base64,{Convert.ToBase64String(bytes)}", diff.Image.Before!.DataUrl);
    }

    [Fact]
    public async Task ImagePreview_ScopedHeadAndWorkingTreeExcludeIndexAndSiblings()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        var folder = Path.Combine(repository, "app");
        Directory.CreateDirectory(folder);
        await File.WriteAllBytesAsync(Path.Combine(folder, "image.png"), PreviewPng);
        await File.WriteAllBytesAsync(Path.Combine(repository, "outside.png"), PreviewPng);
        await RunGitAsync(repository, ["add", "."]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Images"]);
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { SourceState = app.SourceState! with { ManifestSubpath = "app" } });
        await File.WriteAllBytesAsync(Path.Combine(folder, "image.png"), [.. PreviewPng, 1]);
        await RunGitAsync(repository, ["add", "."]);
        byte[] working = [.. PreviewPng, 2];
        await File.WriteAllBytesAsync(Path.Combine(folder, "image.png"), working);
        var diff = await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("image.png"));
        Assert.Equal("data:image/png;base64," + Convert.ToBase64String(PreviewPng), diff.Image!.Before!.DataUrl);
        Assert.Equal("data:image/png;base64," + Convert.ToBase64String(working), diff.Image.After!.DataUrl);
        foreach (var path in new[] { "../outside.png", "outside.png", Path.Combine(repository, "outside.png"), ".git/config", ":(glob)*", "image.png/../image.png" })
            await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new(path)));
    }

    [Fact]
    public async Task ImagePreview_RefusesUnchangedAndIgnoredFiles()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllBytesAsync(Path.Combine(repository, "clean.png"), PreviewPng);
        await File.WriteAllTextAsync(Path.Combine(repository, ".gitignore"), "ignored.png\n");
        await RunGitAsync(repository, ["add", "."]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Images"]);
        await File.WriteAllBytesAsync(Path.Combine(repository, "ignored.png"), PreviewPng);
        foreach (var path in new[] { "clean.png", "ignored.png" })
            await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new(path)));
    }

    [Fact]
    public async Task ImagePreview_BoundsBothSidesAndRejectsDisguisedActiveContent()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        byte[] large = new byte[4 * 1024 * 1024 + 1];
        PreviewPng.CopyTo(large, 0);
        var path = Path.Combine(repository, "large.png");
        await File.WriteAllBytesAsync(path, large);
        await RunGitAsync(repository, ["add", "."]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Large image"]);
        large[^1] = 1;
        await File.WriteAllBytesAsync(path, large);
        var diff = await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("large.png"));
        Assert.Null(diff.Image!.Before!.DataUrl);
        Assert.Null(diff.Image.After!.DataUrl);
        Assert.Contains("4 MiB", diff.Image.Before.Message);
        Assert.Contains("4 MiB", diff.Image.After.Message);
        Assert.False(diff.Truncated);
        await File.WriteAllTextAsync(Path.Combine(repository, "fake.png"), "<svg onload='alert(1)'></svg>");
        var fake = await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("fake.png"));
        Assert.Null(fake.Image!.After!.DataUrl);
        Assert.Contains("not a supported", fake.Image.After.Message);
    }

    [Fact]
    public async Task ImagePreview_RejectsFilesystemAndDeletedGitSymlinks()
    {
        if (OperatingSystem.IsWindows()) return;
        var (fixture, repository) = await SourceFixtureAsync();
        var outside = Path.Combine(fixture.Root, "private.png");
        await File.WriteAllBytesAsync(outside, PreviewPng);
        var link = Path.Combine(repository, "link.png");
        File.CreateSymbolicLink(link, outside);
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("link.png")));
        await RunGitAsync(repository, ["add", "."]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Link"]);
        File.Delete(link);
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("link.png")));
        Directory.CreateSymbolicLink(Path.Combine(repository, "linked"), fixture.Root);
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("linked/private.png")));
    }

    [Fact]
    public async Task BinaryPreview_LargeUntrackedBinaryIsNotReportedAsTruncatedText()
    {
        var (fixture, repository) = await SourceFixtureAsync();
        await File.WriteAllBytesAsync(Path.Combine(repository, "data.bin"), new byte[100_000]);
        var diff = await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("data.bin"));
        Assert.True(diff.Binary);
        Assert.False(diff.Truncated);
        Assert.Null(diff.Image);
        await RunGitAsync(repository, ["add", "."]);
        await RunGitAsync(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Binary"]);
        await File.WriteAllBytesAsync(Path.Combine(repository, "data.bin"), [0, 1, 2]);
        Assert.True((await fixture.Sources.GetWorktreeDiffAsync(SourceTestApp, new("data.bin"))).Binary);
    }
}
