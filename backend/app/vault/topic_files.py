"""受控 POSIX 目录内的 UTF-8 文件；数据库提交与文件发布分别完成。"""

import errno
import hashlib
import os
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

from app.core.settings import Settings

MAX_FILE_BYTES = 1024 * 1024


class FileIssue(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False):
        self.code = code
        self.message = message
        self.retryable = retryable
        super().__init__(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_name(note_id: str) -> str:
    if str(UUID(note_id)) != note_id:
        raise ValueError("非规范文档 ID")
    return note_id + ".md"


def temp_name(operation_id: str) -> str:
    if str(UUID(operation_id)) != operation_id:
        raise ValueError("非规范操作 ID")
    return "." + operation_id + ".tmp"


def invalid_file() -> FileIssue:
    return FileIssue("note_file_invalid", "文档不是受控的普通 UTF-8 文件")


class TopicFiles:
    def __init__(self, settings: Settings):
        settings.database_path()  # 复用源码外、记忆库内的路径边界。
        self.root = settings.memory_dir

    @contextmanager
    def _directory(self, *, create: bool = False) -> Iterator[int]:
        handles: list[int] = []
        try:
            if os.name != "posix" or not hasattr(os, "O_NOFOLLOW"):
                raise FileIssue("note_storage_unavailable", "当前系统不支持安全文档存储", True)
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            handles.append(os.open(self.root, flags))
            for name in ("notes", "topics"):
                if create:
                    try:
                        os.mkdir(name, mode=0o700, dir_fd=handles[-1])
                        os.fsync(handles[-1])
                    except FileExistsError:
                        pass
                handles.append(os.open(name, flags, dir_fd=handles[-1]))
            yield handles[-1]
        except FileNotFoundError:
            raise FileIssue("note_file_missing", "已登记的文档文件不存在") from None
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.ENOTDIR):
                raise invalid_file() from None
            raise FileIssue("note_storage_unavailable", "文档存储暂不可用", True) from None
        finally:
            for handle in reversed(handles):
                os.close(handle)

    def prepare(self) -> None:
        with self._directory(create=True):
            pass

    def ensure_absent(self, note_id: str) -> None:
        with self._directory() as directory:
            try:
                os.stat(file_name(note_id), dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                return
            raise FileIssue("external_note_changed", "目标文档文件已经存在")

    def _verify_directory(self, directory: int) -> None:
        # 在发布临界点重新确认已打开的句柄仍对应当前受控目录。
        with self._directory() as current:
            left, right = os.fstat(directory), os.fstat(current)
            if (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino):
                raise invalid_file()

    @staticmethod
    def _read_at(directory: int, name: str, *, links: int = 1) -> bytes | None:
        try:
            handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        except OSError as exc:
            if exc.errno in (errno.ELOOP, errno.EISDIR, errno.ENOTDIR):
                raise invalid_file() from None
            raise
        try:
            info = os.fstat(handle)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != links:
                raise invalid_file()
            if info.st_size > MAX_FILE_BYTES:
                raise invalid_file()
            chunks, size = [], 0
            while size <= MAX_FILE_BYTES:
                chunk = os.read(handle, min(65536, MAX_FILE_BYTES + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            data = b"".join(chunks)
            if len(data) > MAX_FILE_BYTES:
                raise invalid_file()
            try:
                data.decode("utf-8")
            except UnicodeError:
                raise invalid_file() from None
            return data
        finally:
            os.close(handle)

    @staticmethod
    def _clean_temp(directory: int, target: str, temporary: str, target_hash: str) -> None:
        try:
            info = os.stat(temporary, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return
        if not stat.S_ISREG(info.st_mode):
            raise invalid_file()
        if info.st_nlink == 2:
            try:
                destination = os.stat(target, dir_fd=directory, follow_symlinks=False)
            except FileNotFoundError:
                raise invalid_file() from None
            if (destination.st_dev, destination.st_ino) != (info.st_dev, info.st_ino):
                raise invalid_file()
            data = TopicFiles._read_at(directory, target, links=2)
            if data is None or digest(data) != target_hash:
                raise invalid_file()
        elif info.st_nlink != 1:
            raise invalid_file()
        # 只移除当前持久操作预留的临时名，不扫描或清理其他文件。
        os.unlink(temporary, dir_fd=directory)
        os.fsync(directory)

    def read(self, note_id: str) -> bytes | None:
        with self._directory() as directory:
            return self._read_at(directory, file_name(note_id))

    def remove(self, note_id: str, expected_hash: str | None) -> None:
        try:
            with self._directory() as directory:
                target = file_name(note_id)
                current = self._read_at(directory, target)
                if current is None:
                    return  # 持久删除意图在 unlink 后中断，可安全继续。
                self._check_baseline(current, expected_hash)
                self._verify_directory(directory)
                os.unlink(target, dir_fd=directory)
                os.fsync(directory)
        except FileIssue as issue:
            if issue.code == "note_file_missing":
                return
            raise

    def publish(self, note_id: str, operation_id: str, data: bytes, base_hash: str | None) -> None:
        if len(data) > MAX_FILE_BYTES:
            raise invalid_file()
        target, temporary = file_name(note_id), temp_name(operation_id)
        target_hash = digest(data)
        with self._directory(create=base_hash is None) as directory:
            self._clean_temp(directory, target, temporary, target_hash)
            current = self._read_at(directory, target)
            if current is not None and digest(current) == target_hash:
                os.fsync(directory)
                return
            self._check_baseline(current, base_hash)
            handle = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
                dir_fd=directory,
            )
            # 失败时保留本操作的临时文件，供有界恢复检查；不清理未知文件。
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self._verify_directory(directory)
            current = self._read_at(directory, target)
            self._check_baseline(current, base_hash)
            if base_hash is None:
                # 原子且不覆盖已有目标；留下两条链接的中断由持久意图恢复。
                try:
                    os.link(
                        temporary,
                        target,
                        src_dir_fd=directory,
                        dst_dir_fd=directory,
                        follow_symlinks=False,
                    )
                except FileExistsError:
                    raise FileIssue("external_note_changed", "文档文件已在应用外发生变化") from None
                os.unlink(temporary, dir_fd=directory)
            else:
                os.replace(temporary, target, src_dir_fd=directory, dst_dir_fd=directory)
            os.fsync(directory)

    @staticmethod
    def _check_baseline(current: bytes | None, base_hash: str | None) -> None:
        if base_hash is None:
            if current is not None:
                raise FileIssue("external_note_changed", "文档文件已在应用外发生变化")
        elif current is None:
            raise FileIssue("note_file_missing", "已登记的文档文件不存在")
        elif digest(current) != base_hash:
            raise FileIssue("external_note_changed", "文档文件已在应用外发生变化")
