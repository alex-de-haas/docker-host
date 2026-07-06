namespace Haas.Hosty.Cli.Commands;

// A command needed a running Core but discovery reported none. This is an environment state, not a
// usage error, so CommandLine maps it to a clean exit 1 (no usage dump) — scripts can then tell "Core
// down" apart from "bad invocation" (which stays exit 2). See L-M2.
internal sealed class CoreNotRunningException()
    : Exception("Hosty Core is not running or local control discovery is unavailable.");
