# 智能体记忆插件

[English](en/plugins.md)

支持本地 stdio MCP 的智能体可以检索 MemoCosmos 记忆。Codex 桌面适配器还可以自动采集新增对话，整理成 Markdown 文档和知识图谱。记忆库保存在本机。

## 准备与生成

按 [README](../README.zh-CN.md) 启动 MemoCosmos，在设置中填写云端 API URL、API Key 和模型名称，并开启自动记忆。后台整理使用这份配置，费用由对应供应商计算，不自动借用 Codex 订阅额度。保持本地服务运行，默认地址为 `http://127.0.0.1:8000`。

在项目根目录运行：

```bash
uv sync --project backend --locked
python3 plugin.py --output artifacts/memocosmos-plugin
```

自定义端口时附加 `--url http://127.0.0.1:端口`；自定义采集队列位置用 `--capture-dir /绝对路径`。仅支持明确的本机 HTTP 回环地址。

生成的插件和 MCP 配置不含 API Key，使用当前安装与 Python 的绝对路径。移动项目或换电脑后应重新生成到新目录；生成器不会覆盖已有目录。

## 安装到 Codex

安装了 Codex CLI 后，在项目根目录执行：

```bash
codex plugin marketplace add "$PWD/artifacts/memocosmos-plugin"
codex plugin add memocosmos@memocosmos-local
```

重启桌面应用，在插件列表找到 MemoCosmos，查看并信任其钩子定义，然后开始新对话。安装不会自动信任钩子；未信任时可使用 MCP 工具，但不会自动采集。

这是手动安装的本地插件。带生命周期钩子的插件目前不适用于公共插件目录提交，见 [官方插件说明](https://developers.openai.com/plugins/build/plugins) 与 [插件命令](https://learn.chatgpt.com/docs/developer-commands)。

### 安装后无法使用

先确认 MemoCosmos 仍在运行：重启 Codex 不会自动启动 MemoCosmos。在项目根目录运行 `python3 run.py`，打开设置页完成模型配置；未配置时可以检索已有记忆，但后台整理会等待配置。

如果安装的是早期生成的 0.1.0 或 0.1.1 插件，可能遇到启动路径被拒绝，或工具可用但找不到钩子。使用当前生成器输出到一个新目录，用该目录重新注册本地市场并安装插件。0.1.2 起使用 Codex 支持的 `.codex-plugin/plugin.json` 与 `.mcp.json` 兼容布局，其他智能体继续使用 `mcp-client.json`。

如果工具能连接但未自动采集，请检查钩子信任状态。Codex CLI 可通过 `/hooks` 查看、审阅并信任 MemoCosmos 钩子。不要跳过钩子信任检查。

## 使用与结果

在启用钩子的 Codex 会话里正常聊天。适配器将 `UserPromptSubmit` 的用户输入与 `Stop` 的最终回复配对，不扫描旧聊天、系统指令、工具输出或隐藏思考过程。被中断且未完成的轮次不提交。同一输出重发会去重，修订回复作为新的修订输入。

到 MemoCosmos 的 **知识 → 记忆收件箱** 查看结果。无新增价值的内容会跳过，歧义更正等待确认。保存后的文档与关系出现在星图中，可自行修改正文、标签和目录。

查询旧知识时，智能体先定位文档与直接关系，再判断是否继续读取关联文档，证据足够就停止。每个问题需复用同一个 `retrieval_id`，共享最多十二次记忆读取、约一万二千序列化字符的证据预算。检索会话十五分钟后过期。

禁用插件钩子可暂停采集。关闭 MemoCosmos 自动记忆后，普通对话不会被接收为新整理任务；明确要求“记住”的内容仍可排队。

## 离线与补交

服务关闭时，内容暂存在本机队列。下次会话启动或新事件到达时尝试补交，也可以手动运行：

```bash
backend/.venv/bin/python artifacts/memocosmos-plugin/capture.py status
backend/.venv/bin/python artifacts/memocosmos-plugin/capture.py flush
```

`pending` 是待发送，`delivered` 是服务已接收或按设置忽略，`blocked` 是输入被拒绝。接收成功不等于已生成文档，应继续查看收件箱或 `get_memory_job`。

队列位置见生成的 `local-setup.json`，默认为 MemoCosmos 配置目录下的 `integrations/codex-capture`。已送达的待发送正文会清除；用于关联修订回复的用户输入缓冲最多保留七天，下次队列操作时清理。队列不随记忆包导出，换电脑前请先补交，再导出记忆。

## 其他智能体

将生成的 `mcp-client.json` 中的 `memocosmos` 服务加入宿主的 MCP 配置。宿主必须能在本机启动命令，纯云端网页不能直接运行这份 stdio 配置。

| 工具                   | 用途                                          |
| ---------------------- | --------------------------------------------- |
| `search_memory`        | 定位文档，返回摘录、直接关系和 `retrieval_id` |
| `read_note`            | 读取所选文档或章节及其直接关系                |
| `explore_memory_graph` | 按需分页查看直接关系                          |
| `list_tags`            | 查询已有标签                                  |
| `ingest_turn`          | 提交一轮已完成对话，异步整理                  |
| `get_memory_job`       | 查询整理结果与待确认问题                      |

支持对话完成回调的宿主可在回调中调用 `ingest_turn`，传入稳定的 `source`、`session_id`、`turn_id`、用户原文、最终回复，以及可选的带时区时间。同一身份只接受相同内容；编辑内容需使用新的轮次或修订标识。只添加 MCP 工具不会自动获得全部聊天记录。
