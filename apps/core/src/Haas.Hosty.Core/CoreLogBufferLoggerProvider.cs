using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Feeds CoreLogBuffer from the standard logging pipeline, so everything Core (or the framework under
// it) writes is available in memory without a second logging call anywhere in the codebase.
//
// The alias is what a `Logging:CoreLogBuffer:LogLevel:*` configuration section binds to. It matters
// because this provider deliberately runs at a *different* verbosity from the console: the console is
// `core.log` and is quieted to Warning for framework categories, while this provider keeps them at
// Information so the request trail stays available in the dialog, bounded and in memory. See the
// filter set up in HostyCoreApplication.ConfigureServices.
[ProviderAlias("CoreLogBuffer")]
internal sealed class CoreLogBufferLoggerProvider(CoreLogBuffer buffer, IClock clock) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new CoreLogBufferLogger(buffer, clock, categoryName);

    public void Dispose()
    {
    }

    private sealed class CoreLogBufferLogger(CoreLogBuffer buffer, IClock clock, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        // The filter pipeline decides what reaches Log; anything that gets here belongs in the ring.
        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            // Format eagerly: the state is often a pooled/struct holder the pipeline reuses after this
            // call returns, so keeping a reference instead of a string would read torn values later.
            buffer.Add(
                clock.UtcNow,
                logLevel,
                category,
                formatter(state, exception) ?? string.Empty,
                exception?.ToString());
        }
    }
}
