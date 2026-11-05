from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_lab.config import AgentLabError, DeepSeekConfig, load_config
from agent_lab.llm import DeepSeekChat
from agent_lab.parsing import parse_json_object
from agent_lab.tools import Tool, ToolRegistry


class ConfigTests(unittest.TestCase):
    def test_key_can_remain_blank_in_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(
                json.dumps(
                    {
                        "api_key": "",
                        "base_url": "https://api.deepseek.com",
                        "model": "deepseek-chat",
                    }
                ),
                encoding="utf-8",
            )
            with patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}):
                config = load_config(path)
            self.assertEqual(config.api_key, "")
            with self.assertRaises(AgentLabError):
                config.require_api_key()
            with self.assertRaises(AgentLabError):
                DeepSeekChat(config)


class ParsingTests(unittest.TestCase):
    def test_fenced_json(self) -> None:
        self.assertEqual(
            parse_json_object('```json\n{"ok": true, "count": 2}\n```'),
            {"ok": True, "count": 2},
        )

    def test_json_with_short_prefix(self) -> None:
        self.assertEqual(
            parse_json_object('结果如下：{"answer": "完成"} 谢谢'),
            {"answer": "完成"},
        )


class DeepSeekClientTests(unittest.TestCase):
    @patch("agent_lab.llm.urllib.request.urlopen")
    def test_uses_deepseek_chat_completions_contract(self, urlopen) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return None

            def read(self) -> bytes:
                return json.dumps(
                    {"choices": [{"message": {"content": "测试完成"}}]},
                    ensure_ascii=False,
                ).encode("utf-8")

        urlopen.return_value = FakeResponse()
        client = DeepSeekChat(DeepSeekConfig(api_key="test-key"))
        output = client.complete(
            [{"role": "user", "content": "你好"}],
            json_mode=True,
        )

        self.assertEqual(output, "测试完成")
        request = urlopen.call_args.args[0]
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(request.full_url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-key")
        self.assertEqual(payload["model"], "deepseek-chat")
        self.assertEqual(payload["response_format"], {"type": "json_object"})


class ToolTests(unittest.TestCase):
    def test_tool_error_is_returned_as_observation(self) -> None:
        registry = ToolRegistry()

        def broken() -> None:
            raise RuntimeError("boom")

        registry.register(
            Tool(
                name="broken",
                description="test",
                parameters={"type": "object"},
                handler=broken,
            )
        )
        result = registry.execute("broken", {})
        self.assertFalse(result["ok"])
        self.assertIn("boom", result["error"])

    def test_unknown_tool_is_an_error(self) -> None:
        result = ToolRegistry().execute("missing", {})
        self.assertEqual(result["ok"], False)


if __name__ == "__main__":
    unittest.main()

