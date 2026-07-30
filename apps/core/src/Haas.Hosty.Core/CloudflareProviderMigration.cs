using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// One-time migration for hosts that connected a Cloudflare API token while the ingress provider was
// still "none".
//
// Before the API path became a provider, connecting was the only thing an operator could do: the
// provider enum held "none" and "cloudflared", and Shell offered publishing only under "cloudflared" —
// which then re-derived and overwrote every published origin on the next start. So a host with a stored
// connection and provider "none" is a host that asked for Cloudflare ingress and got a connection that
// could not publish anything.
//
// Moving it to "cloudflare-remote" is derived from persisted state, not guessed: storing a connection
// has no other purpose. Any other provider value is left alone — an operator running the local config
// file has made a different choice, and a host that already selected the API provider needs nothing.
internal sealed class CloudflareProviderMigration(
    CoreSettingsService settings,
    CloudflareIntegrationStore integration,
    ILogger<CloudflareProviderMigration> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            var provider = settings.Ingress.Provider;
            if (!string.Equals(provider, IngressSettings.ProviderNone, StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            if (!await integration.IsConnectedAsync(cancellationToken))
            {
                return;
            }

            await settings.UpdateAsync(
                new Dictionary<string, string?>(StringComparer.Ordinal)
                {
                    ["HOSTY_INGRESS_PROVIDER"] = IngressSettings.ProviderCloudflareRemote,
                },
                cancellationToken);
            logger.LogInformation(
                "Cloudflare is connected but the ingress provider was '{Previous}'; selected '{Provider}' so published endpoints are served.",
                IngressSettings.ProviderNone,
                IngressSettings.ProviderCloudflareRemote);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Never block startup on this: the operator can select the provider by hand, and every
            // publish path already refuses clearly when the provider is not the API one.
            logger.LogWarning(ex, "Cloudflare ingress provider migration did not complete.");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
