# 模型配置

简体中文 · [English](en/configuration.md)

MemoCosmos使用云端模型推理，本机保存聊天、Markdown、索引与模型配置。你可以选择提供 OpenAI 兼容 Chat Completions 接口的服务，不需要在电脑上下载模型。

## 在页面上设置

1. 启动MemoCosmos，打开 **切换空间 → 设置 → 云端主智能体**
2. 填写服务提供的 **API URL**、**模型名称** 和 **API Key**
3. 点击 **保存模型配置**
4. 返回工作台发送消息，确认可以正常回答

API URL 是基址，通常包含版本路径。程序会在其后调用 `chat/completions`；不要重复填写这个请求路径。基址不能包含账号密码、查询参数或片段。云端服务推荐使用 HTTPS。

模型名称必须与服务开放给当前账号的模型 ID 一致。所选模型应支持流式输出和工具调用，仅支持普通文本回复的服务不能完成个人记忆检索。当前不支持供应商专用协议直接接入，也没有独立的 Embedding 配置。

保存本身不会发送模型请求。显示“配置已齐全”代表本机有完整配置，实际发消息才能验证网络、密钥、模型权限和协议兼容性。聊天与后台自动整理都使用这份配置，云端调用的费用由模型服务收取。

## 修改和更换密钥

已经保存密钥时，API Key 输入框保持空白，不会显示原值。修改 URL 或模型名称时，可以留空以保留密钥；更换服务时请同时填写该服务的新密钥。

密钥只保存在本机独立配置文件中，保存后清空表单，不保存在浏览器存储中。macOS/Linux 使用限制当前用户访问的文件权限，文件内容不是加密存储。Windows 用户在 WSL2 Ubuntu 内运行时使用 Linux 配置目录与权限机制。请不要分享配置文件、把密钥放进截图或提交到 GitHub。

记忆库导出不包含密钥。在同一台电脑切换记忆库可以继续使用当前配置；换到新电脑后，需要重新填写模型配置。

## 数据目录

| 系统  | 默认记忆库                                     | 默认私密配置目录                            |
| ----- | ---------------------------------------------- | ------------------------------------------- |
| macOS | `~/Library/Application Support/Yihe/memory`    | `~/Library/Application Support/Yihe/config` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/yihe/memory` | `${XDG_CONFIG_HOME:-~/.config}/yihe/config` |

为兼容之前的安装，1.0 保留 `Yihe` 目录与 `YIHE_*` 变量名称。模型配置文件名为 `model.json`。记忆库包含 `.assistant/memory.sqlite` 数据库与 `notes/topics/` 下的 Markdown 正文。不要只复制部分 Markdown 来替代完整迁移；索引、会话与关系还保存在数据库中。

可以在运行进程中设置 `YIHE_MEMORY_DIR`、`YIHE_CONFIG_DIR`，指定两份不同的绝对目录。目录必须在源码之外，不能互相包含，也不能把配置目录放入记忆库。统一启动器的 `--memory-dir` 参数会覆盖 `YIHE_MEMORY_DIR`。

## 使用环境变量

推荐使用页面设置。自动运行等场景也可以使用进程环境变量：

| 变量                  | 用途                                                  |
| --------------------- | ----------------------------------------------------- |
| `CHAT_MODEL_BASE_URL` | 模型服务的 API 基址                                   |
| `CHAT_MODEL_NAME`     | 模型 ID                                               |
| `CHAT_MODEL_API_KEY`  | API 密钥                                              |
| `CHAT_MODEL_PROVIDER` | `openai_compatible`，也接受 `openai`                  |
| `YIHE_MEMORY_DIR`     | 记忆库绝对路径                                        |
| `YIHE_CONFIG_DIR`     | 私密配置目录绝对路径                                  |
| `YIHE_TIMEZONE`       | 可选 IANA 时区，如 `Asia/Shanghai`；默认使用电脑时区  |
| `RUN_TIMEOUT_SECONDS` | 聊天超时时间，默认 120 秒，可设大于 0 且不超过 600 秒 |
| `AGENT_MAX_STEPS`     | 智能体步骤上限，默认 12，可设 1–50                    |

可以在 PyCharm 的运行配置中填写这些环境变量。根目录 `.env.example` 只说明支持的变量，后端**不会自动加载 `.env` 文件**。

页面保存的配置优先于环境变量。配置文件损坏或权限不合要求时，会显示配置不可用，不会自动回退到环境变量。模型配置修改后用于下一次聊天，正在执行的请求继续使用启动时的配置。
