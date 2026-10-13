# Model configuration

[简体中文](../configuration.md) · English

MemoCosmos uses a cloud model for reasoning and keeps conversations, Markdown, indexes, and configuration on your computer. Choose a service that provides an OpenAI-compatible Chat Completions API. No local model download is required.

## Configure in the interface

1. Start MemoCosmos and open **Settings → Cloud assistant**
2. Enter your provider's **API URL**, **Model name**, and **API Key**
3. Select **Save model configuration**
4. Send a message in **Workspace** to verify the connection

The API URL is a base URL, normally including a version path such as `/v1`. The app calls `chat/completions` below it; do not include that endpoint twice. The base URL cannot contain credentials, query parameters, or a fragment. Use your provider's documented HTTPS address.

The model name must be the exact model ID available to your account. The model needs streaming and tool calls to retrieve personal memories. Provider-specific protocols and separate embedding configuration are not supported in 1.0.

Saving does not make a model request. A configured status means the local fields are complete; a message verifies networking, credentials, model access, and protocol compatibility. Chat and background organization use this same configuration. Your provider bills cloud calls.

## Change credentials

The saved key is not displayed. Leave the key field blank to keep it while editing other fields. When switching providers, also enter the new provider's key.

Keys live in a separate local configuration file, not browser storage or the memory database. macOS/Linux use owner-only file permissions; their configuration is not encrypted. Windows users running in WSL2 Ubuntu use Linux paths and permissions.

Memory exports exclude keys. On the same computer you can reuse configuration with a different vault. On a new computer, configure your model again.

## Data directories

| OS    | Default vault                                  | Private configuration directory             |
| ----- | ---------------------------------------------- | ------------------------------------------- |
| macOS | `~/Library/Application Support/Yihe/memory`    | `~/Library/Application Support/Yihe/config` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/yihe/memory` | `${XDG_CONFIG_HOME:-~/.config}/yihe/config` |

The earlier `Yihe` names and `YIHE_*` variables are retained for compatibility. The configuration file is `model.json`. The vault includes `.assistant/memory.sqlite` and Markdown bodies under `notes/topics/`. A full migration needs the database as well as Markdown, because conversations, indexes, and relations also live there.

Set `YIHE_MEMORY_DIR` and `YIHE_CONFIG_DIR` to separate absolute directories outside the application source. Neither may contain the other. The launcher's `--memory-dir` argument overrides `YIHE_MEMORY_DIR`.

## Environment variables

The settings page is recommended. Automated launches can use process environment variables:

| Variable              | Meaning                                                   |
| --------------------- | --------------------------------------------------------- |
| `CHAT_MODEL_BASE_URL` | Provider API base URL                                     |
| `CHAT_MODEL_NAME`     | Exact model ID                                            |
| `CHAT_MODEL_API_KEY`  | API Key                                                   |
| `CHAT_MODEL_PROVIDER` | `openai_compatible`; `openai` is also accepted            |
| `YIHE_MEMORY_DIR`     | Absolute vault path                                       |
| `YIHE_CONFIG_DIR`     | Absolute private configuration directory                  |
| `YIHE_TIMEZONE`       | Optional IANA timezone; otherwise the computer's timezone |
| `RUN_TIMEOUT_SECONDS` | Chat timeout, default 120; greater than 0 and at most 600 |
| `AGENT_MAX_STEPS`     | Maximum agent steps, default 12; accepted range 1–50      |

You can set these in PyCharm's run configuration. `.env.example` lists the supported variables; the backend does **not automatically load `.env` files**.

A saved configuration takes precedence over environment variables. Invalid files or permissions produce an unavailable state rather than silently falling back to environment credentials. New settings apply to the next chat; active requests keep their original configuration.
