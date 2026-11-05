# Changelog / 更新记录

## 1.0.1 — 2026-11-05

### 中文

- 新增三维知识宇宙，可逐级浏览宇宙、星系与知识星球，并保留二维力导向图谱
- 根据文档关联数量调整天体大小，已有知识正文的节点点亮，待记录的节点保持暗色
- 新增天体外观库与星环选项，支持中英文界面和移动端交互
- 修复外观缩略图首次渲染时可能缓存空白画面的问题，更新 Next.js 至 16.4.3 补丁版
- 检索先定位文档并返回直接关系，由模型按需继续阅读关联文档，加入证据预算与重复读取控制
- 新增本地 MCP 记忆工具和 Codex 对话采集插件，提供中英文安装指南
- 记忆包支持新增关系索引及外部对话来源记录，保留旧版本记忆包导入能力

升级时请先在设置中导出记忆包，停止旧程序，再解压新版到独立目录启动。原记忆库继续使用，无需复制到程序目录。后台自动整理仍需配置云端 API URL、API Key 和模型名称；插件不会自动使用 Codex 套餐额度。Codex 插件需要重新生成、安装并审阅钩子信任状态，详见 [插件指南](docs/plugins.md)。

### English

- Added a 3D knowledge universe with universe, galaxy and knowledge-world navigation, while retaining the 2D force graph
- Sized celestial bodies by document connectivity, lighting nodes with recorded knowledge and dimming empty notes
- Added a celestial appearance library and ring options, with English/Chinese UI and mobile interactions
- Fixed blank first-render appearance thumbnails and updated Next.js to the 16.4.3 patch release
- Changed recall to locate documents and expose direct relationships, letting the model read related notes as needed within shared evidence and duplicate-read limits
- Added local MCP memory tools and a Codex conversation-capture plugin, with bilingual setup guides
- Updated memory archives for relationship indexes and external conversation provenance while retaining older archive imports

Before upgrading, export a memory archive in Settings, stop the previous application, and extract this release into a separate folder. Continue using the existing vault outside the application directory. Background curation still requires a cloud API URL, API Key and model name; the plugin does not automatically use Codex subscription allowance. Regenerate and reinstall the Codex plugin, then review its hook trust state. See the [plugin guide](docs/en/plugins.md).

## 1.0.0 — 2026-10-13

Initial public release / 首个公开版本
