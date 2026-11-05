"""Generate a local Codex plugin and a standard stdio MCP configuration."""

import argparse
import json
import os
import shlex
import sys
from pathlib import Path

from app.core.settings import default_config_dir
from app.integrations.client import local_url


def generate(destination, base_url="http://127.0.0.1:8000", data_dir=None):
    destination = Path(destination).absolute()
    url = local_url(base_url)
    if destination.exists():
        raise ValueError("Choose a new output directory; existing plugins are not overwritten")
    backend = Path(__file__).resolve().parents[2]
    destination.mkdir(parents=True)
    launcher = destination / "bridge.py"
    launcher.write_text(
        "import os, sys\n"
        + f"sys.path.insert(0, {str(backend)!r})\n"
        + f"os.environ['PYTHONPATH'] = {str(backend)!r}\n"
        + "mode = sys.argv.pop(1)\n"
        + "if mode == 'mcp':\n"
        + "    from app.integrations.mcp_server import main\n"
        + "else:\n"
        + "    from app.integrations.codex_hook import main\n"
        + "main()\n",
        encoding="utf-8",
    )
    config_dir = Path(os.environ.get("YIHE_CONFIG_DIR", default_config_dir())).expanduser()
    data = Path(data_dir) if data_dir else config_dir / "integrations/codex-capture"
    data = data.absolute()
    hooks = {}
    for event in ("SessionStart", "UserPromptSubmit", "Stop", "Interrupt"):
        command = (
            shlex.quote(sys.executable)
            + ' "${PLUGIN_ROOT}/bridge.py" capture hook '
            + shlex.join(["--data-dir", str(data), "--url", url])
        )
        hooks[event] = [
            dict(
                hooks=[
                    dict(
                        type="command",
                        command=command,
                        timeout=3 if event == "Interrupt" else 10,
                    )
                ]
            )
        ]
    (destination / "hooks").mkdir()
    (destination / "hooks/hooks.json").write_text(
        json.dumps(dict(hooks=hooks), indent=2), encoding="utf-8"
    )
    # Current desktop runtimes discover lifecycle hooks reliably through the
    # documented Codex compatibility layout. A portable root manifest can load
    # MCP tools while silently omitting its hooks on those versions.
    manifest = {
        "name": "memocosmos",
        "version": "0.1.2",
        "description": "A local second brain with conversation capture and traceable knowledge",
        "hooks": "./hooks/hooks.json",
        "mcpServers": "./.mcp.json",
        "interface": {
            "displayName": "MemoCosmos",
            "shortDescription": "Your local memory universe",
            "category": "Productivity",
        },
    }
    server = dict(
        command=sys.executable,
        args=[str(backend / "app/integrations/stdio_entry.py"), "--url", url],
    )
    mcp = {"mcpServers": {"memocosmos": server}}
    (destination / ".codex-plugin").mkdir()
    for name, value in (
        (".codex-plugin/plugin.json", manifest),
        (".mcp.json", mcp),
        ("mcp-client.json", mcp),
    ):
        (destination / name).write_text(
            json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    catalog = destination / ".agents/plugins/marketplace.json"
    catalog.parent.mkdir(parents=True)
    catalog.write_text(
        json.dumps(
            dict(
                name="memocosmos-local",
                plugins=[
                    dict(
                        name="memocosmos",
                        source=dict(source="local", path="./"),
                        policy=dict(installation="AVAILABLE", authentication="ON_INSTALL"),
                        category="Productivity",
                    )
                ],
            ),
            indent=2,
        ),
        encoding="utf-8",
    )
    (destination / "capture.py").write_text(
        f"import sys\nsys.path.insert(0, {str(backend)!r})\n"
        + "from app.integrations.codex_hook import main\n"
        + f"sys.argv.extend(['--data-dir', {str(data)!r}, '--url', {url!r}])\nmain()\n",
        encoding="utf-8",
    )
    (destination / "local-setup.json").write_text(
        json.dumps(
            dict(
                backend_url=url,
                capture_directory=str(data),
            ),
            indent=2,
        ),
        encoding="utf-8",
    )
    license_path = backend.parent / "LICENSE"
    if license_path.is_file():
        (destination / "LICENSE").write_bytes(license_path.read_bytes())
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--capture-dir", type=Path)
    args = parser.parse_args()
    try:
        print(generate(args.output, args.url, args.capture_dir))
    except ValueError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
