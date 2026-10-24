using System.Text.Json.Serialization;

namespace Haas.Hosty.Launch;

// A normal CLI rebuild continues one exact workspace owner. The separate receipt is published
// before stopping Core and retains the prepared executable if the helper loses its ready reply.
internal sealed record WorkspaceCoreLaunchReceipt(string Id, string ActivationId, CoreLaunchIdentity Before,
    string Executable, string Generation, string ExecutableHash, string State, DateTimeOffset CreatedAt,
    CoreLaunchIdentity? Ready = null, bool ExplicitAdoption = false);

internal static class WorkspaceCoreLaunchContinuation
{
    private static string Root(string root) => Path.Combine(root, "core", "workspace-launches");
    private static string PathFor(string root, string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Use the original launch request UUID without hyphens.");
        return Path.Combine(Root(root), id + ".json");
    }
    internal static WorkspaceCoreLaunchReceipt[] List(string root) => !Directory.Exists(Root(root)) ? [] :
        Directory.EnumerateFiles(Root(root), "*.json").Select(p => CoreLaunchFiles.Read(p,
            WorkspaceCoreLaunchJson.Default.WorkspaceCoreLaunchReceipt) ?? throw new IOException("A workspace launch receipt is unreadable.")).ToArray();
    private static void Save(string root, WorkspaceCoreLaunchReceipt receipt) => CoreLaunchFiles.Write(
        PathFor(root, receipt.Id), receipt, WorkspaceCoreLaunchJson.Default.WorkspaceCoreLaunchReceipt);
    internal static IEnumerable<string> PendingGenerations(string root) => List(root).Where(r => r.State != "completed").Select(r => r.Generation);
    private static bool Owns(WorkspaceRuntimeActivation a) => a.Phase == "active" && a.CoreProject is not null &&
        !a.CoreReturned && a.CoreSupersededBy is null && a.CoreReserved;

    internal static WorkspaceRuntimeActivation? Owner(string root, CoreLaunchIdentity? current, string? project)
    {
        var owners = WorkspaceRuntimeFiles.List(root).Where(Owns).ToArray();
        if (owners.Length == 0) return null;
        var exact = current is null ? owners.Where(a => a.CoreProject == project).ToArray() :
            owners.Where(a => a.ActivatedCore == current && WorkspaceActivationHandover.IsCandidate(a, current)).ToArray();
        if (exact.Length > 1) throw new InvalidOperationException("Multiple workspace activations claim Core. Recover their ownership before restarting.");
        if (exact.Length == 0)
        {
            if (owners.Any(a => a.CoreProject == project || a.CoreProject == current?.ProjectPath))
                throw new InvalidOperationException("Core changed outside its workspace activation. Use explicit administrator adoption with its exact current instance before restarting.");
            return null;
        }
        var owner = exact[0];
        if (project != owner.CoreProject) throw new InvalidOperationException("Switch Core through its workspace operation or Return before selecting a different launch target.");
        if (current is null && (owner.ActivatedCore is null || CoreBuildRetention.IsAlive(owner.ActivatedCore.ProcessId, owner.ActivatedCore.StartedAt)))
            throw new IOException("The workspace Core is alive or its previous identity is unknown. No replacement was started.");
        return owner;
    }

    // The caller holds launch.lock. The old activation and its original Return target stay intact
    // until readiness confirms this exact prepared generation.
    internal static WorkspaceCoreLaunchReceipt? Prepare(string root, string id, CoreLaunchIdentity? current,
        string? project, string executable, string? generation)
    {
        if (current is not null) Reconcile(root, current);
        var owner = Owner(root, current, project);
        if (owner is null) return null;
        if (generation is null) throw new InvalidOperationException("Workspace Core continuation requires a managed build generation.");
        var prior = CoreLaunchFiles.Read(PathFor(root, id), WorkspaceCoreLaunchJson.Default.WorkspaceCoreLaunchReceipt);
        if (prior is not null)
        {
            if (prior.ActivationId != owner.Id || prior.Generation != generation || prior.Executable != executable)
                throw new InvalidOperationException("Preserve the original workspace launch request and prepared target.");
            return prior;
        }
        if (List(root).Any(r => r.State != "completed")) throw new InvalidOperationException("Recover the retained workspace launch before preparing another generation.");
        var hash = ValidateManaged(root, project!, executable, generation);
        var receipt = new WorkspaceCoreLaunchReceipt(id, owner.Id, current ?? owner.ActivatedCore!, executable,
            generation, hash, "prepared", DateTimeOffset.UtcNow);
        Save(root, receipt);
        return receipt;
    }

    internal static WorkspaceCoreLaunchReceipt? RecoverTarget(string root, string? project, CoreLaunchIdentity? current)
    {
        if (current is not null) Reconcile(root, current);
        var pending = List(root).Where(r => r.State != "completed").ToArray();
        if (pending.Length == 0) return null;
        if (pending.Length != 1) throw new InvalidOperationException("Multiple workspace launch receipts require explicit recovery.");
        var receipt = pending[0];
        var owner = WorkspaceRuntimeFiles.Read(root, receipt.ActivationId);
        RequireOwner(owner, receipt);
        if (project != owner.CoreProject || current is not null && current != receipt.Before)
            throw new InvalidOperationException("The retained workspace launch does not own this Core or requested project. Nothing was stopped.");
        if (ValidateManaged(root, project!, receipt.Executable, receipt.Generation) != receipt.ExecutableHash)
            throw new IOException("The retained workspace executable changed. No alternate generation was started.");
        return receipt;
    }

