"""stdio MCP tools backed by the existing authenticated local API."""

import argparse
import asyncio
from typing import Any
from uuid import UUID

from mcp.server import MCPServer
from mcp.types import ToolAnnotations

from app.integrations.client import BridgeError, LocalClient

INSTRUCTIONS = """MemoCosmos stores personal knowledge locally.
For questions about past knowledge or experiences, search_memory first. Search
and read_note automatically return direct relationships. Decide which neighbor
to read next; stop when evidence is sufficient. Reuse retrieval_id across all
reads for the same user question. Respect retrieval_control and do not evade a
budget by starting another session for the same question. Cite yihe://notes/ID.
Document links are retrieval routes, not proof of causation. Distinguish recorded
facts from model inference and report pending changes or incomplete evidence.
ingest_turn accepts a completed user/assistant exchange with stable source,
session and turn IDs. It queues background curation, not an immediate confirmed
memory. Do not submit hidden reasoning, system instructions, tool credentials,
or whole conversation histories. Codex hooks handle capture when installed;
do not submit the same turn again with a different identity.
"""


def create_server(client=None):
    bridge = client or LocalClient()
    server = MCPServer("MemoCosmos", instructions=INSTRUCTIONS)
    readonly = ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)

    async def call(path, payload=None):
        try:
            return await asyncio.to_thread(bridge.call, path, payload)
        except BridgeError as exc:
            return dict(error=exc.code, message=exc.message, retryable=exc.retryable)

    async def recall(name, arguments, retrieval_id=None):
        return await call(
            "/api/v1/integrations/recall",
            dict(tool=name, arguments=arguments, retrieval_id=retrieval_id),
        )

    @server.tool(annotations=readonly)
    async def search_memory(
        q: str,
        tag_ids: list[str] | None = None,
        limit: int = 8,
        token_budget: int = 2600,
        date_from: str | None = None,
        date_to: str | None = None,
    ) -> dict[str, Any]:
        """Locate notes and relations; reuse retrieval_id for the same question."""
        return await recall(
            "search_memory",
            dict(
                q=q,
                tag_ids=tag_ids or [],
                limit=limit,
                token_budget=token_budget,
                date_from=date_from,
                date_to=date_to,
            ),
        )

    @server.tool(annotations=readonly)
    async def read_note(
        note_id: str, retrieval_id: str, heading: str | None = None
    ) -> dict[str, Any]:
        """Read a selected note and its direct relationships, then decide whether to continue."""
        return await recall("read_note", dict(note_id=note_id, heading=heading), retrieval_id)

    @server.tool(annotations=readonly)
    async def explore_memory_graph(
        note_ids: list[str], retrieval_id: str, after: str | None = None, token_budget: int = 1600
    ) -> dict[str, Any]:
        """Get a page of direct relationships; follow continuations only when useful."""
        return await recall(
            "explore_memory_graph",
            dict(note_ids=note_ids, after=after, token_budget=token_budget),
            retrieval_id,
        )

    @server.tool(annotations=readonly)
    async def list_tags(query: str | None = None, limit: int = 10) -> dict[str, Any]:
        """Look up existing tags without creating or editing them."""
        return await recall("list_tags", dict(query=query, limit=limit))

    @server.tool(
        annotations=ToolAnnotations(
            read_only_hint=False,
            destructive_hint=False,
            idempotent_hint=True,
            open_world_hint=False,
        )
    )
    async def ingest_turn(
        source: str,
        session_id: str,
        turn_id: str,
        user: str,
        assistant: str,
        occurred_at: str | None = None,
    ) -> dict[str, Any]:
        """Queue a completed turn. Replays must preserve its identity and content."""
        return await call(
            "/api/v1/integrations/turns",
            dict(
                source=source,
                session_id=session_id,
                turn_id=turn_id,
                user=user,
                assistant=assistant,
                occurred_at=occurred_at,
            ),
        )

    @server.tool(annotations=readonly)
    async def get_memory_job(job_id: str) -> dict[str, Any]:
        """Check whether curation saved notes, skipped, failed, or needs confirmation."""
        identifier = str(UUID(job_id))
        return await call(f"/api/v1/integrations/jobs/{identifier}")

    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    create_server(LocalClient(args.url)).run(transport="stdio")


if __name__ == "__main__":
    main()
