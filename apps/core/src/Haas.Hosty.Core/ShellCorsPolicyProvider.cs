using Microsoft.AspNetCore.Cors.Infrastructure;

namespace Haas.Hosty.Core;

// Resolves the Shell CORS policy per request instead of baking it at startup. The allowed origin now
// comes from Shell's app record (see ShellPublicOriginResolver), which an operator can change from the
// Public Origins tab at any time — a policy built once at boot would keep allowing the old origin until
// Core restarted. ICorsPolicyProvider is the async seam for exactly this; the resolver's own cache keeps
// the per-request cost off the disk.
//
// No Shell installed (it is an optional distribution app) means no origin to allow: the policy is
// returned with an empty origin list, so nothing matches and no CORS headers are emitted.
internal sealed class ShellCorsPolicyProvider(ShellPublicOriginResolver shellOrigin) : ICorsPolicyProvider
{
    public const string PolicyName = "HostyShell";

    public async Task<CorsPolicy?> GetPolicyAsync(HttpContext context, string? policyName)
    {
        if (!string.Equals(policyName, PolicyName, StringComparison.Ordinal))
        {
            return null;
        }

        var policy = new CorsPolicyBuilder()
            .AllowCredentials()
            .AllowAnyHeader()
            .AllowAnyMethod();

        if (await shellOrigin.ResolveAsync(context.RequestAborted) is { } origin)
        {
            policy.WithOrigins(origin);
        }

        return policy.Build();
    }
}
