# Troubleshooting

[简体中文](../troubleshooting.md) · English

## Startup

**Backend is not installed:** run `uv sync --project backend --locked --no-dev --default-index https://pypi.org/simple` from the application directory. The project needs its own environment, not an unrelated system Python.

**Frontend is not built or sources are newer:** run `pnpm build` in `frontend` when building from source. The named release ZIP already includes the interface. GitHub's automatic source archives do not.

**Port is occupied:** MemoCosmos uses local ports `3000` and `8000`. Stop an earlier instance or the occupying service, then retry. The launcher does not stop unrelated applications.

**pnpm is missing:** source builds need Node.js 22.13 or newer and `npm install -g pnpm@11.19.0`. The release package only needs [uv](https://docs.astral.sh/uv/getting-started/installation/).

**Dependencies fail to download:** check your connection, proxy, and certificate settings. Python dependencies use official PyPI. Retain the lockfiles rather than deleting them or upgrading dependencies to work around a download failure.

## The local service is unavailable

Run `run.py` through the documented uv command and leave its terminal or PyCharm window open. Open the [health endpoint](http://127.0.0.1:8000/health) to check the backend, then recheck the connection in Settings.

The launcher serves the built interface and proxies its API on the same origin. An ordinary static file server for `frontend/out` does not provide that API proxy.

## Chat fails after saving configuration

A successful save means the local configuration exists; it does not verify the provider. Check the base URL, exact model ID, key validity, billing status, and model access. The model must support streaming and tool calls.

For a 404 error, check whether you included the full `chat/completions` path twice or omitted a required version path. Follow your provider's documentation.

If configuration cannot be saved, check write permissions and make sure its directory is separate from the source and vault. On Windows use WSL2 Ubuntu and keep the application and vault inside the Linux home directory. Native Windows does not provide the complete vault workflow in 1.0.

When reporting a problem, include the error type, reproduction steps, operating system, and version. Remove keys and personal content from the report.

## No note appears after a chat

Open **Knowledge → Memory inbox**. Messages with no new durable information are skipped; ambiguity waits for confirmation; configuration or network failures show their status. Organization runs in the background, not once per incoming message.

Check the automatic-organization switch in Settings. You can explicitly tell the assistant what you want it to remember.

## Incomplete retrieval

Try more specific topic words or tags and inspect coverage indicators. Version 1.0 uses tags, keywords, and sections; it does not provide vector retrieval or automatic complete-year summaries.

After editing Markdown outside the app, review and import those changes before retrieving it.

## Restore still shows the old vault

Restore creates another vault and does not replace the current running one. Copy the returned path, stop the app, and restart with `--memory-dir`. See [usage and migration](usage.md).

If import fails, check that the ZIP is a complete MemoCosmos memory export and is not damaged, manually modified, or over the size limit. Do not unzip it over a running vault.

## Persistence

Confirmed notes, conversations, and tags are stored on disk and survive a restart. Unsaved drafts stay only in the page session; save them before closing. If a service stops during generation, received text is retained and unfinished work is marked interrupted.