    // Used only at a launch/admission boundary, never by GET/status projections. A lost final
    // receipt can be recovered from the exact ready managed generation, not project equality.
    internal static void Reconcile(string root, CoreLaunchIdentity current)
    {
        foreach (var receipt in List(root).Where(r => r.State != "completed"))
        {
            if (current.Mode != "dev" || current.GenerationPath != receipt.Generation) continue;
            var owner = WorkspaceRuntimeFiles.Read(root, receipt.ActivationId);
            if (current.ProjectPath != owner.CoreProject || receipt.Ready is { } ready && ready != current)
                throw new InvalidOperationException("The retained workspace launch readiness identity changed.");
            if (ValidateManaged(root, owner.CoreProject!, receipt.Executable, receipt.Generation, current) != receipt.ExecutableHash)
                throw new IOException("The prepared workspace executable changed before readiness was confirmed.");
            var readyReceipt = receipt with { State = "ready", Ready = current };
            Save(root, readyReceipt);
            if (owner.Generation != receipt.Generation || owner.ActivatedCore != current)
            {
                RequireOwner(owner, receipt);
                WorkspaceRuntimeFiles.Save(root, owner with { PreparedExecutable = receipt.Executable, Generation = receipt.Generation, ActivatedCore = current });
            }
            else if (!Owns(owner)) throw new InvalidOperationException("The workspace no longer owns this launch.");
            Save(root, readyReceipt with { State = "completed" });
        }
    }

    internal static void Adopt(string root, string id, WorkspaceRuntimeActivation reviewed,
        CoreLaunchIdentity current, string executable)
    {
        if (current.Mode != "dev" || current.ProjectPath != reviewed.CoreProject || current.GenerationPath is null || !Owns(reviewed))
            throw new InvalidOperationException("Select an active workspace and the exact matching current managed Core.");
        if (System.Text.Json.JsonSerializer.Serialize(WorkspaceRuntimeFiles.Read(root, reviewed.Id), WorkspaceRuntimeJson.Default.WorkspaceRuntimeActivation) !=
            System.Text.Json.JsonSerializer.Serialize(reviewed, WorkspaceRuntimeJson.Default.WorkspaceRuntimeActivation))
            throw new InvalidOperationException("The workspace activation changed during adoption review.");
        if (reviewed.ActivatedCore is null || List(root).Any(r => r.State != "completed"))
            throw new InvalidOperationException("Recover the original pending workspace launch before adoption.");
        var hash = ValidateManaged(root, reviewed.CoreProject!, executable, current.GenerationPath, current);
        var receipt = new WorkspaceCoreLaunchReceipt(id, reviewed.Id, reviewed.ActivatedCore, executable,
            current.GenerationPath, hash, "ready", DateTimeOffset.UtcNow, current, ExplicitAdoption: true);
        Save(root, receipt);
        Reconcile(root, current);
    }

    private static void RequireOwner(WorkspaceRuntimeActivation owner, WorkspaceCoreLaunchReceipt receipt)
    {
        if (!Owns(owner) || owner.ActivatedCore != receipt.Before || owner.Generation != receipt.Before.GenerationPath)
            throw new InvalidOperationException("The workspace activation no longer owns this launch continuation.");
    }

    internal static string ValidateManaged(string root, string project, string executable, string generation, CoreLaunchIdentity? ready = null)
    {
        var expected = Path.Combine(Path.GetFullPath(root), "core", "builds", Path.GetFileName(generation));
        if (!Guid.TryParseExact(Path.GetFileName(generation), "N", out _) || Path.GetFullPath(generation) != expected ||
            !Path.GetFullPath(executable).StartsWith(expected + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new IOException("The workspace executable is not in a managed generation of this Core instance.");
        for (var path = new FileInfo(executable) as FileSystemInfo; path is not null; path = path is FileInfo file ? file.Directory : ((DirectoryInfo)path).Parent)
        {
            if (path.LinkTarget is not null) throw new IOException("Linked workspace launch output is not eligible for adoption.");
            if (path.FullName == expected) break;
        }
        var marker = CoreLaunchFiles.Read(Path.Combine(generation, CoreBuildRetention.Marker), CoreLaunchJson.Default.CoreBuildGeneration);
        if (marker is null || marker.Id != Path.GetFileName(generation) || marker.ProjectPath != project || marker.State is not ("prepared" or "starting" or "ready") ||
            ready is not null && (marker.State != "ready" || marker.OwnerPid != ready.ProcessId || marker.OwnerStartedAt != ready.StartedAt))
            throw new IOException("The managed generation does not confirm the reviewed Core launch identity.");
        return WorkspaceActivationReturn.ExecutableHash(executable) ?? throw new IOException("The reviewed workspace executable is unavailable.");
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WorkspaceCoreLaunchReceipt))]
internal partial class WorkspaceCoreLaunchJson : JsonSerializerContext;
