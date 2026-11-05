# MemoCosmos

[简体中文](README.zh-CN.md) · English

**Welcome to your memory universe**

MemoCosmos is a personal second brain that runs on your computer. Talk about what you learn and do; your assistant turns useful information into editable Markdown notes, tags, and connections. Your memory stays on your device and can travel with you in a ZIP archive.

Bring your own cloud model through an OpenAI-compatible API URL, model name, and API Key. No local model is required. Messages and retrieved context are sent to your chosen provider; the memory vault stays local.

## What you can do

- Chat with streaming replies, revisit conversations, and retrieve notes with clickable citations
- Organize knowledge automatically, supplement existing topics, and confirm ambiguous corrections
- Browse an Obsidian-style document tree, edit Markdown, manage tags, and review versions
- Confirm changes made in an external editor before updating the local index
- Explore a 3D memory universe or an ordinary 2D force graph, and open each body's note and relationship evidence
- Choose from 52 stars, planets and moons with independent ring options
- Export and restore conversations, notes, tags, history, and relationships without exporting API Keys
- Choose English or Simplified Chinese in the welcome screen or language menu

## Install on your computer

MemoCosmos runs natively on macOS/Linux, and on Windows through WSL2 Ubuntu. Native Windows vault storage is not supported in 1.0. It is a local browser application on `127.0.0.1`. Keep its terminal open while using it. It is a single-user application; use one backend process per memory vault.

### Release package

