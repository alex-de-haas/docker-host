namespace Haas.Hosty.Core;

internal sealed partial class GitHubPublicationProvider
{
    internal static void RequirePushSuccess(ProcessRunResult result, string branch)
    {
        if (!result.TimedOut && result.ExitCode == 0) return;

        // Provider output is untrusted and may echo credentials, headers or credential-bearing URLs.
        // Recognize a bounded set of reasons but retain only Core-owned messages, never raw output.
        var output = result.StandardOutput + "\n" + result.StandardError;
        bool Has(string text) => output.Contains(text, StringComparison.OrdinalIgnoreCase);
        const string retry = " Retry the original request ID after correcting the problem; no force-push is performed.";
        PublicationException Failure(string code, string message) => new(code, message, safeDiagnostic: true);
        if (!result.TimedOut)
        {
            if ((Has("refusing to allow an OAuth App") || Has("refusing to allow a Personal Access Token") || Has("refusing to allow a GitHub App")) &&
                Has("workflow") && Has("without"))
                throw Failure("push_workflow_permission_required", "GitHub rejected the workflow files: the selected connection needs the workflow scope (or Workflows write permission). Reauthorize that connection without disconnecting it." + retry);
            if (Has("Authentication failed") || Has("Invalid username or token") || Has("Bad credentials") || Has("HTTP 401"))
                throw Failure("push_authentication_failed", "GitHub rejected authentication for the selected Core connection. Reauthorize that connection; terminal GitHub CLI login does not renew it." + retry);
            if (Has("Write access to repository not granted") || Has("Repository not found") ||
                Has("fatal: repository ") && Has(" not found") || Has("Permission to ") && Has(" denied to ") || Has("The requested URL returned error: 403"))
                throw Failure("push_access_denied", "GitHub denied access to the repository. Check the selected connection's repository access, organization authorization and write permission." + retry);
            if (Has("GH006: Protected branch update failed") || Has("GH013: Repository rule violations found"))
                throw Failure("push_protected_branch", "GitHub rejected the push because of branch protection or repository rules. Satisfy those rules before retrying." + retry);

            // --porcelain identifies the result of the single requested ref. Unlike a transport
            // failure, an explicit rejection proves this ref update was not accepted.
            var rejected = result.StandardOutput.Split('\n').Any(line =>
            {
                var fields = line.TrimEnd('\r').Split('\t');
                return fields.Length >= 3 && fields[0] == "!" &&
                    fields[1].EndsWith(":refs/heads/" + branch, StringComparison.Ordinal);
            });
            if (rejected)
            {
                if (Has("non-fast-forward") || Has("fetch first"))
                    throw Failure("push_non_fast_forward", "GitHub rejected the push because the remote branch contains changes not included in this HEAD. Inspect and integrate the remote history before retrying." + retry);
                if (Has("protected branch") || Has("protected branch hook") || Has("repository rule"))
                    throw Failure("push_protected_branch", "GitHub rejected the push because of branch protection or repository rules. Satisfy those rules before retrying." + retry);
                throw Failure("push_rejected", "GitHub explicitly rejected the requested branch update. Check repository rules, permissions and server hooks." + retry);
            }
        }

        var reason = result.TimedOut ? "Git push timed out" :
            Has("Could not resolve host") ? "Git push could not resolve the GitHub host" :
            Has("Failed to connect") || Has("Could not connect") ? "Git push could not connect to GitHub" :
            Has("SSL certificate problem") || Has("TLS") || Has("SSL_connect") ? "Git push encountered a TLS failure" :
            Has("RPC failed") || Has("unexpected disconnect") || Has("remote end hung up") ? "Git push lost the transport connection" :
            "Git push exited with code " + result.ExitCode;
        throw Failure("push_uncertain", reason + ". The remote update is not confirmed. Inspect the remote branch and recover using the original request ID; no force-push is performed.");
    }
}
