using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed record SandboxServiceLog(string Service, string State, string Text);
internal sealed record SandboxDiagnostics(string InstanceId, string State, string? ErrorCode, SandboxServiceLog[] Services);

internal static partial class SandboxLogText
{
    internal static string Sanitize(string text)
    {
        // App output is untrusted data. Remove control codes and common credential forms before
        // truncation so the API never exposes the tail of a truncated credential match.
        text = Secret().Replace(text, "[redacted]");
        text = new string(text.Where(c => c is '\n' or '\t' || !char.IsControl(c)).ToArray());
        return text.Length <= 16384 ? text : "[earlier output omitted]\n" + text[^16384..];
    }
    [GeneratedRegex(@"(?i)(?:hostysb_[a-z0-9_\-]+|hostyg_[a-z0-9_\-]+|Bearer\s+[^\s""']+|(?:password|token|secret)\s*[:=]\s*[^\s,;]+|eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+)")]
    private static partial Regex Secret();
}
