import type { Locale } from "./i18n";
import type { MemoryGraph } from "./memory-types";

// This curated map is UI-only. It never enters the note store or the memory API.
const topics = [
  [
    "第二大脑",
    "Second brain",
    "让对话、文档和关联共同构成可以回顾的个人知识空间",
    "A personal knowledge space that connects conversations, notes and ideas",
  ],
  [
    "日常对话",
    "Conversations",
    "从学习、工作和生活中的对话发现值得保留的主题",
    "Find ideas worth keeping in conversations about learning, work and life",
  ],
  [
    "主题文档",
    "Topic notes",
    "每个主题保存在 Markdown 文档中，可以阅读和自行修改",
    "Each topic lives in a Markdown note you can read and edit",
  ],
  [
    "标签池",
    "Tags",
    "用可编辑的标签组织主题，并缩小检索的范围",
    "Organize topics with editable tags and narrow the search scope",
  ],
  [
    "知识图谱",
    "Knowledge graph",
    "通过有依据的关联连接文档，让知识可以沿着联系被发现",
    "Connect notes with supported relationships so ideas can be discovered through their connections",
  ],
  [
    "RAG 检索",
    "RAG retrieval",
    "先找到相关领域，再读取必要的知识片段作为回答上下文",
    "Find the relevant domain, then retrieve the passages needed for an answer",
  ],
  [
    "切片策略",
    "Chunking",
    "按标题和语义拆分长文档，让检索片段保留足够的上下文",
    "Split long notes by headings and meaning while retaining useful context",
  ],
  [
    "关键词检索",
    "Keyword search",
    "用标题、标签和正文中的关键词寻找相关内容",
    "Find relevant content using keywords in titles, tags and note bodies",
  ],
  [
    "版本记录",
    "Version history",
    "保留文档的修改轨迹，方便对照不同时间的知识变化",
    "Keep the history of edits so knowledge can be compared over time",
  ],
  [
    "本地记忆",
    "Local memory",
    "Markdown 与数据库保存在自己的电脑，知识可以直接查看",
    "Markdown files and the database stay on your own computer",
  ],
  [
    "记忆迁移",
    "Memory transfer",
    "将记忆库打包导出，在另一台电脑上恢复继续使用",
    "Export your library and restore it on another computer",
  ],
  [
    "学习复盘",
    "Learning reviews",
    "回顾学过的主题，沿着关联发现尚未理解的知识点",
    "Revisit what you learned and follow connections to find gaps in understanding",
  ],
  [
    "项目经验",
    "Project insights",
    "将做过的工作与相关知识联系起来，留下可复用的经验",
    "Connect work with relevant knowledge and keep reusable insights",
  ],
  [
    "云端模型",
    "Cloud model",
    "配置 API 地址、密钥和模型名称，由云端模型提供智能能力",
    "Configure an API URL, key and model name to use a cloud assistant",
  ],
] as const;
const connections = [
  [0, 1, "积累自", "Grows from"],
  [0, 2, "记录为", "Recorded in"],
  [0, 4, "连接为", "Connected by"],
  [0, 9, "保存于", "Stored in"],
  [0, 13, "由其辅助", "Assisted by"],
  [1, 2, "整理为", "Organized into"],
  [2, 3, "分类于", "Organized by"],
  [2, 8, "保留修改", "Tracks changes in"],
  [3, 5, "缩小范围", "Narrows the scope of"],
  [4, 2, "连接主题", "Connects"],
  [5, 6, "读取片段", "Retrieves passages from"],
  [5, 7, "使用检索", "Uses"],
  [9, 10, "可迁移", "Moves through"],
  [11, 2, "回顾", "Revisits"],
  [11, 4, "发现联系", "Finds connections through"],
  [12, 11, "促进复盘", "Supports"],
  [12, 2, "沉淀为", "Documented in"],
  [13, 1, "支持", "Supports"],
] as const;
export function constellationPreview(locale: Locale) {
  const en = locale === "en";
  const nodes = topics.map((topic, index) => ({
    id: `explore-${index}`,
    title: topic[en ? 1 : 0],
    folder: en ? "Knowledge connections" : "知识连接",
    tags: [{ id: "explore-topic", name: en ? "Exploration" : "探索" }],
  }));
  const graph: MemoryGraph = {
    nodes,
    edges: connections.map(([from, to, zh, english], index) => ({
      id: `explore-edge-${index}`,
      source: nodes[from].id,
      target: nodes[to].id,
      relation: en ? english : zh,
      evidence: en
        ? `${nodes[from].title} → ${nodes[to].title}. ${topics[to][3]}.`
        : `${nodes[from].title} → ${nodes[to].title}：${topics[to][2]}`,
      source_message_id: null,
      created_at: "2026-01-01T00:00:00Z",
    })),
  };
  return {
    graph,
    descriptions: Object.fromEntries(nodes.map((node, i) => [node.id, topics[i][en ? 3 : 2]])),
  };
}
