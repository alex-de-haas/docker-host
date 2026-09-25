using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

namespace Haas.Hosty.Core;

internal readonly record struct ResourceProcess(int Pid, int Parent, int Group);
internal readonly record struct ProcessReading(int Pid, long Started, double CpuSeconds, long MemoryBytes);

internal sealed class LocalResourceReader(LocalCommandProcessRegistry registry, IClock clock)
{
    private Dictionary<int, ProcessReading> previous = new();
    private long previousTick;

    public void Reset() { previous.Clear(); previousTick = 0; }

    public async Task<IReadOnlyList<RuntimeResourceSample>> ReadAsync(CancellationToken cancellationToken)
    {
        var roots = registry.Snapshot();
        IReadOnlyList<ResourceProcess> processes;
        try { processes = roots.Length == 0 ? [] : await ReadTreeAsync(cancellationToken); }
        catch (Exception ex) when (ex is IOException or Win32Exception or InvalidOperationException)
        {
            processes = [];
        }
        var tick = Stopwatch.GetTimestamp();
        var elapsed = previousTick == 0 ? 0 : Stopwatch.GetElapsedTime(previousTick, tick).TotalSeconds;
        var current = new Dictionary<int, ProcessReading>();
        var samples = new List<RuntimeResourceSample>();
        var claimed = new HashSet<int>();
        foreach (var root in roots)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var separator = root.Key.LastIndexOf('/');
            if (separator < 0) continue;
            var appId = root.Key[..separator];
            var service = root.Key[(separator + 1)..];
            try
            {
                var process = root.Value.Process;
                // The registered handle must still identify the original process. A reused PID
                // must never attach another application's resource usage to this service.
                if (process.HasExited) continue;
                var expectedStart = process.StartTime.ToUniversalTime().Ticks;
                var ids = SelectTree(processes, process.Id, root.Value.ProcessGroup);
                var readings = new List<ProcessReading>();
                var complete = ids.Count > 0;
                foreach (var id in ids)
                {
                    if (!claimed.Add(id)) { complete = false; continue; }
                    var reading = ReadProcess(id);
                    if (reading is null || id == process.Id && reading.Value.Started != expectedStart)
                    {
                        complete = false;
                        continue;
                    }
                    current[id] = reading.Value;
                    readings.Add(reading.Value);
                }
                samples.Add(new(appId, service, "localCommand", clock.UtcNow,
                    complete ? CpuPercent(readings, previous, elapsed) : null,
                    complete ? readings.Sum(r => (double)r.MemoryBytes) : null));
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException)
            {
                samples.Add(new(appId, service, "localCommand", clock.UtcNow, null, null));
            }
        }
        var core = ReadProcess(Environment.ProcessId);
        if (core is { } own)
        {
            current[own.Pid] = own;
            samples.Add(new("hosty.core", "core", "core", clock.UtcNow,
                CpuPercent([own], previous, elapsed), own.MemoryBytes));
        }
        previous = current;
        previousTick = tick;
        return samples;
    }

    internal static double? CpuPercent(IReadOnlyList<ProcessReading> current,
        IReadOnlyDictionary<int, ProcessReading> previous, double elapsed)
    {
        if (elapsed <= 0 || current.Count == 0) return null;
        double seconds = 0;
        foreach (var item in current)
        {
            // Warm up new/reused PIDs instead of treating their lifetime CPU as one interval.
            if (!previous.TryGetValue(item.Pid, out var before) || before.Started != item.Started ||
                item.CpuSeconds < before.CpuSeconds) return null;
            seconds += item.CpuSeconds - before.CpuSeconds;
        }
        return seconds / elapsed * 100;
    }

    internal static HashSet<int> SelectTree(IReadOnlyList<ResourceProcess> processes, int root, bool processGroup)
    {
        if (!processes.Any(p => p.Pid == root)) return [];
        var result = new HashSet<int> { root };
        // A POSIX session runner also owns children reparented after their shell exits.
        if (processGroup) foreach (var process in processes.Where(p => p.Group == root)) result.Add(process.Pid);
        bool changed;
        do
        {
            changed = false;
            foreach (var process in processes)
                if (result.Contains(process.Parent) && result.Add(process.Pid)) changed = true;
        } while (changed);
        return result;
    }

    private static ProcessReading? ReadProcess(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            process.Refresh();
            return new(pid, process.StartTime.ToUniversalTime().Ticks, process.TotalProcessorTime.TotalSeconds, process.WorkingSet64);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or Win32Exception or NotSupportedException)
        {
            return null;
        }
    }

    private static async Task<IReadOnlyList<ResourceProcess>> ReadTreeAsync(CancellationToken cancellationToken)
    {
        if (OperatingSystem.IsWindows()) return WindowsTree();
        // One small process inventory for the whole host, not one ps per service. Only numeric
        // ownership fields are read; no command lines, environment variables or credentials.
        var start = new ProcessStartInfo("/bin/ps");
        start.ArgumentList.Add("-axo");
        start.ArgumentList.Add("pid=,ppid=,pgid=");
        var output = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(2), cancellationToken, outputLimit: 2_000_000);
        if (output.ExitCode != 0) return [];
        return ParseTree(output.StandardOutput);
    }

    internal static IReadOnlyList<ResourceProcess> ParseTree(string output)
    {
        var result = new List<ResourceProcess>();
        foreach (var line in output.Split('\n'))
        {
            var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 3 && int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var pid) &&
                int.TryParse(parts[1], out var parent) && int.TryParse(parts[2], out var group))
                result.Add(new(pid, parent, group));
        }
        return result;
    }

    private static IReadOnlyList<ResourceProcess> WindowsTree()
    {
        var handle = CreateToolhelp32Snapshot(2, 0);
        if (handle == new IntPtr(-1)) throw new Win32Exception();
        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), ExeFile = "" };
            var result = new List<ResourceProcess>();
            if (Process32First(handle, ref entry))
                do { result.Add(new((int)entry.Pid, (int)entry.ParentPid, 0)); } while (Process32Next(handle, ref entry));
            return result;
        }
        finally { CloseHandle(handle); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, Pid;
        public UIntPtr DefaultHeap;
        public uint ModuleId, Threads, ParentPid;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }
    [DllImport("kernel32", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseHandle(IntPtr handle);
}
