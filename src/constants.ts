import kiroLogo from "./assets/kiro.svg";
import vscodeLogo from "./assets/vscode.svg";
import type { McpPresetOption } from "./types";

export const SUPPORTED_EDITORS = [
  {
    id: "vscode",
    name: "VSCode",
    icon: vscodeLogo,
    desc: "支持账号切换、扩展宿主重启与 Hook 提速。",
  },
  {
    id: "kiro",
    name: "Kiro",
    icon: kiroLogo,
    desc: "支持账号切换、状态同步与命令重载触发。",
  },
] as const;

export const APP_SERVER_CONSOLE_LOG_ENABLED = false;
export const MCP_CONFIG_PLACEHOLDER = '{\n  "type": "stdio",\n  "command": "uvx",\n  "args": ["mcp-server-fetch"]\n}';

const IS_WINDOWS_PLATFORM = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

function createNpxPresetSpec(packageName: string): Record<string, unknown> {
  if (IS_WINDOWS_PLATFORM) {
    return {
      type: "stdio",
      command: "cmd",
      args: ["/c", "npx", "-y", packageName],
    };
  }
  return {
    type: "stdio",
    command: "npx",
    args: ["-y", packageName],
  };
}

export const MCP_PRESET_OPTIONS: McpPresetOption[] = [
  {
    id: "fetch",
    name: "mcp-server-fetch",
    description: "通用 HTTP 请求工具，支持 GET/POST 等 HTTP 方法，适合快速请求接口或抓取网页数据。",
    tags: ["stdio", "http", "web"],
    homepage: "https://github.com/modelcontextprotocol/servers",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    spec: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] },
  },
  {
    id: "time",
    name: "@modelcontextprotocol/server-time",
    description: "时间查询工具，提供当前时间、时区转换、日期计算等能力。",
    tags: ["stdio", "time", "utility"],
    homepage: "https://github.com/modelcontextprotocol/servers",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    spec: createNpxPresetSpec("@modelcontextprotocol/server-time"),
  },
  {
    id: "memory",
    name: "@modelcontextprotocol/server-memory",
    description: "知识图谱记忆系统，可存储实体、关系和观察信息。",
    tags: ["stdio", "memory", "graph"],
    homepage: "https://github.com/modelcontextprotocol/servers",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    spec: createNpxPresetSpec("@modelcontextprotocol/server-memory"),
  },
  {
    id: "sequential-thinking",
    name: "@modelcontextprotocol/server-sequential-thinking",
    description: "顺序思考工具，帮助 AI 分步拆解和推理复杂问题。",
    tags: ["stdio", "thinking", "reasoning"],
    homepage: "https://github.com/modelcontextprotocol/servers",
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    spec: createNpxPresetSpec("@modelcontextprotocol/server-sequential-thinking"),
  },
  {
    id: "context7",
    name: "@upstash/context7-mcp",
    description: "Context7 文档搜索工具，提供最新库文档和示例代码。",
    tags: ["stdio", "docs", "search"],
    homepage: "https://context7.com",
    docs: "https://github.com/upstash/context7/blob/master/README.md",
    spec: createNpxPresetSpec("@upstash/context7-mcp"),
  },
];

export const STARTUP_KEEPALIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
export const AUTO_KEEPALIVE_BASE_MS = 48 * 60 * 60 * 1000;
export const AUTO_KEEPALIVE_JITTER_MS = 30 * 60 * 1000;
export const STARTUP_STAGGER_MIN_MS = 60 * 1000;
export const STARTUP_STAGGER_MAX_MS = 8 * 60 * 1000;
export const AUTO_BUSY_RETRY_MS = 30 * 1000;
export const AUTO_SWITCH_TICK_MS = 500;
export const THREAD_RECOVER_TICK_MS = 2000;
export const AUTO_HOOK_VERSION_POLL_MS = 3000;
export const HOOK_LISTEN_POLL_MS = 3000;
export const HOOK_LISTEN_VSCODE_POLL_MS = 15_000;
export const LIVE_STATUS_POLL_MS = 500;
export const LIVE_STATUS_FETCH_MIN_MS = 500;
export const LIVE_STATUS_ERROR_RETRY_MS = 250;
export const LIVE_STATUS_ERROR_RETRY_MAX_MS = 900;
export const LIVE_STATUS_BURST_WINDOW_MS = 3000;
export const LIVE_STATUS_BURST_THRESHOLD = 6;
export const LIVE_STATUS_BURST_COOLDOWN_MS = 900;
export const STARTUP_LOAD_TIMEOUT_MS = 8000;
export const STARTUP_BACKGROUND_SYNC_DELAY_MS = 120;
export const CURRENT_ERROR_BANNER_DELAY_MS = 1200;
export const DASHBOARD_WAIT_STEP_MS = 250;
export const DASHBOARD_WAIT_MAX_STEPS = 40;
export const AUTO_SEAMLESS_STORAGE_KEY = "codex-switch.autoSeamlessSwitch";
export const AUTO_REFRESH_ON_STARTUP_STORAGE_KEY = "codex-switch.autoRefreshQuotaOnStartup";
export const POST_SWITCH_STRATEGY_STORAGE_KEY = "codex-switch.postSwitchStrategy";
export const WINDOW_CLOSE_ACTION_STORAGE_KEY = "codex-switch.windowCloseAction";
export const HOOK_VERSION_SNAPSHOT_STORAGE_KEY = "codex-switch.hookVersionSnapshot";
export const APP_MODE_STORAGE_KEY = "codex-switch.activeAppMode";
export const ACTIVE_PROFILE_BY_MODE_STORAGE_KEY = "codex-switch.activeProfileByMode";
