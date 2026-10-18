using System.Text.RegularExpressions;
using System.Text;
using System.Security.Cryptography;
using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

internal sealed record AppCreationRequest(string RequestId, string AppId, string Name,
    string? Description = null, bool BootstrapCommit = false, string? AuthorName = null, string? AuthorEmail = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? IconPng = null);
internal sealed record AppCreationOperation(string Id, WorkspaceOwner Owner, AppCreationRequest Request,
    string Fingerprint, string SourcePath, string Stage, string? Commit = null, DateTimeOffset? Installation = null, string? BootstrapFingerprint = null);
internal sealed record AppCreationCapabilities(PublicationIdentity? GitIdentity, string BootstrapRevision = "1");
internal sealed record AppDevelopmentGuideTopic(string Id, string Title);
internal sealed record AppDevelopmentGuide(string Revision, string Text, string CoreVersion,
    string ManifestSchema, string Topic, IReadOnlyList<AppDevelopmentGuideTopic> Topics);
internal sealed record AppCreationResult(AppCreationOperation Operation, DevelopmentWorkspace? Workspace = null);

internal sealed partial class CoreLifecycleService
{
    private readonly SemaphoreSlim creationGate = new(1, 1);

    private string CreationRecord(string id) => Path.Combine(paths.CoreRoot, "authoring", id + ".json");

    internal async Task<AppCreationOperation> ReadCreationAsync(WorkspaceOwner owner, string id, CancellationToken ct)
    {
        if (!Guid.TryParse(id, out var key)) throw new AppLifecycleException("creation_request_invalid", "Use a UUID requestId.");
        var operation = await JsonStorage.ReadAsync<AppCreationOperation>(CreationRecord(key.ToString("N")), ct)
            ?? throw new AppLifecycleException("creation_not_found", "Creation operation not found.");
        if (!operation.Owner.SameIdentity(owner)) throw new AppIdentityException("app_access_denied", "This creation belongs to another session.");
        return operation;
    }