1. Install [uv](https://docs.astral.sh/uv/getting-started/installation/).
2. Download **MemoCosmos-1.0.1.zip** from [Releases](https://github.com/Kaelin0720/MemoCosmos/releases/tag/v1.0.1) and extract it. Choose the named release package, which includes the built interface; GitHub's automatic **Source code** archives require the source-build steps below.
3. Open a terminal in the extracted `MemoCosmos-1.0.1` folder and run:

```sh
uv sync --project backend --locked --no-dev --default-index https://pypi.org/simple
uv run --project backend --no-sync python run.py
```

Run these commands in a macOS/Linux terminal, or in Ubuntu under WSL2 on Windows. uv obtains the pinned Python 3.13 interpreter if needed. The release package does not need Node.js or pnpm.

Your browser opens [MemoCosmos](http://127.0.0.1:3000/). Select your language on first launch. Configure your model to start chatting, or enter the workspace to manage notes first. Press `Ctrl+C` in the terminal to stop both services. Use the second command for subsequent launches.

### Build from source

Install [Git](https://git-scm.com/downloads), [Node.js](https://nodejs.org/en/download) 22.13 or newer, and uv. Install the pinned pnpm version:

```sh
npm install -g pnpm@11.19.0
```

```sh
git clone https://github.com/Kaelin0720/MemoCosmos.git
cd MemoCosmos
uv sync --project backend --locked --no-dev --default-index https://pypi.org/simple
cd frontend
pnpm install --frozen-lockfile
pnpm build
cd ..
uv run --project backend --no-sync python run.py
```

In PyCharm, open the project root, select `backend/.venv/bin/python` on macOS/Linux as the interpreter, and run `run.py`.

### Windows with WSL2

Install [WSL2 Ubuntu](https://learn.microsoft.com/en-us/windows/wsl/install), then follow the macOS/Linux steps **inside the Ubuntu terminal**. Keep the application and vault inside the Linux home directory, such as `~/MemoCosmos-1.0.1`, rather than a mounted Windows directory under `/mnt/c`. Install the Linux version of uv in Ubuntu. Open the printed `http://127.0.0.1:3000/` address in your Windows browser if it does not open automatically.

## Connect your model

Open **Settings → Cloud assistant** and fill in:

| Field      | What to enter                                                                            |
| ---------- | ---------------------------------------------------------------------------------------- |
| API URL    | Your provider's API base URL, usually ending in `/v1`; do not append `/chat/completions` |
| Model name | The exact model ID provided by your service                                              |
| API Key    | A valid key from that service                                                            |

Select **Save model configuration**, then send a message in **Workspace**. Your model must support Chat Completions, streaming, and tool calls. Saving checks and stores the configuration locally; sending a message verifies the provider connection. Cloud usage is billed by your provider.

After saving a key, leave the field blank to keep it when changing other settings. The saved key is never displayed or stored in browser local storage. See the [configuration guide](docs/en/configuration.md).

## Use your second brain

Tell the assistant what you learned, worked on, or want to remember. After a successful reply, it organizes useful information in the background. See results in the conversation or **Knowledge → Memory inbox**. Ambiguous changes wait for your confirmation.

Read and edit the resulting notes, adjust folders and tags, and follow highlighted document links. Later questions retrieve relevant tags and sections rather than sending the whole vault to the model.

The [usage and migration guide](docs/en/usage.md) covers edits, corrections, the star map, backups, and moving to another computer. [Troubleshooting](docs/en/troubleshooting.md) covers startup, model configuration, and recovery.

## Your local data

The existing storage names are retained for compatibility with earlier installations:

| OS    | Memory vault                                   | Private model configuration                            |
| ----- | ---------------------------------------------- | ------------------------------------------------------ |
| macOS | `~/Library/Application Support/Yihe/memory`    | `~/Library/Application Support/Yihe/config/model.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/yihe/memory` | `${XDG_CONFIG_HOME:-~/.config}/yihe/config/model.json` |

The vault contains Markdown files and a SQLite database. API configuration is stored separately. Exported memory packages exclude the API Key and model configuration; the packages themselves are not encrypted.

To upgrade, export a backup, stop the current app, install the new release in a new folder, and start it. Default vault paths remain the same. If you use a custom vault, pass its absolute path with `--memory-dir`. Never overwrite your vault with the application folder.

## Version 1.0.1

MemoCosmos uses Next.js, React, Motion, D3.js, Three.js, FastAPI, Deep Agents, Markdown, and SQLite. It provides the chat-to-notes-to-retrieval workflow and local memory migration. Retrieval uses tag routing, keywords, sections and model-directed exploration of confirmed relationships; graph nodes represent real documents. Vector retrieval, arbitrary entity graphs, multi-device sync, and native desktop installers are not included.

## Knowledge universe and recall

Switch between the 3D universe and the ordinary 2D force graph in the knowledge workspace. Each body represents a real note. Tags group notes into regions; confirmed relationships determine connections and relative weight. Open the appearance library to choose from 36 planets, 8 stars and 8 moons, with independent ring options. Appearance preferences stay in the current browser and do not change note content or create factual relationships.

Recall first locates documents using local tags and section keywords, then automatically includes their direct relationships without loading neighboring documents. The model decides which related document, if any, to read next. Each document read includes its own direct relationships; the model repeats this process only while it needs more evidence and stops when it can answer. Initial excerpts have a default budget of approximately 2,600 locally estimated tokens; provider billing may differ. Explicit tag filters remain strict. The graph's Recall field finds direct matches locally; model-directed exploration happens in chat and uses your configured cloud model.

The assistant also receives a small relationship neighborhood with edge direction, relationship type, supporting evidence, document versions and source links. It can choose a related document or another relationship page when needed. There is no fixed total hop count; per-turn budgets and duplicate-read checks bound the process. If a budget is reached, the assistant should identify what remains unverified. A document link is a retrieval route, not proof of causation; inferred conclusions should be identified as inferences and supported by the underlying notes. Only selected context is sent to your configured cloud provider.

In the 3D view, enter a galaxy to explore a network of knowledge stars, then select a star to approach its world. Document content lights a star; headings or source dates alone leave a dim blue marker. Size follows connection count. The 2D view retains its force-directed layout.

## Agent memory plugin

Use the local MCP memory service and the incremental Codex desktop capture adapter. See the [plugin setup and usage guide](docs/en/plugins.md).

## License

[MIT](LICENSE) · Copyright 2026 Kaelin0720

[Third-party notices](THIRD_PARTY_NOTICES.md)
