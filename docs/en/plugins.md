# Agent memory plugin

[简体中文](../plugins.md)

Agents supporting local stdio MCP can retrieve MemoCosmos memories. The Codex desktop adapter also captures new conversations and organizes them into Markdown notes and a knowledge graph. The vault stays on your computer.

## Prepare and generate

Start MemoCosmos using the [README](../../README.md), configure a cloud API URL, API Key and model name, and enable automatic memory. Background curation uses this configuration and is billed by its provider; it does not automatically use a Codex subscription. Keep the local service running at its default address, `http://127.0.0.1:8000`.

From the project root:

```bash
uv sync --project backend --locked
python3 plugin.py --output artifacts/memocosmos-plugin
```

Use `--url http://127.0.0.1:PORT` for a different API port, or `--capture-dir /absolute/path` for a custom queue location. Only explicit HTTP loopback addresses are accepted.

Generated plugin and MCP settings contain no API Key. Paths refer to this installation and Python runtime. Generate a new directory after moving the project or changing computers; existing output directories are never overwritten.

## Install in Codex

With Codex CLI installed, run from the project root:

```bash
codex plugin marketplace add "$PWD/artifacts/memocosmos-plugin"
codex plugin add memocosmos@memocosmos-local
```

Restart the desktop app, find MemoCosmos in the plugin list, review and trust its hook definitions, and start a new chat. Installation does not automatically trust hooks. MCP tools can work without hook trust, but automatic capture cannot.

This is a manually installed local plugin. Plugins containing lifecycle hooks are currently ineligible for public directory submission; see the [official packaging guide](https://developers.openai.com/plugins/build/plugins) and [plugin commands](https://learn.chatgpt.com/docs/developer-commands).

### Installed but unavailable

Ensure MemoCosmos is still running. Restarting Codex does not start MemoCosmos. Run `python3 run.py` from the project root and configure the model in Settings. Existing memories remain searchable without a model; background curation waits for configuration.

Early generated 0.1.0 or 0.1.1 plugins may have rejected startup paths or missing hooks despite working tools. Generate a new directory with the current generator, register that directory as the local marketplace, and reinstall. Version 0.1.2 uses Codex's supported `.codex-plugin/plugin.json` and `.mcp.json` compatibility layout. Other agent clients continue to use `mcp-client.json`.

If tools connect but capture never starts, check hook trust. In Codex CLI, use `/hooks` to inspect, review and trust the MemoCosmos hooks. Do not bypass hook trust checks.

## Use and check results

Chat normally in Codex sessions with the hooks enabled. The adapter pairs the user text from `UserPromptSubmit` with the final reply from `Stop`. It does not scan old transcripts, system instructions, tool outputs or hidden reasoning. Interrupted, unfinished turns are not submitted. Replayed completions are deduplicated; revised replies become new revision inputs.

Check **Knowledge → Memory inbox** in MemoCosmos. Content with no new value is skipped; ambiguous corrections wait for confirmation. Saved notes and relationships appear in the star map. You can edit notes, tags and folders.

For prior knowledge, the agent locates documents and direct relationships, decides which related documents to read, and stops when it has enough evidence. Reuse one `retrieval_id` per question. Each session shares up to twelve memory reads and approximately 12,000 serialized evidence characters, and expires after fifteen minutes.

Disable plugin hooks to pause capture. Disabling automatic memory prevents ordinary turns from being accepted for new curation; explicit requests to remember something can still be queued.

## Offline delivery

If the service is unavailable, content remains in a local queue. Session starts and subsequent events attempt delivery. You can also run:

```bash
backend/.venv/bin/python artifacts/memocosmos-plugin/capture.py status
backend/.venv/bin/python artifacts/memocosmos-plugin/capture.py flush
```

`pending` means waiting, `delivered` means accepted or ignored according to local settings, and `blocked` means rejected input. An acknowledgement is not a saved note: check the inbox or `get_memory_job` for actual results.

Generated `local-setup.json` records the queue location; the default is `integrations/codex-capture` under the MemoCosmos configuration directory. Delivered payload text is cleared. Prompt buffers for matching revised replies are kept for up to seven days and cleaned on the next queue operation. The queue is excluded from vault exports. Flush before exporting memories to another computer.

## Other agents

Add the `memocosmos` entry from generated `mcp-client.json` to your host's MCP settings. The host must launch commands on this computer. A cloud-only web client cannot directly run this stdio configuration.

| Tool                   | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `search_memory`        | Locate notes, excerpts and relationships; start a `retrieval_id` |
| `read_note`            | Read a selected note or heading and its direct relationships     |
| `explore_memory_graph` | Page through direct relationships as needed                      |
| `list_tags`            | Query existing tags                                              |
| `ingest_turn`          | Submit one completed turn for background curation                |
| `get_memory_job`       | Check results and confirmation questions                         |

Hosts with completion callbacks can call `ingest_turn`. Supply stable `source`, `session_id` and `turn_id` values, original user text, the final reply and an optional timezone-aware timestamp. Replays must preserve identity and content; edited content needs a new turn or revision identifier. Adding MCP tools alone does not grant access to the entire chat history.
