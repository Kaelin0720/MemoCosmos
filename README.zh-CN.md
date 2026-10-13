# MemoCosmos

简体中文 · [English](README.md)

**欢迎建造你的记忆宇宙**

MemoCosmos 是运行在自己电脑上的第二大脑。你通过日常对话告诉助手学到的知识、完成的工作与希望保留的想法，它会整理成可编辑的 Markdown 文档、标签和关联。记忆库保存在本机，可以打包带到另一台电脑。

模型使用你自己配置的云端 API，不需要安装本地模型。聊天消息和检索到的相关内容会发送给所选模型服务，记忆库保存在本机，调用费用由模型供应商收取。

## 功能

- 流式聊天、会话历史、检索个人笔记与点击引用回到原文
- 自动构建知识文档、补充同主题内容，有歧义的更正先等待确认
- Obsidian 风格的目录树、Markdown 阅读编辑、标签池和历史版本
- 核对外部编辑器修改，再确认导入并更新索引
- 动态关系星图：蓝白星光、力导向布局、悬浮高亮、拖拽缩放和关系证据
- 导出与恢复聊天、文档、标签、历史和关系，API Key 不随记忆包导出
- 首次欢迎页与菜单中的简体中文、English 切换

## 部署到自己的电脑

MemoCosmos 原生支持 macOS/Linux，Windows 通过 WSL2 Ubuntu 运行。1.0 尚不支持原生 Windows 文档存储。它是本机浏览器应用，访问地址为 `127.0.0.1`。使用期间保持终端打开。每份记忆库只运行一个后端进程，适合个人使用。

### 使用发布包

1. 安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)
2. 在 [v1.0.0 发布页](https://github.com/Kaelin0720/MemoCosmos/releases/tag/v1.0.0) 下载 **MemoCosmos-1.0.0.zip**，然后解压。选择这个带已构建界面的发布包；GitHub 自动提供的 **Source code** 压缩包需要按下方源码步骤构建
3. 在解压后的 `MemoCosmos-1.0.0` 目录打开终端，执行：

```sh
uv sync --project backend --locked --no-dev --default-index https://pypi.org/simple
uv run --project backend --no-sync python run.py
```

在 macOS/Linux 终端执行这些命令；Windows 用户在 WSL2 的 Ubuntu 终端中执行。需要时 uv 会获取项目固定的 Python 3.13。发布包不需要 Node.js 或 pnpm。

浏览器会打开 [MemoCosmos](http://127.0.0.1:3000/)。首次进入先选择语言，然后配置云端模型开始聊天；也可以先进入工作区管理笔记。终端按 `Ctrl+C` 停止前后端。下次只需执行第二条命令。

### 从源码安装

准备 [Git](https://git-scm.com/downloads)、[Node.js](https://nodejs.org/en/download) 22.13 或以上和 uv，然后安装指定 pnpm：

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

使用 PyCharm：打开项目根目录，选择 `backend/.venv/bin/python` 为解释器，运行根目录的 `run.py`。

### Windows 使用 WSL2

先安装 [WSL2 Ubuntu](https://learn.microsoft.com/en-us/windows/wsl/install)，再在 Ubuntu 终端中按照上面的 macOS/Linux 步骤操作。应用和记忆库放在 Linux 用户目录，例如 `~/MemoCosmos-1.0.0`，不要放在 `/mnt/c` 下的 Windows 挂载目录中。在 Ubuntu 内安装 Linux 版 uv。浏览器未自动打开时，把终端显示的 `http://127.0.0.1:3000/` 地址复制到 Windows 浏览器。

## 配置 API Key

打开 **设置 → 云端主智能体**，填写：

| 字段     | 内容                                                                        |
| -------- | --------------------------------------------------------------------------- |
| API URL  | 模型服务的 OpenAI 兼容 API 基址，通常含 `/v1`，不要追加 `/chat/completions` |
| 模型名称 | 服务提供的准确模型 ID                                                       |
| API Key  | 从该服务控制台申请的有效密钥                                                |

点击 **保存模型配置**，再到 **工作台** 发送消息。模型必须支持 Chat Completions、流式输出和工具调用。保存只检查并写入本机配置，发送消息时才验证供应商是否可用。

已经保存密钥后，留空可以沿用原密钥。界面不会回显密钥，也不会将它存进浏览器本地存储。详见 [模型配置](docs/configuration.md)。

## 开始使用

在工作台聊聊今天学到的知识、做过的事情，或明确告诉助手希望记住什么。聊天完成后，后台整理有保存价值的内容；在会话中或 **知识宇宙 → 整理与确认** 查看结果。有歧义的变更等待你确认。

打开生成的文档，可以自己修改正文、目录与标签，点击高亮文档标题跳转。以后提问时，助手按相关标签和章节检索，只发送必要的上下文。

[使用与迁移指南](docs/usage.md)介绍编辑、更正确认、星图、备份与换机器的方法。[常见问题](docs/troubleshooting.md)介绍启动、配置和恢复问题。

## 本地数据与升级

为兼容已有安装，1.0 保留原存储目录：

| 系统  | 记忆库                                         | 模型配置                                               |
| ----- | ---------------------------------------------- | ------------------------------------------------------ |
| macOS | `~/Library/Application Support/Yihe/memory`    | `~/Library/Application Support/Yihe/config/model.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/yihe/memory` | `${XDG_CONFIG_HOME:-~/.config}/yihe/config/model.json` |

记忆库包含 Markdown 与 SQLite 数据库，模型配置独立保存。导出包不包含 API Key 和模型配置，记忆包本身没有加密，应自行妥善保管。

升级前导出备份，关闭当前应用，将新版本安装到新目录后启动。默认记忆库位置保持不变；自定义记忆库用 `--memory-dir` 传入绝对路径。不要用应用目录覆盖记忆库。

## 1.0 的范围

技术栈为 Next.js、React、Motion、D3.js、FastAPI、Deep Agents、Markdown 和 SQLite。1.0 提供聊天、知识整理、检索回忆与本地记忆迁移的主要闭环。检索使用标签、关键词与章节，星图以文档为节点。向量检索、任意实体图谱、多设备同步和原生桌面安装器不在本次版本中。

## 许可证

[MIT](LICENSE) · Copyright 2026 Kaelin0720

[Third-party notices](THIRD_PARTY_NOTICES.md)
