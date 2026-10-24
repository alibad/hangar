"""Windows process facts straight from the OS (ctypes), so polling what is running costs microseconds, not a
PowerShell process: listening TCP ports with their process ids, a process's command line, and whether it is alive."""
import ctypes
import socket
from ctypes import wintypes

iphlpapi = ctypes.WinDLL("iphlpapi")
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")

TCP_TABLE_OWNER_PID_LISTENER = 3
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259
ProcessCommandLineInformation = 60

kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
kernel32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
ntdll.NtQueryInformationProcess.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG))
iphlpapi.GetExtendedTcpTable.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL, wintypes.ULONG, ctypes.c_int, wintypes.ULONG)


class UNICODE_STRING(ctypes.Structure):
    _fields_ = [("Length", wintypes.USHORT), ("MaximumLength", wintypes.USHORT), ("Buffer", ctypes.c_void_p)]


def _table(family, row_size, port_offset, pid_offset):
    size = wintypes.DWORD(0)
    iphlpapi.GetExtendedTcpTable(None, ctypes.byref(size), False, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
    for _ in range(3):
        buf = ctypes.create_string_buffer(size.value + 4096)
        size = wintypes.DWORD(len(buf))
        if iphlpapi.GetExtendedTcpTable(buf, ctypes.byref(size), False, family, TCP_TABLE_OWNER_PID_LISTENER, 0) == 0:
            break
    else:
        return []
    raw = buf.raw
    count = int.from_bytes(raw[0:4], "little")
    out = []
    for i in range(count):
        row = 4 + i * row_size
        port = socket.ntohs(int.from_bytes(raw[row + port_offset: row + port_offset + 4], "little") & 0xFFFF)
        pid = int.from_bytes(raw[row + pid_offset: row + pid_offset + 4], "little")
        out.append((port, pid))
    return out


def listening():
    """{(port, pid)} for every listening TCP socket, IPv4 and IPv6."""
    v4 = _table(socket.AF_INET, 24, 8, 20)    # state, local addr, local port, remote addr, remote port, pid
    v6 = _table(socket.AF_INET6, 56, 20, 52)  # local addr[16], scope, local port, remote addr[16], scope, port, state, pid
    return sorted(set(v4) | set(v6))


def _open(pid):
    return kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)


def command_line(pid):
    """The process's command line, or "" when Windows won't say (another user's or a protected process)."""
    h = _open(pid)
    if not h:
        return ""
    try:
        size = wintypes.ULONG(0)
        ntdll.NtQueryInformationProcess(h, ProcessCommandLineInformation, None, 0, ctypes.byref(size))
        if not size.value:
            return ""
        buf = ctypes.create_string_buffer(size.value)
        if ntdll.NtQueryInformationProcess(h, ProcessCommandLineInformation, buf, size, ctypes.byref(size)) != 0:
            return ""
        us = UNICODE_STRING.from_buffer(buf)
        return ctypes.wstring_at(us.Buffer, us.Length // 2) if us.Buffer and us.Length else ""
    finally:
        kernel32.CloseHandle(h)


def created(pid):
    """When the process started (a 100 ns tick count), or None. Windows reuses pids; a pid plus this is unique."""
    h = _open(int(pid))
    if not h:
        return None
    try:
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel32.GetProcessTimes(h, *[ctypes.byref(t) for t in times]):
            return None
        return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
    finally:
        kernel32.CloseHandle(h)


def alive(pid):
    h = _open(int(pid))
    if not h:
        return False
    try:
        code = wintypes.DWORD()
        return bool(kernel32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(h)
