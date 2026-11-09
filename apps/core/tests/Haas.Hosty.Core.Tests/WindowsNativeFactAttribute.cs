namespace Haas.Hosty.Core.Tests;

internal sealed class WindowsNativeFactAttribute : FactAttribute
{
    public WindowsNativeFactAttribute()
    {
        if (!OperatingSystem.IsWindows()) Skip = "Requires the native Windows process environment.";
    }
}
