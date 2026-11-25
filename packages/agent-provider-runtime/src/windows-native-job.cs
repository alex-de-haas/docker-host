// A Windows-only bridge compiled by stock Windows PowerShell. The receipt writer owns the job
// outside its member tree. It never opens a retained PID to terminate an unrelated process.
// Win32 contracts: https://learn.microsoft.com/windows/win32/procthread/job-objects
// https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class HostyNativeJob
{
    const uint CreateSuspended = 0x4, ExtendedStartup = 0x80000, CreateNoWindow = 0x08000000;
    const uint KillOnClose = 0x2000, Synchronize = 0x100000, QueryLimitedInformation = 0x1000;
    const uint WaitTimeout = 258, Infinite = 0xffffffff;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    [DataContract] public sealed class Configuration {
        [DataMember(IsRequired = true)] public int version;
        [DataMember(IsRequired = true)] public string runId;
        [DataMember(IsRequired = true)] public string generation;
        [DataMember(IsRequired = true)] public string nonce;
        [DataMember(IsRequired = true)] public string file;
        [DataMember(IsRequired = true)] public string command;
        [DataMember(IsRequired = true)] public string[] args;
        [DataMember(IsRequired = true)] public string cwd;
        [DataMember] public bool cancelled;
    }
    [DataContract] sealed class Control {
        [DataMember] public bool stop = false;
        [DataMember] public string nonce = null;
    }
    [DataContract] sealed class Message {
        [DataMember] public int version = 1;
        [DataMember] public string type;
        [DataMember] public string nonce;
        [DataMember] public uint nativePid;
        [DataMember] public int code;
        [DataMember] public bool treeStopped;
        [DataMember] public uint activeProcesses;
        [DataMember] public bool knownHandlesClosed;
        [DataMember] public string mechanism = "windows-job.1";
    }
    [DataContract] sealed class Receipt {
        [DataMember] public int version = 1;
        [DataMember] public string runId;
        [DataMember] public string generation;
        [DataMember] public string nonce;
        [DataMember] public string state;
        [DataMember] public bool treeStopped;
        [DataMember] public uint activeProcesses;
        [DataMember] public bool knownHandlesClosed;
        [DataMember] public int writerPid;
        [DataMember] public uint nativePid;
        [DataMember] public int code;
        [DataMember] public string mechanism = "windows-job.1";
        [DataMember] public string observedAt;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public uint Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }

    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr value, uint size, IntPtr returned);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool member);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32", SetLastError = true)] static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint id);
    [DllImport("kernel32")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint options);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx info, out ProcessInformation process);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint SearchPath(string path, string file, string extension, int capacity, StringBuilder result, IntPtr lastPart);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateNamedPipe(string name, uint access, uint mode, uint instances, uint outputSize, uint inputSize, uint timeout, ref SecurityAttributes attributes);
    [DllImport("advapi32", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string descriptor, uint revision, out IntPtr result, out uint size);
    [DllImport("kernel32")] static extern IntPtr LocalFree(IntPtr value);

    static Exception Failure(string message) { return new IOException(message, new Win32Exception(Marshal.GetLastWin32Error())); }
    static string ReadLine(TextReader reader, int maximum) {
        var value = new StringBuilder(); int next;
        while ((next = reader.Read()) >= 0) { if (next == 10) return value.ToString().TrimEnd('\r'); if (value.Length >= maximum) throw new IOException("Control message exceeds its bound."); value.Append((char)next); }
        return value.Length == 0 ? null : value.ToString();
    }
    static T Decode<T>(string value) {
        if (value == null) throw new EndOfStreamException();
        using (var stream = new MemoryStream(Utf8.GetBytes(value))) return (T)new DataContractJsonSerializer(typeof(T)).ReadObject(stream);
    }
    static string Encode<T>(T value) { using (var stream = new MemoryStream()) { new DataContractJsonSerializer(typeof(T)).WriteObject(stream, value); return Utf8.GetString(stream.ToArray()); } }
    static NamedPipeServerStream PrivatePipe(string name) {
        string sid; using (var identity = WindowsIdentity.GetCurrent()) { if (identity.User == null) throw new IOException("The native job owner identity is unavailable."); sid = identity.User.Value; }
        IntPtr descriptor; uint bytes;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;" + sid + ")", 1, out descriptor, out bytes)) throw Failure("Native control pipe protection failed.");
        try {
            var attributes = new SecurityAttributes { Length = (uint)Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor, Inherit = false };
            // First-instance-only, duplex, overlapped, local clients only. Neither the pipe nor
            // its ACL is inherited by native commands; only the current OS identity can connect.
            IntPtr handle = CreateNamedPipe("\\\\.\\pipe\\" + name, 3 | 0x40000000 | 0x80000, 8, 1, 8192, 8192, 0, ref attributes);
            if (handle == new IntPtr(-1)) throw Failure("Native control pipe creation failed.");
            var pipe = new NamedPipeServerStream(PipeDirection.InOut, true, false, new SafePipeHandle(handle, true));
            try {
                var wait = pipe.BeginWaitForConnection(null, null);
                using (wait.AsyncWaitHandle) { if (!wait.AsyncWaitHandle.WaitOne(30000)) throw new TimeoutException("Native job producer did not connect."); pipe.EndWaitForConnection(wait); }
                return pipe;
            } catch { pipe.Dispose(); throw; }
        } finally { LocalFree(descriptor); }
    }
    public static string QuoteArgument(string value) {
        if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid native argument.");
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\r', '\n', '"' }) < 0) return value;
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (var letter in value) {
            if (letter == '\\') { slashes++; continue; }
            text.Append('\\', letter == '"' ? slashes * 2 + 1 : slashes); text.Append(letter); slashes = 0;
        }
        text.Append('\\', slashes * 2); return text.Append('"').ToString();
    }
    static string Executable(string command, string cwd) {
        if (String.IsNullOrWhiteSpace(command) || command.IndexOf('\0') >= 0) throw new IOException("Invalid native executable.");
        if (Path.IsPathRooted(command) || command.IndexOfAny(new[] { '\\', '/' }) >= 0) {
            string full = Path.GetFullPath(Path.IsPathRooted(command) ? command : Path.Combine(cwd, command));
            if (!File.Exists(full)) throw new FileNotFoundException("The selected native executable is unavailable."); return full;
        }
        var result = new StringBuilder(32768);
        uint length = SearchPath(null, command, Path.HasExtension(command) ? null : ".exe", result.Capacity, result, IntPtr.Zero);
        if (length == 0 || length >= result.Capacity) throw Failure("The selected native executable is unavailable."); return result.ToString();
    }
    static ProcessInformation StartSuspended(Configuration config, IntPtr job) {
        if (config.args == null || config.args.Length > 1024 || !Path.IsPathRooted(config.cwd)) throw new IOException("Invalid native launch configuration.");
        string executable = Executable(config.command, config.cwd); var command = new StringBuilder(QuoteArgument(executable));
        foreach (string arg in config.args) { command.Append(' '); command.Append(QuoteArgument(arg)); }
        if (command.Length >= 32767) throw new IOException("The Windows native command exceeds its bound.");
        var handles = new List<IntPtr>(); IntPtr attributes = IntPtr.Zero, list = IntPtr.Zero, jobList = IntPtr.Zero; bool initialized = false;
        try {
            foreach (int id in new[] { -10, -11, -12 }) {
                IntPtr source = GetStdHandle(id), target;
                if (source == IntPtr.Zero || source == new IntPtr(-1) || !DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out target, 0, true, 2)) throw Failure("Native standard handle duplication failed.");
                handles.Add(target);
            }
            IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            if (size == IntPtr.Zero) throw Failure("Native handle attribute sizing failed.");
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw Failure("Native handle attributes failed."); initialized = true;
            list = Marshal.AllocHGlobal(handles.Count * IntPtr.Size);
            for (int at = 0; at < handles.Count; at++) Marshal.WriteIntPtr(list, at * IntPtr.Size, handles[at]);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), list, new IntPtr(handles.Count * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Failure("Native inherited handle selection failed.");
            // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the named scope atomically at process creation.
            // Even a bridge crash between CreateProcess and ResumeThread leaves no unowned process.
            jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Failure("Native job creation attribute failed.");
            var startup = new StartupInfoEx { StartupInfo = new StartupInfo { cb = (uint)Marshal.SizeOf(typeof(StartupInfoEx)), dwFlags = 0x100, hStdInput = handles[0], hStdOutput = handles[1], hStdError = handles[2] }, Attributes = attributes };
            ProcessInformation process;
            if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true, CreateSuspended | ExtendedStartup | CreateNoWindow, IntPtr.Zero, config.cwd, ref startup, out process)) throw Failure("Suspended native process creation failed.");
            return process;
        } finally {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes); if (list != IntPtr.Zero) Marshal.FreeHGlobal(list); if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
            foreach (IntPtr handle in handles) CloseHandle(handle);
        }
    }
    static uint ActiveProcesses(IntPtr job) {
        Accounting accounting;
        if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw Failure("Native job accounting is unavailable.");
        return accounting.ActiveProcesses;
    }
    static List<IntPtr> CaptureMembers(IntPtr job) {
        var handles = new List<IntPtr>();
        try {
            for (int capacity = 32; capacity <= 65536; capacity *= 2) {
                int size = checked(8 + capacity * IntPtr.Size); IntPtr buffer = Marshal.AllocHGlobal(size);
                try {
                    if (!QueryInformationJobObject(job, 3, buffer, (uint)size, IntPtr.Zero)) { if (Marshal.GetLastWin32Error() == 234) continue; throw Failure("Native job members are unavailable."); }
                    int count = Marshal.ReadInt32(buffer, 4); if (count < 0 || count > capacity) throw new IOException("Invalid native job inventory.");
                    for (int at = 0; at < count; at++) {
                        uint id = checked((uint)Marshal.ReadIntPtr(buffer, 8 + at * IntPtr.Size).ToInt64()); IntPtr process = OpenProcess(Synchronize | QueryLimitedInformation, false, id);
                        if (process == IntPtr.Zero) { if (Marshal.GetLastWin32Error() == 87) continue; throw Failure("Native member handle acquisition failed."); }
                        bool member;
                        if (!IsProcessInJob(process, job, out member)) { CloseHandle(process); throw Failure("Native job membership verification failed."); }
                        if (member) handles.Add(process); else CloseHandle(process);
                    }
                    return handles;
                } finally { Marshal.FreeHGlobal(buffer); }
            }
            throw new IOException("Native job inventory exceeds its bound.");
        } catch { foreach (IntPtr handle in handles) CloseHandle(handle); throw; }
    }
    static bool TerminateAndWait(IntPtr job, IntPtr primary) {
        var handles = CaptureMembers(job); if (primary != IntPtr.Zero) handles.Add(primary);
        try {
            if (!TerminateJobObject(job, 137)) throw Failure("Native job termination failed.");
            var timeout = Stopwatch.StartNew();
            while (timeout.ElapsedMilliseconds < 5000) {
                bool exited = true;
                foreach (IntPtr handle in handles) { uint state = WaitForSingleObject(handle, 0); if (state == WaitTimeout) exited = false; else if (state != 0) throw Failure("Native member exit observation failed."); }
                if (exited && ActiveProcesses(job) == 0) return true; Thread.Sleep(25);
            }
            return false;
        } finally { foreach (IntPtr handle in handles) if (handle != primary) CloseHandle(handle); }
    }
    static void Persist(Configuration config, bool stopped, uint pid, int code) {
        var receipt = new Receipt { runId = config.runId, generation = config.generation, nonce = config.nonce, state = stopped ? "stopped" : "unknown", treeStopped = stopped, activeProcesses = stopped ? 0u : UInt32.MaxValue, knownHandlesClosed = stopped, writerPid = Process.GetCurrentProcess().Id, nativePid = pid, code = code, observedAt = DateTime.UtcNow.ToString("o") };
        string temporary = config.file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { byte[] bytes = Utf8.GetBytes(Encode(receipt)); file.Write(bytes, 0, bytes.Length); file.Flush(true); }
        File.Replace(temporary, config.file, null);
    }
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    static string JobName(string nonce) { return @"Local\Hosty-Agent-" + nonce; }

    // The admission guard serializes a delayed original bridge with the successor, including when
    // no process was created. This successor is called only under the exclusive attempt owner lock.
    public static int CloseOrFence(string receiptFile, string nonce) {
        if (!Path.IsPathRooted(receiptFile) || Path.GetFileName(receiptFile) != nonce + ".json") return 70;
        using (var gate = new FileStream(receiptFile + ".guard", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
            gate.Position = 0; gate.WriteByte(1); gate.Flush(true);
            IntPtr job = OpenJobObject(0x0004 | 0x0008, false, JobName(nonce));
            if (job == IntPtr.Zero) return Marshal.GetLastWin32Error() == 2 ? 0 : 70;
            try { return TerminateAndWait(job, IntPtr.Zero) ? 0 : 70; }
            finally { CloseHandle(job); }
        }
    }

    public static int Run(string pipeName) {
        if (pipeName == null || !System.Text.RegularExpressions.Regex.IsMatch(pipeName, "^hosty-native-[a-f0-9-]{36}$")) return 70;
        string nonce = pipeName.Substring("hosty-native-".Length); Configuration config = null; IntPtr job = IntPtr.Zero; ProcessInformation process = new ProcessInformation(); FileStream guard = null; bool stopped = false; int code = 127;
        using (var pipe = PrivatePipe(pipeName)) {
            var reader = new StreamReader(pipe, Utf8, false, 4096, true); var writer = new StreamWriter(pipe, Utf8, 4096, true) { AutoFlush = true };
            writer.WriteLine(Encode(new Message { type = "ready", nonce = nonce }));
            try {
                config = Decode<Configuration>(ReadLine(reader, 1048576));
                if (config.version != 1 || config.nonce != nonce || !Path.IsPathRooted(config.file) || !System.Text.RegularExpressions.Regex.IsMatch(config.runId ?? "", "^[A-Za-z0-9-]{1,100}$") || !System.Text.RegularExpressions.Regex.IsMatch(config.generation ?? "", "^[A-Za-z0-9-]{1,100}$")) throw new IOException("Native execution identity mismatch.");
                guard = new FileStream(config.file + ".guard", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                if (guard.ReadByte() == 1) throw new IOException("The attempt launch is already fenced.");
                job = CreateJobObject(IntPtr.Zero, JobName(nonce)); if (job == IntPtr.Zero) throw Failure("Native job creation failed.");
                // Neither BREAKAWAY_OK nor SILENT_BREAKAWAY_OK is enabled. The job handle is not inheritable.
                var limits = new ExtendedLimits { BasicLimitInformation = new BasicLimits { LimitFlags = KillOnClose } };
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw Failure("Native job limits failed.");
                int stop = 0;
                ThreadPool.QueueUserWorkItem(delegate { try { string line; while ((line = ReadLine(reader, 4096)) != null) { var control = Decode<Control>(line); if (control.stop && control.nonce == nonce) { Interlocked.Exchange(ref stop, 1); return; } } } catch { } finally { Interlocked.Exchange(ref stop, 1); } });
                if (!config.cancelled && Interlocked.CompareExchange(ref stop, 0, 0) == 0) {
                    process = StartSuspended(config, job);
                    if (Interlocked.CompareExchange(ref stop, 0, 0) == 0) {
                        if (ResumeThread(process.Thread) == UInt32.MaxValue) throw Failure("Native primary thread could not resume.");
                        writer.WriteLine(Encode(new Message { type = "started", nonce = nonce, nativePid = process.ProcessId }));
                        while (Interlocked.CompareExchange(ref stop, 0, 0) == 0) { uint state = WaitForSingleObject(process.Process, 25); if (state == 0) break; if (state != WaitTimeout) throw Failure("Native process exit observation failed."); }
                    }
                }
                uint exit; if (process.Process != IntPtr.Zero && WaitForSingleObject(process.Process, 0) == 0 && GetExitCodeProcess(process.Process, out exit)) code = unchecked((int)exit); else code = 137;
            } catch { code = 127; }
            finally {
                try {
                    if (job != IntPtr.Zero) {
                        stopped = TerminateAndWait(job, process.Process);
                    }
                    if (config != null) Persist(config, stopped, process.ProcessId, code);
                    try { writer.WriteLine(Encode(new Message { type = "stopped", nonce = nonce, nativePid = process.ProcessId, code = code, treeStopped = stopped, activeProcesses = stopped ? 0u : UInt32.MaxValue, knownHandlesClosed = stopped })); } catch { }
                } catch { try { if (config != null) Persist(config, false, process.ProcessId, 70); } catch { } stopped = false; }
                if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread); if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
                if (job != IntPtr.Zero) CloseHandle(job);
                if (guard != null) guard.Dispose();
            }
        }
        return stopped ? code : 70;
    }
}
