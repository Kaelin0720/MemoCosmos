# MemoCosmos local service

For installation, API configuration, and daily use, start with the [English guide](../README.md) or [中文指南](../README.zh-CN.md).

Install from the project root with `uv sync --project backend --locked --no-dev --default-index https://pypi.org/simple`, then start both services with `uv run --project backend --no-sync python run.py`. Use one backend process per vault. Without a model, notes, tags, retrieval, and backups remain available; chat requires your cloud model configuration.
