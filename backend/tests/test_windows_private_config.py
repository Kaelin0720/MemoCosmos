"""跨平台验证配置逻辑；真正 DPAPI/DACL 测试只在原生 Windows 执行。"""

import ctypes
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core import windows_private_config as windows
from app.core.errors import ApiError
from app.core.model_config import ModelConfigStore
from app.core.settings import Settings
from app.schemas.agent import AgentConfigUpdate


def emulated_windows(monkeypatch):
    sealed, access = {}, []

    def crypt(data, *, protect):
        if protect:
            cipher = b"encrypted-fixture-" + bytes([len(sealed)])
            sealed[cipher] = data
            return cipher
        if data not in sealed:
            raise OSError("protection failed with test-secret")
        return sealed[data]

    monkeypatch.setattr(windows, "is_windows", lambda: True)
    monkeypatch.setattr(windows, "_crypt", crypt)
    monkeypatch.setattr(windows, "restrict_private", lambda path: access.append(Path(path)))
    monkeypatch.setattr(
        windows, "open_read", lambda path: os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    )
    return sealed, access


def test_protected_config_encrypts_key_and_routing_metadata_survives_restart(tmp_path, monkeypatch):
    sealed, access = emulated_windows(monkeypatch)
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    store = ModelConfigStore(settings)
    status = store.save(
        AgentConfigUpdate(
            base_url="https://test.invalid/v1", model="fixture-model", api_key="test-secret"
        )
    )
    raw = settings.model_config_path().read_text()
    assert status.configured and "test-secret" not in raw
    assert "test.invalid" not in raw and "fixture-model" not in raw
    assert json.loads(raw)["protection"] == windows.PROTECTION
    assert settings.model_config_path().parent in access
    assert any(path.name.startswith(".model-") for path in access)
    assert len(sealed) == 1
    restarted = ModelConfigStore(settings)
    assert restarted.snapshot().config.api_key == "test-secret"
    changed = restarted.save(
        AgentConfigUpdate(base_url="https://new.invalid/v1", model="new-model")
    )
    assert changed.configured and changed.model == "new-model"
    assert restarted.snapshot().config.api_key == "test-secret"
    assert not list(settings.model_config_path().parent.glob(".model-*"))


@pytest.mark.parametrize("failure", ["encryption", "acl", "replace"])
def test_windows_write_failure_keeps_protected_config_never_falls_back_to_plain(
    tmp_path, monkeypatch, failure
):
    emulated_windows(monkeypatch)
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    store = ModelConfigStore(settings)
    payload = AgentConfigUpdate(
        base_url="https://test.invalid/v1", model="model", api_key="test-secret"
    )
    store.save(payload)
    before = settings.model_config_path().read_bytes()

    def failed(*args, **kwargs):
        raise OSError("native failure test-secret")

    if failure == "encryption":
        monkeypatch.setattr(windows, "seal_config", failed)
    elif failure == "acl":
        monkeypatch.setattr(windows, "restrict_private", failed)
    else:
        monkeypatch.setattr(os, "replace", failed)
    with pytest.raises(ApiError) as caught:
        store.save(payload)
    assert caught.value.code == "config_write_failed"
    assert "test-secret" not in str(caught.value)
    assert settings.model_config_path().read_bytes() == before
    assert not list(settings.model_config_path().parent.glob(".model-*"))


@pytest.mark.parametrize(
    "payload",
    [
        {"api_key": "test-secret", "base_url": "https://test.invalid/v1", "model": "model"},
        {"protection": windows.PROTECTION, "ciphertext": "not valid base64"},
        {"protection": windows.PROTECTION, "ciphertext": "YmFk"},
        {"protection": "machine-wide", "ciphertext": "YmFk"},
    ],
)
def test_unprotected_tampered_or_foreign_account_config_is_rejected_without_env_fallback(
    tmp_path, monkeypatch, payload
):
    emulated_windows(monkeypatch)
    settings = Settings(tmp_path / "memory", tmp_path / "config")
    path = settings.model_config_path()
    path.parent.mkdir(mode=0o700)
    path.write_text(json.dumps(payload))
    if os.name == "posix":
        path.chmod(0o600)
    monkeypatch.setenv("CHAT_MODEL_BASE_URL", "https://env.invalid/v1")
    monkeypatch.setenv("CHAT_MODEL_NAME", "env-model")
    monkeypatch.setenv("CHAT_MODEL_API_KEY", "env-secret")
    snapshot = ModelConfigStore(settings).snapshot()
    assert snapshot.config is None
    assert snapshot.status.source == "file" and snapshot.status.reason == "model_config_invalid"
    assert "test-secret" not in str(snapshot)


def test_dpapi_uses_current_user_noninteractive_context_and_frees_native_buffers(monkeypatch):
    calls, buffers, freed = [], [], []

    def native_call(source, description, entropy, reserved, prompt, flags, result):
        assert description is None and reserved is None and prompt is None
        source = ctypes.cast(source, ctypes.POINTER(windows.DataBlob)).contents
        entropy = ctypes.cast(entropy, ctypes.POINTER(windows.DataBlob)).contents
        calls.append(
            (
                ctypes.string_at(source.data, source.size),
                ctypes.string_at(entropy.data, entropy.size),
                flags,
            )
        )
        buffer = ctypes.create_string_buffer(b"native-result")
        buffers.append(buffer)
        output = ctypes.cast(result, ctypes.POINTER(windows.DataBlob)).contents
        output.size = len(b"native-result")
        output.data = ctypes.cast(buffer, windows.BYTE_PTR)
        return 1

    monkeypatch.setattr(
        windows,
        "_native",
        lambda: SimpleNamespace(
            crypt=SimpleNamespace(CryptProtectData=native_call, CryptUnprotectData=native_call),
            kernel=SimpleNamespace(LocalFree=lambda pointer: freed.append(pointer.value)),
        ),
    )
    assert windows._crypt(b"test-secret", protect=True) == b"native-result"
    assert windows._crypt(b"ciphertext", protect=False) == b"native-result"
    assert all(entropy == windows.ENTROPY and flags == 0x1 for _, entropy, flags in calls)
    assert len(freed) == 2 and all(buffer.raw.startswith(b"\0" * 13) for buffer in buffers)