    internal async Task<AppCreationResult> CreateLocalAppAsync(WorkspaceOwner owner, AppCreationRequest input,
        PublicationIdentity? configuredAuthor, CancellationToken ct)
    {
        if (!Guid.TryParse(input.RequestId, out var requestId))
            throw new AppLifecycleException("creation_request_invalid", "Use a UUID requestId and reuse it after an uncertain response.");
        if (!Regex.IsMatch(input.AppId ?? "", "^[a-z0-9][a-z0-9._-]{0,62}$") || input.AppId!.Contains("..", StringComparison.Ordinal))
            throw new AppLifecycleException("creation_app_invalid", "Use a valid app id without parent-directory segments.");
        if (string.IsNullOrWhiteSpace(input.Name) || input.Name.Length > 120 || input.Name.Any(char.IsControl)
            || input.Description?.Length > 4000)
            throw new AppLifecycleException("creation_metadata_invalid", "Supply a name up to 120 characters and a description up to 4000.");
        if (!input.BootstrapCommit)
            throw new AppLifecycleException("creation_commit_consent_required", "Create requires consent to one bootstrap commit; later code commits are separate.");
        var icon = AppCreationIcon.Read(input.IconPng);
        await creationGate.WaitAsync(ct);
        try
        {
            return await WithAppLockAsync(input.AppId!, async () =>
            {
                var key = requestId.ToString("N");
                var recordPath = CreationRecord(key);
                var fingerprint = DevelopmentWorkspaceService.Hash(CoreJson.Text(input));
                var root = Path.GetFullPath(paths.ResolveManagedCheckoutPath(input.AppId!));
                var operation = await JsonStorage.ReadAsync<AppCreationOperation>(recordPath, ct);
                var installed = await apps.GetAppAsync(input.AppId!, ct);
                var files = AppCreationBootstrap.Files(input.AppId!, input.Name, input.Description, icon is not null)
                    .ToDictionary(pair => pair.Key, pair => Encoding.UTF8.GetBytes(pair.Value), StringComparer.Ordinal);
                if (icon is not null) files["icon.png"] = icon;
                var bootstrapFingerprint = DevelopmentWorkspaceService.Hash(string.Join("\n", files.OrderBy(pair => pair.Key, StringComparer.Ordinal)
                    .Select(pair => pair.Key + ":" + Convert.ToHexStringLower(SHA256.HashData(pair.Value)))));
                if (operation is not null)
                {
                    if (!operation.Owner.SameIdentity(owner)) throw new AppIdentityException("app_access_denied", "This creation belongs to another session.");
                    if (operation.Fingerprint != fingerprint || operation.SourcePath != root)
                        throw new AppLifecycleException("creation_request_conflict", "Retry with the original requestId and arguments.");
                    if (operation.Stage == "installed")
                    {
                        if (installed?.InstalledAt != operation.Installation || installed?.SourceState?.Type != "local-git")
                            throw new AppLifecycleException("creation_app_changed", "The created app was removed or replaced. Do not recreate it by replay.");
                        return new AppCreationResult(operation);
                    }
                }
                else
                {
                    var selectedAuthor = new PublicationIdentity(input.AuthorName ?? configuredAuthor?.Name ?? "", input.AuthorEmail ?? configuredAuthor?.Email ?? "");
                    if (string.IsNullOrWhiteSpace(selectedAuthor.Name) || selectedAuthor.Name.Length > 200 || selectedAuthor.Name.Any(c => char.IsControl(c) || c is '<' or '>')
                        || string.IsNullOrWhiteSpace(selectedAuthor.Email) || selectedAuthor.Email.Length > 254 || !selectedAuthor.Email.Contains('@')
                        || selectedAuthor.Email.Any(c => char.IsWhiteSpace(c) || char.IsControl(c) || c is '<' or '>'))
                        throw new AppLifecycleException("creation_author_required", "Configure a Git name/email or explicitly provide the bootstrap author.");

                    if (installed is not null || Directory.Exists(root) && Directory.EnumerateFileSystemEntries(root).Any() || File.Exists(root))
                        throw new AppLifecycleException("creation_source_exists", "App or source already exists. Nothing was overwritten.");
                    operation = new(key, owner, input with { AuthorName = selectedAuthor.Name, AuthorEmail = selectedAuthor.Email },
                        fingerprint, root, "reserved", BootstrapFingerprint: bootstrapFingerprint);
                    await JsonStorage.WriteAsync(recordPath, operation, restrictToOwner: true);
                }
                // Recover with the originally selected identity even if the user's profile changed.
                var author = new PublicationIdentity(operation.Request.AuthorName!, operation.Request.AuthorEmail!);
                if (CoreDataPaths.ContainsSymbolicLink(paths.AppsRoot, root))
                    throw new AppLifecycleException("creation_source_changed", "The source directory was replaced with a link.");
                Directory.CreateDirectory(root);
                if (operation.BootstrapFingerprint != bootstrapFingerprint)
                    throw new AppLifecycleException("creation_bootstrap_changed", "The packaged bootstrap changed during creation. Preserve the source and resume with its original Core version.");
                if (operation.Stage == "reserved")
                {
                    foreach (var entry in Directory.EnumerateFileSystemEntries(root))
                    {
                        var relative = Path.GetRelativePath(root, entry).Replace('\\', '/');
                        if (!files.ContainsKey(relative))
                            throw new AppLifecycleException("creation_source_changed", "Partial bootstrap contains unexpected files; preserve them and repair explicitly.");
                    }
                    foreach (var (relative, bytes) in files)
                    {
                        var path = Path.Combine(root, relative);
                        if (File.Exists(path))
                        {
                            if (CoreDataPaths.ContainsSymbolicLink(root, path) || !(await File.ReadAllBytesAsync(path, ct)).AsSpan().SequenceEqual(bytes))
                                throw new AppLifecycleException("creation_source_changed", "Partial bootstrap was edited; creation will not overwrite it.");
                        }
                        else await File.WriteAllBytesAsync(path, bytes, ct);
                    }
                    operation = operation with { Stage = "written" };
                    await JsonStorage.WriteAsync(recordPath, operation, restrictToOwner: true);
                }
                // Pending creation may resume only over the exact reviewed bootstrap. In particular,
                // never install an edited manifest or commit additional paths after a lost response.
                if (operation.Stage is "written" or "committed")
                {
                    foreach (var (relative, bytes) in files)
                    {
                        var path = Path.Combine(root, relative);
                        if (CoreDataPaths.ContainsSymbolicLink(root, path) || !File.Exists(path) || !(await File.ReadAllBytesAsync(path, ct)).AsSpan().SequenceEqual(bytes))
                            throw new AppLifecycleException("creation_source_changed", "Pending bootstrap was edited; creation will not overwrite or install it.");
                    }
                    foreach (var entry in Directory.EnumerateFileSystemEntries(root))
                        if (Path.GetFileName(entry) != ".git" && !files.ContainsKey(Path.GetFileName(entry)))
                            throw new AppLifecycleException("creation_source_changed", "Pending bootstrap contains unreviewed files.");
                    var metadata = Path.Combine(root, ".git");
                    if (CoreDataPaths.ContainsSymbolicLink(root, metadata) || File.Exists(metadata))
                        throw new AppLifecycleException("creation_source_changed", "Bootstrap Git metadata was replaced.");
                }
                if (operation.Stage == "written")
                {
                    await DevelopmentWorkspaceService.Git(root, ["init", "--initial-branch=main"], ct);
                    var index = Path.Combine(paths.CoreRoot, "authoring", key + ".index");
                    try
                    {
                        File.Delete(index);
                        await DevelopmentWorkspaceService.Git(root, ["read-tree", "--empty"], ct, index: index);
                        await DevelopmentWorkspaceService.Git(root, ["add", "--", .. files.Keys], ct, index: index);
                        var tree = (await DevelopmentWorkspaceService.Git(root, ["write-tree"], ct, index: index)).StandardOutput.Trim();
                        var command = new WorkspaceCommand(Guid.NewGuid().ToString(), Message: "chore: initialize local app\n\nCreate the reviewed Hosty Docker bootstrap.\n",
                            AuthorName: author.Name, AuthorEmail: author.Email);
                        var commit = (await DevelopmentWorkspaceService.Git(root, ["commit-tree", tree, "-m", command.Message!], ct, author: command)).StandardOutput.Trim();
                        operation = operation with { Stage = "committed", Commit = commit };
                        await JsonStorage.WriteAsync(recordPath, operation, restrictToOwner: true);
                    }
                    finally { File.Delete(index); }
                }
                if (operation.Stage == "committed")
                {
                    var head = await DevelopmentWorkspaceService.Git(root, ["rev-parse", "--verify", "HEAD"], ct, true);
                    if (head.ExitCode != 0)
                        await DevelopmentWorkspaceService.Git(root, ["update-ref", "refs/heads/main", operation.Commit!, new string('0', 40)], ct);
                    else if (head.StandardOutput.Trim() != operation.Commit)
                        throw new AppLifecycleException("creation_source_changed", "The bootstrap branch changed; creation will not reset it.");
                    await DevelopmentWorkspaceService.Git(root, ["reset", "--quiet", "HEAD", "--", .. files.Keys], ct);
                    if (installed is not null)
                    {
                        if (installed.SourceState?.Type != "local-git" || installed.SourceState.LocalOverridePath != root
                            || installed.SourceState.Commit != operation.Commit)
                            throw new AppLifecycleException("creation_app_changed", "An unrelated installation exists.");
                    }
                    else
                    {
                        var selection = await manifests.LoadAsync(Path.Combine(root, "manifest.json"), "dev", ct, validateAllProfiles: true);
                        await InstallCoreAsync(new(Path.Combine(root, "manifest.json"), "dev", Autostart: false, StartOnInstall: false),
                            selection, ct, authoredSource: new("local-git", root, "main", operation.Commit, root, root, clock.UtcNow));
                        installed = await apps.GetAppAsync(input.AppId!, ct);
                    }
                    operation = operation with { Stage = "installed", Installation = installed!.InstalledAt };
                    await JsonStorage.WriteAsync(recordPath, operation, restrictToOwner: true);
                }
                return new AppCreationResult(operation);
            }, ct);
        }
        finally { creationGate.Release(); }
    }
}
