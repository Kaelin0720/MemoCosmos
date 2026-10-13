"""Windows 配置：当前用户 DPAPI、私有 DACL 与不跟随重解析点的读取。"""

import base64
import ctypes
import json
import os
from functools import cache
from types import SimpleNamespace

PROTECTION = "windows-dpapi-current-user-v1"
# 固定格式标识，产品更名不能改变已有配置的解密上下文。
ENTROPY = b"YIHE_MODEL_CONFIG_V1"
UI_FORBIDDEN = 0x1
DWORD = ctypes.c_uint32
HANDLE = ctypes.c_void_p
BYTE_PTR = ctypes.POINTER(ctypes.c_ubyte)


class DataBlob(ctypes.Structure):
    _fields_ = [("size", DWORD), ("data", BYTE_PTR)]


class FileAttributes(ctypes.Structure):
    _fields_ = [("attributes", DWORD), ("reparse_tag", DWORD)]


def is_windows():
    return os.name == "nt"


def _failure():
    return OSError("Windows private configuration protection unavailable")


@cache
def _native():
    if not is_windows():
        raise _failure()
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)

    def signature(dll, name, args, result):
        function = getattr(dll, name)
        function.argtypes, function.restype = args, result

    pointer = ctypes.c_void_p
    blob = ctypes.POINTER(DataBlob)
    signature(
        crypt,
        "CryptProtectData",
        [blob, ctypes.c_wchar_p, blob, pointer, pointer, DWORD, blob],
        ctypes.c_int,
    )
    signature(
        crypt,
        "CryptUnprotectData",
        [blob, pointer, blob, pointer, pointer, DWORD, blob],
        ctypes.c_int,
    )
    signature(kernel, "LocalFree", [pointer], pointer)
    signature(kernel, "GetCurrentProcess", [], HANDLE)
    signature(kernel, "CloseHandle", [HANDLE], ctypes.c_int)
    signature(
        kernel,
        "CreateFileW",
        [ctypes.c_wchar_p, DWORD, DWORD, pointer, DWORD, DWORD, HANDLE],
        HANDLE,
    )
    signature(kernel, "GetFileType", [HANDLE], DWORD)
    signature(
        kernel, "GetFileInformationByHandleEx", [HANDLE, ctypes.c_int, pointer, DWORD], ctypes.c_int
    )
    signature(security, "OpenProcessToken", [HANDLE, DWORD, ctypes.POINTER(HANDLE)], ctypes.c_int)
    signature(
        security,
        "GetTokenInformation",
        [HANDLE, ctypes.c_int, pointer, DWORD, ctypes.POINTER(DWORD)],
        ctypes.c_int,
    )
    signature(security, "ConvertSidToStringSidW", [pointer, ctypes.POINTER(pointer)], ctypes.c_int)
    signature(
        security,
        "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        [ctypes.c_wchar_p, DWORD, ctypes.POINTER(pointer), pointer],
        ctypes.c_int,
    )
    signature(
        security,
        "GetSecurityDescriptorDacl",
        [
            pointer,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(pointer),
            ctypes.POINTER(ctypes.c_int),
        ],
        ctypes.c_int,
    )
    signature(
        security,
        "SetSecurityInfo",
        [HANDLE, ctypes.c_int, DWORD, pointer, pointer, pointer, pointer],
        DWORD,
    )
    return SimpleNamespace(kernel=kernel, crypt=crypt, security=security)


def _blob(data):
    buffer = ctypes.create_string_buffer(data)
    return DataBlob(len(data), ctypes.cast(buffer, BYTE_PTR)), buffer


def _crypt(data, *, protect):
    native = _native()
    source, source_buffer = _blob(data)
    entropy, entropy_buffer = _blob(ENTROPY)
    result = DataBlob()
    function = native.crypt.CryptProtectData if protect else native.crypt.CryptUnprotectData
    try:
        if not function(
            ctypes.byref(source),
            None,
            ctypes.byref(entropy),
            None,
            None,
            UI_FORBIDDEN,
            ctypes.byref(result),
        ):
            raise _failure()
        if not result.data or not 0 < result.size <= 32768:
            raise _failure()
        return ctypes.string_at(result.data, result.size)
    finally:
        # 保留输入缓冲区到原生调用完成，释放 DPAPI 分配的输出。
        del source_buffer, entropy_buffer
        if result.data:
            ctypes.memset(result.data, 0, result.size)
            native.kernel.LocalFree(ctypes.cast(result.data, ctypes.c_void_p))


