using System.Diagnostics;
using System.Runtime.InteropServices;

namespace AudioUsbStudio.Shell;

/// <summary>
/// A Windows job object configured so that closing its handle kills every process inside it.
///
/// The engine is a child process, and a child process outlives its parent by default. If the
/// shell is killed from Task Manager — the case where no cleanup code of ours runs at all — the
/// engine would otherwise keep serving on a port with no window left to reach it. Tying it to a
/// job object makes the operating system the one enforcing the lifetime, so the guarantee does
/// not depend on our code getting a chance to run.
/// </summary>
public sealed class JobObject : IDisposable
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    private IntPtr _handle;

    public JobObject()
    {
        _handle = CreateJobObject(IntPtr.Zero, null);
        if (_handle == IntPtr.Zero)
        {
            throw new InvalidOperationException(
                $"CreateJobObject failed with Win32 error {Marshal.GetLastWin32Error()}");
        }

        var limits = new JobObjectExtendedLimitInformationStructure
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JobObjectLimitKillOnJobClose,
            },
        };

        var size = Marshal.SizeOf<JobObjectExtendedLimitInformationStructure>();
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, fDeleteOld: false);
            if (!SetInformationJobObject(_handle, JobObjectExtendedLimitInformation, buffer, (uint)size))
            {
                throw new InvalidOperationException(
                    $"SetInformationJobObject failed with Win32 error {Marshal.GetLastWin32Error()}");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>Puts <paramref name="process"/> under this job. Returns false if the call fails.</summary>
    public bool Assign(Process process)
    {
        ArgumentNullException.ThrowIfNull(process);
        return _handle != IntPtr.Zero && AssignProcessToJobObject(_handle, process.Handle);
    }

    public void Dispose()
    {
        if (_handle == IntPtr.Zero) return;

        // Closing the last handle is what triggers KILL_ON_JOB_CLOSE.
        CloseHandle(_handle);
        _handle = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformationStructure
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        int jobObjectInformationClass,
        IntPtr lpJobObjectInformation,
        uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);
}
