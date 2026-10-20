using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Microsoft.Build.Framework;
using Microsoft.Build.Utilities;

// Runs inside MSBuild; raw remote URLs and Git output never enter build logs.
public sealed class HostyBuildIdentity : Task
{
    [Required] public string RepositoryRoot { get; set; }
    [Required] public string ProjectFile { get; set; }
    public string RepositoryOverride { get; set; }
    [Output] public string Repository { get; set; }
    [Output] public string Commit { get; set; }
    [Output] public string Dirty { get; set; }
    [Output] public string ProjectPath { get; set; }

    public override bool Execute()
    {
        var directory = Path.GetDirectoryName(ProjectFile);
        var commit = Git(directory, "rev-parse HEAD");
        if (commit != null && (commit.Length == 40 || commit.Length == 64)
            && commit.All(c => "0123456789abcdefABCDEF".Contains(c))) Commit = commit;
        var status = Git(RepositoryRoot, "status --porcelain --untracked-files=normal");
        Dirty = status == null ? null : status.Length == 0 ? "false" : "true";
        var repository = string.IsNullOrEmpty(RepositoryOverride)
            ? Git(directory, "config --get remote.origin.url") : RepositoryOverride;
        Uri uri;
        if (repository != null && !repository.Any(char.IsControl) && repository.IndexOfAny(new[] { '\'', '"', ';' }) < 0
            && Uri.TryCreate(repository, UriKind.Absolute, out uri) && (uri.Scheme == "https" || uri.Scheme == "http")
            && uri.UserInfo.Length == 0 && uri.Query.Length == 0 && uri.Fragment.Length == 0
            && uri.Host.Length > 0 && uri.AbsolutePath.Trim('/').Length > 0)
            Repository = uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        ProjectPath = Uri.UnescapeDataString(new Uri(Path.GetFullPath(RepositoryRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar)
            .MakeRelativeUri(new Uri(Path.GetFullPath(ProjectFile))).ToString());
        return true;
    }

    private static string Git(string directory, string arguments)
    {
        var start = new ProcessStartInfo("git", arguments) { WorkingDirectory = directory,
            UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var key in start.EnvironmentVariables.Keys.Cast<string>().Where(k => k.StartsWith("GIT_", StringComparison.Ordinal)).ToArray())
            start.EnvironmentVariables.Remove(key);
        start.EnvironmentVariables["GIT_CONFIG_NOSYSTEM"] = "1";
        start.EnvironmentVariables["GIT_CONFIG_GLOBAL"] = Path.DirectorySeparatorChar == '/' ? "/dev/null" : "NUL";
        try
        {
            using (var process = Process.Start(start))
            {
                var output = process.StandardOutput.ReadToEndAsync();
                var error = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(10000)) { process.Kill(); return null; }
                System.Threading.Tasks.Task.WaitAll(output, error);
                return process.ExitCode == 0 ? output.Result.Trim() : null;
            }
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception || ex is IOException) { return null; }
    }
}