def seal_config(data):
    plain = json.dumps(data, ensure_ascii=False).encode("utf-8")
    return {
        "protection": PROTECTION,
        "ciphertext": base64.b64encode(_crypt(plain, protect=True)).decode("ascii"),
    }


def open_config(data):
    if (
        not isinstance(data, dict)
        or set(data) != {"protection", "ciphertext"}
        or data["protection"] != PROTECTION
    ):
        raise ValueError("Windows configuration requires protected storage")
    encrypted = base64.b64decode(data["ciphertext"], validate=True)
    if not 0 < len(encrypted) <= 32768:
        raise ValueError("Invalid protected configuration")
    parsed = json.loads(_crypt(encrypted, protect=False).decode("utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("Invalid protected configuration")
    return parsed


def _open_handle(path, access, *, directory=None):
    native = _native()
    # 共享读写而不共享删除：保持句柄期间不能交换/重命名该目标。
    handle = native.kernel.CreateFileW(
        str(path), access | 0x80, 0x3, None, 3, 0x00200000 | 0x02000000, None
    )
    if handle in (None, ctypes.c_void_p(-1).value):
        raise _failure()
    attributes = FileAttributes()
    if (
        native.kernel.GetFileType(handle) != 1
        or not native.kernel.GetFileInformationByHandleEx(
            handle, 9, ctypes.byref(attributes), ctypes.sizeof(attributes)
        )
        or attributes.attributes & 0x400
        or (directory is not None and bool(attributes.attributes & 0x10) != directory)
    ):
        native.kernel.CloseHandle(handle)
        raise _failure()
    return handle


def open_read(path):
    import msvcrt

    native = _native()
    handle = _open_handle(path, 0x80000000, directory=False)
    try:
        return msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
    except OSError:
        native.kernel.CloseHandle(handle)
        raise _failure() from None


def restrict_private(path):
    native = _native()
    token, sid_text, descriptor = HANDLE(), ctypes.c_void_p(), ctypes.c_void_p()
    handle = _open_handle(path, 0x20000 | 0x40000)
    try:
        if not native.security.OpenProcessToken(
            native.kernel.GetCurrentProcess(), 0x8, ctypes.byref(token)
        ):
            raise _failure()
        size = DWORD()
        native.security.GetTokenInformation(token, 1, None, 0, ctypes.byref(size))
        if not 0 < size.value <= 4096:
            raise _failure()
        user = ctypes.create_string_buffer(size.value)
        if not native.security.GetTokenInformation(token, 1, user, size, ctypes.byref(size)):
            raise _failure()
        sid = ctypes.cast(user, ctypes.POINTER(ctypes.c_void_p)).contents.value
        if not native.security.ConvertSidToStringSidW(sid, ctypes.byref(sid_text)):
            raise _failure()
        principal = ctypes.wstring_at(sid_text)
        # 当前用户和 LocalSystem；拒绝继承 Everyone/Users 访问，子文件继承私有 ACL。
        sddl = f"D:P(A;OICI;FA;;;{principal})(A;OICI;FA;;;SY)"
        if not native.security.ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl, 1, ctypes.byref(descriptor), None
        ):
            raise _failure()
        present, defaulted, acl = ctypes.c_int(), ctypes.c_int(), ctypes.c_void_p()
        if (
            not native.security.GetSecurityDescriptorDacl(
                descriptor, ctypes.byref(present), ctypes.byref(acl), ctypes.byref(defaulted)
            )
            or not present.value
            or not acl.value
        ):
            raise _failure()
        if native.security.SetSecurityInfo(handle, 1, 0x4 | 0x80000000, None, None, acl, None):
            raise _failure()
    finally:
        if descriptor.value:
            native.kernel.LocalFree(descriptor)
        if sid_text.value:
            native.kernel.LocalFree(sid_text)
        if token.value:
            native.kernel.CloseHandle(token)
        native.kernel.CloseHandle(handle)