@pytest.mark.parametrize("attributes,file_type", [(0x400, 1), (0x10, 1), (0, 2)])
def test_native_read_handle_rejects_reparse_directories_and_non_disk_handles(
    monkeypatch, attributes, file_type
):
    closed = []

    def info(handle, kind, result, size):
        ctypes.cast(result, ctypes.POINTER(windows.FileAttributes)).contents.attributes = attributes
        return 1

    monkeypatch.setattr(
        windows,
        "_native",
        lambda: SimpleNamespace(
            kernel=SimpleNamespace(
                CreateFileW=lambda *args: 17,
                GetFileType=lambda handle: file_type,
                GetFileInformationByHandleEx=info,
                CloseHandle=lambda handle: closed.append(handle),
            )
        ),
    )
    with pytest.raises(OSError):
        windows._open_handle("fixture", 0x80000000, directory=False)
    assert closed == [17]


@pytest.mark.skipif(
    os.name != "nt", reason="Requires actual Windows DPAPI, DACL and file handle APIs"
)
def test_real_windows_dpapi_private_acl_configuration_roundtrip(tmp_path):
    from app.vault.topic_files import FileIssue, TopicFiles

    settings = Settings(tmp_path / "memory", tmp_path / "config")
    store = ModelConfigStore(settings)
    status = store.save(
        AgentConfigUpdate(
            base_url="https://temporary.invalid/v1",
            model="temporary",
            api_key="temporary-windows-key",
        )
    )
    assert status.configured
    raw = settings.model_config_path().read_bytes()
    assert b"temporary-windows-key" not in raw and b"temporary.invalid" not in raw
    assert ModelConfigStore(settings).snapshot().config.api_key == "temporary-windows-key"
    # 密文修改不接受，也不将环境配置当作安全回退。
    payload = json.loads(raw)
    payload["ciphertext"] = "YmFk"
    settings.model_config_path().write_text(json.dumps(payload))
    assert ModelConfigStore(settings).snapshot().status.reason == "model_config_invalid"
    # 原生 Windows 仅配置/基础API兼容；未提供的安全笔记写入必须明确拒绝。
    with pytest.raises(FileIssue) as caught:
        TopicFiles(settings).prepare()
    assert caught.value.code == "note_storage_unavailable"


def test_private_acl_is_protected_current_user_and_system_only(monkeypatch):
    calls, closed, freed = [], [], []
    sid_buffer = ctypes.create_unicode_buffer("S-1-5-21-1234")
    descriptor_buffer = ctypes.create_string_buffer(32)
    acl_buffer = ctypes.create_string_buffer(32)

    def token(process, access, result):
        assert access == 0x8
        ctypes.cast(result, ctypes.POINTER(windows.HANDLE)).contents.value = 99
        return 1

    def info(token, kind, buffer, size, required):
        ctypes.cast(required, ctypes.POINTER(windows.DWORD)).contents.value = 64
        if buffer is not None:
            ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p)).contents.value = 55
            return 1
        return 0

    def sid_to_text(sid, result):
        assert sid == 55
        ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p)).contents.value = ctypes.addressof(
            sid_buffer
        )
        return 1

    def descriptor(text, revision, result, size):
        calls.append(text)
        ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p)).contents.value = ctypes.addressof(
            descriptor_buffer
        )
        return 1

    def dacl(descriptor, present, result, defaulted):
        ctypes.cast(present, ctypes.POINTER(ctypes.c_int)).contents.value = 1
        ctypes.cast(result, ctypes.POINTER(ctypes.c_void_p)).contents.value = ctypes.addressof(
            acl_buffer
        )
        return 1

    def set_acl(handle, kind, flags, owner, group, acl, sacl):
        assert handle == 17 and kind == 1 and flags == 0x80000004
        assert owner is None and group is None and sacl is None
        return 0

    monkeypatch.setattr(windows, "_open_handle", lambda path, access: 17)
    monkeypatch.setattr(
        windows,
        "_native",
        lambda: SimpleNamespace(
            kernel=SimpleNamespace(
                GetCurrentProcess=lambda: 1,
                CloseHandle=lambda handle: closed.append(
                    handle.value if isinstance(handle, windows.HANDLE) else handle
                ),
                LocalFree=lambda pointer: freed.append(pointer.value),
            ),
            security=SimpleNamespace(
                OpenProcessToken=token,
                GetTokenInformation=info,
                ConvertSidToStringSidW=sid_to_text,
                ConvertStringSecurityDescriptorToSecurityDescriptorW=descriptor,
                GetSecurityDescriptorDacl=dacl,
                SetSecurityInfo=set_acl,
            ),
        ),
    )
    windows.restrict_private("temporary-model-config")
    assert calls == ["D:P(A;OICI;FA;;;S-1-5-21-1234)(A;OICI;FA;;;SY)"]
    assert set(closed) == {17, 99} and len(freed) == 2
