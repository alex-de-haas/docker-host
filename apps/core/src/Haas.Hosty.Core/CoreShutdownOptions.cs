namespace Haas.Hosty.Core;

// Cross-cutting flag set by the control-plane stop endpoint and read by the runtime-app supervisor
// during host shutdown. When KeepRuntimeApps is set, Core exits WITHOUT stopping its app containers,
// so a Core-only restart/update leaves running apps untouched — they are re-adopted on the next boot
// (DockerRuntimeAdapter.StartAsync). The stop request and the supervisor's StopAsync are decoupled
// through DI and StopApplication() drives shutdown on the same host, so one mutable singleton with a
// volatile bool is enough — there is no cross-process state to persist.
internal sealed class CoreShutdownOptions
{
    private volatile bool keepRuntimeApps;

    public bool KeepRuntimeApps
    {
        get => keepRuntimeApps;
        set => keepRuntimeApps = value;
    }
}
