import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { confirm, open } from "@tauri-apps/plugin-dialog";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, Book, ChevronDown, ChevronUp, Download, ExternalLink, FileArchive, Plus, RefreshCw, Search, Server, Settings, Trash2, Wrench } from "lucide-react";
import "./App.css";
import openaiLogo from "./assets/openai.svg";
import opencodeLogo from "./assets/opencode.svg";
import vscodeLogo from "./assets/vscode.svg";

type MaybeNum = number | null | undefined;

interface ProfileSupportView {
  gpt: boolean;
  opencode: boolean;
}

interface CurrentStatusView {
  email?: string | null;
  workspaceName?: string | null;
  workspaceId?: string | null;
  displayWorkspace: string;
  fiveHourRemainingPercent?: number | null;
  fiveHourResetsAt?: number | null;
  oneWeekRemainingPercent?: number | null;
  oneWeekResetsAt?: number | null;
}

interface ProfileView {
  name: string;
  email?: string | null;
  workspaceName?: string | null;
  workspaceId?: string | null;
  workspaceAlias?: string | null;
  support: ProfileSupportView;
  displayWorkspace: string;
  fiveHourRemainingPercent?: number | null;
  fiveHourResetsAt?: number | null;
  oneWeekRemainingPercent?: number | null;
  oneWeekResetsAt?: number | null;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  status: string;
  isActive: boolean;
}

interface DashboardData {
  appName: string;
  activeProfile?: string | null;
  current?: CurrentStatusView | null;
  currentError?: string | null;
  lastKeepaliveAt?: number | null;
  profiles: ProfileView[];
}

interface AutoSwitchTickResult {
  action: string;
  message?: string | null;
  switchedTo?: string | null;
  reloadTriggered: boolean;
  pendingReason?: string | null;
  dashboard?: DashboardData | null;
}

interface VsCodeStatusView {
  running: boolean;
  processCount: number;
}

interface OpenCodeMonitorStatusView {
  authReady: boolean;
  logReady: boolean;
  logRecent: boolean;
  lastLogAgeMs?: number | null;
  activityRecent: boolean;
  lastActivityAgeMs?: number | null;
  activitySource?: string | null;
}

interface CodexExtensionInfoView {
  currentVersion?: string | null;
  allVersions: string[];
}

interface LoginProgressPayload {
  phase: string;
  message: string;
}

interface BackupExportResult {
  archivePath: string;
  fileCount: number;
  estimatedTotalBytes: number;
}

interface BackupImportResult {
  sourceFileName: string;
  safeguardArchivePath: string;
  restoredCount: number;
  dashboard: DashboardData;
}

interface SkillEntryView {
  id: string;
  directory: string;
  name: string;
  description: string;
  codexEnabled: boolean;
  opencodeEnabled: boolean;
  codexAvailable: boolean;
  opencodeAvailable: boolean;
  source: string;
  locations: string[];
}

interface SkillsCatalogView {
  total: number;
  codexEnabledCount: number;
  opencodeEnabledCount: number;
  skills: SkillEntryView[];
}

interface DiscoverSkillRepoView {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

interface DiscoverSkillEntryView {
  id: string;
  name: string;
  description: string;
  directory: string;
  repoDirectory: string;
  repoOwner: string;
  repoName: string;
  repoBranch: string;
  readmeUrl: string;
  installed: boolean;
}

interface SkillsDiscoveryView {
  total: number;
  repos: DiscoverSkillRepoView[];
  skills: DiscoverSkillEntryView[];
}

interface SkillRepoManageItemView {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
  skillCount?: number | null;
  repoUrl: string;
}

interface SkillRepoManageView {
  repos: SkillRepoManageItemView[];
}

interface McpServerView {
  id: string;
  name: string;
  description: string;
  docUrl?: string | null;
  endpointUrl?: string | null;
  source: string;
  kind: string;
  codexEnabled: boolean;
  opencodeEnabled: boolean;
  codexAvailable: boolean;
  opencodeAvailable: boolean;
}

interface McpManageView {
  total: number;
  codexEnabledCount: number;
  opencodeEnabledCount: number;
  servers: McpServerView[];
}

interface McpPresetOption {
  id: string;
  name: string;
  description: string;
  tags: string[];
  homepage: string;
  docs: string;
  spec: Record<string, unknown>;
}

type PostSwitchStrategy = "hook" | "restart_extension_host";
type AppMode = "gpt" | "opencode";
type ActiveProfileByMode = Record<AppMode, string | null>;
type SkillTarget = "codex" | "opencode";
type ToolView = "dashboard" | "skills" | "skillsDiscovery" | "skillsRepos" | "prompts" | "mcp" | "mcpAdd";

const MCP_CONFIG_PLACEHOLDER = '{\n  "type": "stdio",\n  "command": "uvx",\n  "args": ["mcp-server-fetch"]\n}';
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

const MCP_PRESET_OPTIONS: McpPresetOption[] = [
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

function formatCurrentErrorWithProfile(data: Pick<DashboardData, "activeProfile" | "profiles"> | null, raw?: string | null): string | null {
  if (!raw) {
    return null;
  }
  if (!data?.activeProfile) {
    return raw;
  }
  const idx = data.profiles.findIndex((p) => p.name === data.activeProfile);
  if (idx < 0) {
    return raw;
  }
  const profile = data.profiles[idx];
  return `账号 #${idx + 1} (${profile.displayWorkspace}): ${raw}`;
}

const STARTUP_KEEPALIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const AUTO_KEEPALIVE_BASE_MS = 48 * 60 * 60 * 1000;
const AUTO_KEEPALIVE_JITTER_MS = 30 * 60 * 1000;
const STARTUP_STAGGER_MIN_MS = 60 * 1000;
const STARTUP_STAGGER_MAX_MS = 8 * 60 * 1000;
const AUTO_BUSY_RETRY_MS = 30 * 1000;
const AUTO_SWITCH_TICK_MS = 500;
const THREAD_RECOVER_TICK_MS = 2000;
const AUTO_HOOK_VERSION_POLL_MS = 3000;
const HOOK_LISTEN_POLL_MS = 3000;
const HOOK_LISTEN_VSCODE_POLL_MS = 15_000;
const LIVE_STATUS_POLL_MS = 500;
const LIVE_STATUS_FETCH_MIN_MS = 1500;
const LIVE_STATUS_ERROR_RETRY_MS = 250;
const LIVE_STATUS_ERROR_RETRY_MAX_MS = 900;
const LIVE_STATUS_BURST_WINDOW_MS = 3000;
const LIVE_STATUS_BURST_THRESHOLD = 6;
const LIVE_STATUS_BURST_COOLDOWN_MS = 900;
const LIVE_STATUS_DISPLAY_STALE_MS = 4200;
const DASHBOARD_WAIT_STEP_MS = 250;
const DASHBOARD_WAIT_MAX_STEPS = 40;
const AUTO_SEAMLESS_STORAGE_KEY = "codex-switch.autoSeamlessSwitch";
const AUTO_REFRESH_ON_STARTUP_STORAGE_KEY = "codex-switch.autoRefreshQuotaOnStartup";
const POST_SWITCH_STRATEGY_STORAGE_KEY = "codex-switch.postSwitchStrategy";
const HOOK_VERSION_SNAPSHOT_STORAGE_KEY = "codex-switch.hookVersionSnapshot";
const APP_MODE_STORAGE_KEY = "codex-switch.activeAppMode";
const ACTIVE_PROFILE_BY_MODE_STORAGE_KEY = "codex-switch.activeProfileByMode";

function readBoolStorage(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return fallback;
    }
    if (raw === "1" || raw === "true") {
      return true;
    }
    if (raw === "0" || raw === "false") {
      return false;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function readPostSwitchStrategyStorage(fallback: PostSwitchStrategy): PostSwitchStrategy {
  try {
    const raw = window.localStorage.getItem(POST_SWITCH_STRATEGY_STORAGE_KEY);
    if (raw === "hook" || raw === "restart_extension_host") {
      return raw;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function readStringStorage(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const text = raw.trim();
    return text.length ? text : null;
  } catch {
    return null;
  }
}

function readAppModeStorage(fallback: AppMode): AppMode {
  try {
    const raw = window.localStorage.getItem(APP_MODE_STORAGE_KEY);
    if (raw === "gpt" || raw === "opencode") {
      return raw;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

function readActiveProfileByModeStorage(): ActiveProfileByMode {
  const fallback: ActiveProfileByMode = { gpt: null, opencode: null };
  try {
    const raw = window.localStorage.getItem(ACTIVE_PROFILE_BY_MODE_STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<Record<AppMode, unknown>>;
    const normalize = (v: unknown): string | null => {
      if (typeof v !== "string") {
        return null;
      }
      const text = v.trim();
      return text.length ? text : null;
    };
    return {
      gpt: normalize(parsed.gpt),
      opencode: normalize(parsed.opencode),
    };
  } catch {
    return fallback;
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("读取备份文件失败。"));
        return;
      }
      const comma = reader.result.indexOf(",");
      if (comma < 0) {
        reject(new Error("备份文件编码格式无效。"));
        return;
      }
      resolve(reader.result.slice(comma + 1));
    };
    reader.onerror = () => {
      reject(new Error("读取备份文件失败。"));
    };
    reader.readAsDataURL(file);
  });
}

function nextPeriodicKeepaliveDelayMs() {
  const jitter = Math.floor((Math.random() * 2 - 1) * AUTO_KEEPALIVE_JITTER_MS);
  return AUTO_KEEPALIVE_BASE_MS + jitter;
}

function nextStartupStaggerDelayMs() {
  return (
    STARTUP_STAGGER_MIN_MS +
    Math.floor(Math.random() * (STARTUP_STAGGER_MAX_MS - STARTUP_STAGGER_MIN_MS + 1))
  );
}

function nextPeriodicDelayFromLastKeepalive(lastKeepaliveAt?: number | null) {
  if (!lastKeepaliveAt) {
    return nextPeriodicKeepaliveDelayMs();
  }
  const elapsed = Date.now() - lastKeepaliveAt * 1000;
  if (elapsed >= AUTO_KEEPALIVE_BASE_MS) {
    return nextStartupStaggerDelayMs();
  }
  const remain = AUTO_KEEPALIVE_BASE_MS - elapsed;
  const jitter = Math.floor((Math.random() * 2 - 1) * AUTO_KEEPALIVE_JITTER_MS);
  return Math.max(STARTUP_STAGGER_MIN_MS, remain + jitter);
}

function formatReset(ts: MaybeNum, mode: "time" | "dateTime" = "dateTime"): string {
  if (!ts || Number.isNaN(ts)) {
    return "-";
  }
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  if (mode === "time") {
    return `${hh}:${mi}`;
  }
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatCheckedAt(value?: string | null): string {
  if (!value) {
    return "-";
  }
  const text = value.trim();
  if (!text) {
    return "-";
  }

  const formatLocal = (d: Date) => {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  };

  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(text);
  if (hasExplicitTimezone) {
    const tzDate = new Date(text);
    if (!Number.isNaN(tzDate.getTime())) {
      return formatLocal(tzDate);
    }
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (m) {
    const ss = m[6] || "00";
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${ss}`;
  }

  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) {
    return formatLocal(d);
  }

  return text.replace("T", " ").replace("Z", "");
}

function pct(v: MaybeNum): string {
  if (v === undefined || v === null) {
    return "-";
  }
  return `${v}%`;
}

function statusClass(text: string): string {
  if (text.includes("受限") || text.includes("无权限")) {
    return "warn";
  }
  return text.includes("失效") ? "bad" : "good";
}

function stripCurrentActiveSuffix(status: string): string {
  return status.replace(/\(当前生效\)$/u, "");
}

function quotaClass(v: MaybeNum): string {
  if (v === undefined || v === null || Number.isNaN(v)) {
    return "quota-unknown";
  }
  if (v <= 20) {
    return "quota-low";
  }
  if (v <= 60) {
    return "quota-mid";
  }
  return "quota-high";
}

function supportBadgeText(support?: ProfileSupportView | null): string {
  const gpt = support?.gpt ?? true;
  const opencode = support?.opencode ?? false;
  if (gpt && opencode) {
    return "GPT+OpenCode";
  }
  if (opencode) {
    return "OpenCode";
  }
  return "GPT";
}

function supportBadgeClass(support?: ProfileSupportView | null): string {
  const gpt = support?.gpt ?? true;
  const opencode = support?.opencode ?? false;
  if (gpt && opencode) {
    return "support-both";
  }
  if (opencode) {
    return "support-opencode";
  }
  return "support-gpt";
}

function supportsAppMode(support: ProfileSupportView | null | undefined, mode: AppMode): boolean {
  const gpt = support?.gpt ?? true;
  const opencode = support?.opencode ?? false;
  return mode === "gpt" ? gpt : opencode;
}

function formatLocalDateTimeFromMs(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function parseCheckedAtToMs(value?: string | null): number | null {
  if (!value) {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (m) {
    const dt = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
      0,
    );
    const t = dt.getTime();
    return Number.isNaN(t) ? null : t;
  }
  const parsed = new Date(text);
  const ts = parsed.getTime();
  return Number.isNaN(ts) ? null : ts;
}

function normalizeIdentityValue(value?: string | null): string | null {
  const text = (value || "").trim().toLowerCase();
  return text || null;
}

function findProfileNameForCurrent(data: DashboardData): string | null {
  if (!data.current) {
    return data.activeProfile ?? null;
  }
  const currentWorkspace = normalizeIdentityValue(data.current.workspaceId);
  const currentEmail = normalizeIdentityValue(data.current.email);

  let exactMatch: string | null = null;
  let exactCount = 0;
  let workspaceMatch: string | null = null;
  let workspaceCount = 0;
  let emailMatch: string | null = null;
  let emailCount = 0;

  for (const profile of data.profiles) {
    const profileWorkspace = normalizeIdentityValue(profile.workspaceId);
    const profileEmail = normalizeIdentityValue(profile.email);

    if (currentWorkspace && profileWorkspace === currentWorkspace) {
      workspaceCount += 1;
      workspaceMatch = profile.name;
    }
    if (currentEmail && profileEmail === currentEmail) {
      emailCount += 1;
      emailMatch = profile.name;
    }
    if (
      currentWorkspace &&
      currentEmail &&
      profileWorkspace === currentWorkspace &&
      profileEmail === currentEmail
    ) {
      exactCount += 1;
      exactMatch = profile.name;
    }
  }

  if (exactCount === 1 && exactMatch) {
    return exactMatch;
  }
  if (currentWorkspace && workspaceCount === 1 && workspaceMatch) {
    return workspaceMatch;
  }
  if (currentEmail && emailCount === 1 && emailMatch) {
    return emailMatch;
  }
  return data.activeProfile ?? null;
}

function buildDashboardSignature(data: DashboardData): string {
  return JSON.stringify(data);
}

function stringArrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

interface SortableProfileCardProps {
  profile: ProfileView;
  index: number;
  selected: boolean;
  isModeActive: boolean;
  busy: boolean;
  checkedAtOverride?: string | null;
  onSelect: (name: string) => void;
  onRefreshQuota: (name: string) => void;
  onApply: (name: string) => void;
  onSetAlias: (name: string) => void;
  onDelete: (name: string) => void;
}

function SortableProfileCard({
  profile,
  index,
  selected,
  isModeActive,
  busy,
  checkedAtOverride,
  onSelect,
  onRefreshQuota,
  onApply,
  onSetAlias,
  onDelete,
}: SortableProfileCardProps) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: profile.name,
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    animationDelay: `${Math.min(index * 45, 320)}ms`,
  };
  const statusText = stripCurrentActiveSuffix(profile.status);

  return (
    <div ref={setNodeRef} style={style} className={`sortable-item ${isDragging ? "sorting-item-dragging" : ""}`}>
      <article
        className={`profile-card ${selected ? "selected" : ""} ${isModeActive ? "active" : ""} ${
          isDragging ? "dragging-source" : ""
        }`}
        onClick={() => onSelect(profile.name)}
      >
        <button
          type="button"
          className="card-left-icon drag-handle"
          title="拖拽调整顺序"
          aria-label={`拖拽调整顺序: ${profile.displayWorkspace}`}
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <div className="card-main">
          <div className="workspace-title">
            <span className="profile-no">#{index + 1}</span>
            <span className="workspace-name">{profile.displayWorkspace}</span>
          </div>
          <div className="email-line">{profile.email || "-"}</div>
          <div className="quota-line">
            <span className={`quota-pill quota-pill-week ${quotaClass(profile.oneWeekRemainingPercent)}`}>
              <strong>1 周</strong>
              <b>{pct(profile.oneWeekRemainingPercent)}</b>
              <small>{formatReset(profile.oneWeekResetsAt)}</small>
            </span>
            <span className={`quota-pill quota-pill-hour ${quotaClass(profile.fiveHourRemainingPercent)}`}>
              <strong>5 小时</strong>
              <b>{pct(profile.fiveHourRemainingPercent)}</b>
              <small>{formatReset(profile.fiveHourResetsAt, "time")}</small>
            </span>
          </div>
          <div className="meta-line">最近刷新: {formatCheckedAt(checkedAtOverride ?? profile.lastCheckedAt)}</div>
        </div>
        <div className="card-side">
          <div className="support-badge-row">
            {isModeActive ? <span className="mode-active-chip">当前生效</span> : null}
            <span className={`support-badge ${supportBadgeClass(profile.support)}`}>
              {supportBadgeText(profile.support)}
            </span>
          </div>
          <div className="status-row">
            <span className={`status-pill ${statusClass(statusText)}`}>{statusText}</span>
            <button
              className="mini-icon"
              disabled={busy}
              title="刷新此账号额度"
              onClick={(e) => {
                e.stopPropagation();
                onRefreshQuota(profile.name);
              }}
            >
              ↻
            </button>
          </div>
          <div className="action-rail">
            <button
              className="card-action primary"
              disabled={busy || isModeActive}
              onClick={(e) => {
                e.stopPropagation();
                onApply(profile.name);
              }}
            >
              {isModeActive ? "使用中" : "使用"}
            </button>
            <button
              className="card-action"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onSetAlias(profile.name);
              }}
            >
              改名
            </button>
            <button
              className="card-action danger"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onDelete(profile.name);
              }}
            >
              删除
            </button>
          </div>
        </div>
      </article>
    </div>
  );
}

function McpIcon({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      height={size}
      width={size}
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path d="M15.688 2.343a2.588 2.588 0 00-3.61 0l-9.626 9.44a.863.863 0 01-1.203 0 .823.823 0 010-1.18l9.626-9.44a4.313 4.313 0 016.016 0 4.116 4.116 0 011.204 3.54 4.3 4.3 0 013.609 1.18l.05.05a4.115 4.115 0 010 5.9l-8.706 8.537a.274.274 0 000 .393l1.788 1.754a.823.823 0 010 1.18.863.863 0 01-1.203 0l-1.788-1.753a1.92 1.92 0 010-2.754l8.706-8.538a2.47 2.47 0 000-3.54l-.05-.049a2.588 2.588 0 00-3.607-.003l-7.172 7.034-.002.002-.098.097a.863.863 0 01-1.204 0 .823.823 0 010-1.18l7.273-7.133a2.47 2.47 0 00-.003-3.537z" />
      <path d="M14.485 4.703a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a4.115 4.115 0 000 5.9 4.314 4.314 0 006.016 0l7.12-6.982a.823.823 0 000-1.18.863.863 0 00-1.204 0l-7.119 6.982a2.588 2.588 0 01-3.61 0 2.47 2.47 0 010-3.54l7.12-6.982z" />
    </svg>
  );
}

interface SkillTargetSwitchProps {
  label: string;
  icon: string;
  checked: boolean;
  busy: boolean;
  onClick: () => void;
}

function SkillTargetSwitch({ label, icon, checked, busy, onClick }: SkillTargetSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`skill-target-switch ${checked ? "on" : "off"}`}
      onClick={onClick}
      disabled={busy}
    >
      <span className="skill-target-label">
        <img src={icon} alt="" aria-hidden className="skill-target-icon" />
        <span>{label}</span>
      </span>
      <span className={`skill-target-track ${checked ? "on" : "off"}`}>
        <span className="skill-target-thumb" />
      </span>
    </button>
  );
}

function recomputeSkillsCatalog(catalog: SkillsCatalogView): SkillsCatalogView {
  const codexEnabledCount = catalog.skills.filter((item) => item.codexEnabled).length;
  const opencodeEnabledCount = catalog.skills.filter((item) => item.opencodeEnabled).length;
  return {
    ...catalog,
    total: catalog.skills.length,
    codexEnabledCount,
    opencodeEnabledCount,
  };
}

function recomputeMcpManage(view: McpManageView): McpManageView {
  const codexEnabledCount = view.servers.filter((item) => item.codexEnabled).length;
  const opencodeEnabledCount = view.servers.filter((item) => item.opencodeEnabled).length;
  return {
    ...view,
    total: view.servers.length,
    codexEnabledCount,
    opencodeEnabledCount,
  };
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [displayProfiles, setDisplayProfiles] = useState<ProfileView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codexExtInfo, setCodexExtInfo] = useState<CodexExtensionInfoView | null>(null);
  const [vscodeStatus, setVsCodeStatus] = useState<VsCodeStatusView | null>(null);
  const [opencodeMonitorStatus, setOpenCodeMonitorStatus] = useState<OpenCodeMonitorStatusView | null>(null);
  const [hookInstalled, setHookInstalled] = useState<boolean | null>(null);
  const [hookVersionSnapshot, setHookVersionSnapshot] = useState<string | null>(() =>
    readStringStorage(HOOK_VERSION_SNAPSHOT_STORAGE_KEY),
  );
  const [statusText, setStatusText] = useState("账号加载中...");
  const [busy, setBusy] = useState(true);
  const [quotaQuerying, setQuotaQuerying] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [autoSeamlessSwitch, setAutoSeamlessSwitch] = useState<boolean>(() =>
    readBoolStorage(AUTO_SEAMLESS_STORAGE_KEY, true),
  );
  const [autoRefreshOnStartup, setAutoRefreshOnStartup] = useState<boolean>(() =>
    readBoolStorage(AUTO_REFRESH_ON_STARTUP_STORAGE_KEY, false),
  );
  const [postSwitchStrategy, setPostSwitchStrategy] = useState<PostSwitchStrategy>(() =>
    readPostSwitchStrategyStorage("restart_extension_host"),
  );
  const [autoKeepalive, setAutoKeepalive] = useState(true);
  const [blockingMessage, setBlockingMessage] = useState<string | null>(null);
  const [activeAppMode, setActiveAppMode] = useState<AppMode>(() => readAppModeStorage("gpt"));
  const [activeProfileByMode, setActiveProfileByMode] = useState<ActiveProfileByMode>(() =>
    readActiveProfileByModeStorage(),
  );
  const [activeToolView, setActiveToolView] = useState<ToolView>("dashboard");
  const [skillsCatalog, setSkillsCatalog] = useState<SkillsCatalogView | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsRefreshing, setSkillsRefreshing] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsBusyIds, setSkillsBusyIds] = useState<Record<string, boolean>>({});
  const [skillsDiscovery, setSkillsDiscovery] = useState<SkillsDiscoveryView | null>(null);
  const [skillsDiscoveryLoading, setSkillsDiscoveryLoading] = useState(false);
  const [skillsDiscoveryRefreshing, setSkillsDiscoveryRefreshing] = useState(false);
  const [skillsDiscoveryError, setSkillsDiscoveryError] = useState<string | null>(null);
  const [skillsDiscoveryKeyword, setSkillsDiscoveryKeyword] = useState("");
  const [skillsDiscoveryInstallFilter, setSkillsDiscoveryInstallFilter] = useState<"all" | "installed" | "notInstalled">("all");
  const [skillsDiscoveryInstallingIds, setSkillsDiscoveryInstallingIds] = useState<Record<string, boolean>>({});
  const [skillReposManage, setSkillReposManage] = useState<SkillRepoManageView | null>(null);
  const [skillReposManageLoading, setSkillReposManageLoading] = useState(false);
  const [skillReposManageRefreshing, setSkillReposManageRefreshing] = useState(false);
  const [skillReposManageError, setSkillReposManageError] = useState<string | null>(null);
  const [skillRepoInput, setSkillRepoInput] = useState("");
  const [skillRepoBranch, setSkillRepoBranch] = useState("main");
  const [skillRepoActionBusyKeys, setSkillRepoActionBusyKeys] = useState<Record<string, boolean>>({});
  const [mcpManage, setMcpManage] = useState<McpManageView | null>(null);
  const [mcpManageLoading, setMcpManageLoading] = useState(false);
  const [mcpManageRefreshing, setMcpManageRefreshing] = useState(false);
  const [mcpManageError, setMcpManageError] = useState<string | null>(null);
  const [mcpBusyIds, setMcpBusyIds] = useState<Record<string, boolean>>({});
  const [mcpFormId, setMcpFormId] = useState("");
  const [mcpFormName, setMcpFormName] = useState("");
  const [mcpFormDescription, setMcpFormDescription] = useState("");
  const [mcpFormTags, setMcpFormTags] = useState("");
  const [mcpFormHomepage, setMcpFormHomepage] = useState("");
  const [mcpFormDocs, setMcpFormDocs] = useState("");
  const [mcpFormConfig, setMcpFormConfig] = useState("");
  const [mcpSelectedPreset, setMcpSelectedPreset] = useState<string>("custom");
  const [mcpShowMetadata, setMcpShowMetadata] = useState(false);
  const [mcpFormClaudeEnabled, setMcpFormClaudeEnabled] = useState(true);
  const [mcpFormGeminiEnabled, setMcpFormGeminiEnabled] = useState(true);
  const [mcpFormCodexEnabled, setMcpFormCodexEnabled] = useState(true);
  const [mcpFormOpencodeEnabled, setMcpFormOpencodeEnabled] = useState(false);
  const [mcpFormError, setMcpFormError] = useState<string | null>(null);

  const autoTimerRef = useRef<number | null>(null);
  const autoRunningRef = useRef(false);
  const autoEnabledRef = useRef(true);
  const seamlessTimerRef = useRef<number | null>(null);
  const seamlessRunningRef = useRef(false);
  const seamlessEnabledRef = useRef(true);
  const threadRecoverTimerRef = useRef<number | null>(null);
  const threadRecoverRunningRef = useRef(false);
  const busyRef = useRef(false);
  const blockingRef = useRef<string | null>(null);
  const dashboardRef = useRef<DashboardData | null>(null);
  const dashboardSignatureRef = useRef<string>("");
  const startupKeepaliveCheckedRef = useRef(false);
  const startupQuotaRefreshDoneRef = useRef(false);
  const hookListenerWarnedRef = useRef(false);
  const sortSavingRef = useRef(false);
  const pendingSortNamesRef = useRef<string[] | null>(null);
  const autoHookUpgradeRunningRef = useRef(false);
  const importBackupInputRef = useRef<HTMLInputElement | null>(null);
  const liveStatusPollingRef = useRef(false);
  const liveStatusNextFetchAtRef = useRef(0);
  const liveStatusErrorStreakRef = useRef(0);
  const liveStatusErrorTimesRef = useRef<number[]>([]);
  const hookListenerVsCodeLastPollAtRef = useRef(0);

  const switchAppMode = useCallback((mode: AppMode) => {
    setActiveAppMode(mode);
    setStatusText(`已切换到 ${mode === "gpt" ? "GPT" : "OpenCode"} 模式`);
  }, []);

  const loadSkillsCatalog = useCallback(async (showLoading: boolean) => {
    if (showLoading) {
      setSkillsLoading(true);
    } else {
      setSkillsRefreshing(true);
    }
    try {
      const data = await invoke<SkillsCatalogView>("load_skills_catalog");
      setSkillsCatalog(recomputeSkillsCatalog(data));
      setSkillsError(null);
      return true;
    } catch (err) {
      setSkillsError(`读取 Skills 失败: ${String(err)}`);
      return false;
    } finally {
      setSkillsLoading(false);
      setSkillsRefreshing(false);
    }
  }, []);

  const onRefreshSkillsCatalog = useCallback(async () => {
    if (skillsLoading || skillsRefreshing) {
      return;
    }
    setStatusText("正在刷新 Skills...");
    const ok = await loadSkillsCatalog(false);
    setStatusText(ok ? "已刷新 Skills" : "刷新 Skills 失败");
  }, [skillsLoading, skillsRefreshing, loadSkillsCatalog]);

  const loadSkillsDiscovery = useCallback(async (showLoading: boolean, syncRemote: boolean) => {
    if (showLoading) {
      setSkillsDiscoveryLoading(true);
    } else {
      setSkillsDiscoveryRefreshing(true);
    }
    try {
      const data = await invoke<SkillsDiscoveryView>("load_skills_discovery", { syncRemote });
      setSkillsDiscovery(data);
      setSkillsDiscoveryError(null);
    } catch (err) {
      setSkillsDiscoveryError(`读取发现技能失败: ${String(err)}`);
    } finally {
      setSkillsDiscoveryLoading(false);
      setSkillsDiscoveryRefreshing(false);
    }
  }, []);

  const loadSkillReposManage = useCallback(async (showLoading: boolean, refreshCount: boolean) => {
    if (showLoading) {
      setSkillReposManageLoading(true);
    } else {
      setSkillReposManageRefreshing(true);
    }
    try {
      const data = await invoke<SkillRepoManageView>("load_skill_repos_manage", { refreshCount });
      setSkillReposManage(data);
      setSkillReposManageError(null);
    } catch (err) {
      setSkillReposManageError(`读取仓库管理失败: ${String(err)}`);
    } finally {
      setSkillReposManageLoading(false);
      setSkillReposManageRefreshing(false);
    }
  }, []);

  const loadMcpManage = useCallback(async (showLoading: boolean) => {
    if (showLoading) {
      setMcpManageLoading(true);
    } else {
      setMcpManageRefreshing(true);
    }
    try {
      const data = await invoke<McpManageView>("load_mcp_manage");
      setMcpManage(recomputeMcpManage(data));
      setMcpManageError(null);
      return true;
    } catch (err) {
      setMcpManageError(`读取 MCP 失败: ${String(err)}`);
      return false;
    } finally {
      setMcpManageLoading(false);
      setMcpManageRefreshing(false);
    }
  }, []);

  const onRefreshMcpManage = useCallback(async () => {
    if (mcpManageLoading || mcpManageRefreshing) {
      return;
    }
    setStatusText("正在刷新 MCP...");
    const ok = await loadMcpManage(false);
    setStatusText(ok ? "已刷新 MCP" : "刷新 MCP 失败");
  }, [mcpManageLoading, mcpManageRefreshing, loadMcpManage]);

  const onImportExistingMcp = useCallback(async () => {
    setMcpManageRefreshing(true);
    try {
      const data = await invoke<McpManageView>("import_existing_mcp");
      setMcpManage(recomputeMcpManage(data));
      setMcpManageError(null);
      setStatusText(`已导入已有 MCP 配置（${data.total} 个）`);
    } catch (err) {
      setMcpManageError(`导入 MCP 失败: ${String(err)}`);
    } finally {
      setMcpManageRefreshing(false);
    }
  }, []);

  const resetMcpAddForm = useCallback(() => {
    setMcpFormId("");
    setMcpFormName("");
    setMcpFormDescription("");
    setMcpFormTags("");
    setMcpFormHomepage("");
    setMcpFormDocs("");
    setMcpFormConfig("");
    setMcpSelectedPreset("custom");
    setMcpShowMetadata(false);
    setMcpFormClaudeEnabled(true);
    setMcpFormGeminiEnabled(true);
    setMcpFormCodexEnabled(true);
    setMcpFormOpencodeEnabled(false);
    setMcpFormError(null);
  }, []);

  const openMcpAddPage = useCallback(() => {
    resetMcpAddForm();
    setActiveToolView("mcpAdd");
  }, [resetMcpAddForm]);

  const closeMcpAddPage = useCallback(() => {
    setActiveToolView("mcp");
    setMcpFormError(null);
  }, []);

  const applyMcpPreset = useCallback((presetId: string) => {
    if (presetId === "custom") {
      setMcpSelectedPreset("custom");
      setMcpFormId("");
      setMcpFormName("");
      setMcpFormDescription("");
      setMcpFormTags("");
      setMcpFormHomepage("");
      setMcpFormDocs("");
      setMcpFormConfig("");
      setMcpFormError(null);
      return;
    }
    const preset = MCP_PRESET_OPTIONS.find((item) => item.id === presetId);
    if (!preset) {
      return;
    }
    setMcpSelectedPreset(preset.id);
    setMcpFormId(preset.id);
    setMcpFormName(preset.name);
    setMcpFormDescription(preset.description);
    setMcpFormTags(preset.tags.join(", "));
    setMcpFormHomepage(preset.homepage);
    setMcpFormDocs(preset.docs);
    setMcpFormConfig(JSON.stringify(preset.spec, null, 2));
    setMcpFormError(null);
  }, []);

  const onSubmitMcpAdd = useCallback(async () => {
    const id = mcpFormId.trim();
    if (!id) {
      setMcpFormError("MCP 标题不能为空。");
      return;
    }
    if (!mcpFormCodexEnabled && !mcpFormOpencodeEnabled) {
      setMcpFormError("至少启用 Codex 或 OpenCode 其中之一。");
      return;
    }

    let spec: Record<string, unknown>;
    if (!mcpFormConfig.trim()) {
      setMcpFormError("请填写 JSON 配置。");
      return;
    }
    try {
      const parsed = JSON.parse(mcpFormConfig);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setMcpFormError("JSON 配置必须是对象。");
        return;
      }
      spec = parsed as Record<string, unknown>;
    } catch {
      setMcpFormError("JSON 配置格式无效。");
      return;
    }

    const type = String(spec.type ?? "stdio").trim().toLowerCase();
    if (type === "stdio") {
      const command = String(spec.command ?? "").trim();
      if (!command) {
        setMcpFormError("stdio 类型的 MCP 服务器缺少 command 字段。");
        return;
      }
    } else if (type === "http" || type === "sse") {
      const url = String(spec.url ?? "").trim();
      if (!url) {
        setMcpFormError(`${type} 类型的 MCP 服务器缺少 url 字段。`);
        return;
      }
    } else {
      setMcpFormError(`不支持的 MCP 服务器类型: ${type}`);
      return;
    }

    const busyKey = "__add__";
    setMcpBusyIds((prev) => ({ ...prev, [busyKey]: true }));
    try {
      const data = await invoke<McpManageView>("add_mcp_server", {
        serverId: id,
        spec,
        codex: mcpFormCodexEnabled,
        opencode: mcpFormOpencodeEnabled,
      });
      setMcpManage(recomputeMcpManage(data));
      setMcpManageError(null);
      resetMcpAddForm();
      setActiveToolView("mcp");
      setStatusText(`已添加 MCP: ${id}`);
    } catch (err) {
      setMcpFormError(`添加 MCP 失败: ${String(err)}`);
    } finally {
      setMcpBusyIds((prev) => {
        const next = { ...prev };
        delete next[busyKey];
        return next;
      });
    }
  }, [
    mcpFormId,
    mcpFormConfig,
    mcpFormCodexEnabled,
    mcpFormOpencodeEnabled,
    resetMcpAddForm,
  ]);

  const onFormatMcpConfig = useCallback(() => {
    const text = mcpFormConfig.trim();
    if (!text) {
      setMcpFormError("请先填写 JSON 配置。");
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setMcpFormError("JSON 配置必须是对象。");
        return;
      }
      setMcpFormConfig(JSON.stringify(parsed, null, 2));
      setMcpFormError(null);
    } catch {
      setMcpFormError("JSON 配置格式无效，无法格式化。");
    }
  }, [mcpFormConfig]);

  const onToggleMcpTarget = useCallback(
    async (server: McpServerView, target: SkillTarget) => {
      const nextCodex = target === "codex" ? !server.codexEnabled : server.codexEnabled;
      const nextOpenCode = target === "opencode" ? !server.opencodeEnabled : server.opencodeEnabled;
      setMcpBusyIds((prev) => ({ ...prev, [server.id]: true }));
      setMcpManage((prev) => {
        if (!prev) {
          return prev;
        }
        const optimistic = {
          ...prev,
          servers: prev.servers.map((item) =>
            item.id === server.id
              ? {
                  ...item,
                  codexEnabled: nextCodex,
                  opencodeEnabled: nextOpenCode,
                }
              : item,
          ),
        };
        return recomputeMcpManage(optimistic);
      });
      try {
        const data = await invoke<McpManageView>("set_mcp_targets", {
          serverId: server.id,
          codex: nextCodex,
          opencode: nextOpenCode,
        });
        setMcpManage(recomputeMcpManage(data));
        setMcpManageError(null);
      } catch (err) {
        setMcpManageError(`更新 MCP 开关失败: ${String(err)}`);
        await loadMcpManage(false);
      } finally {
        setMcpBusyIds((prev) => {
          const next = { ...prev };
          delete next[server.id];
          return next;
        });
      }
    },
    [loadMcpManage],
  );

  const onRemoveMcpServer = useCallback(async (server: McpServerView) => {
    const approved = await confirm(
      `确定删除 MCP 服务器 "${server.name || server.id}" 吗？\n将从 Codex / OpenCode 配置中移除。`,
      {
        title: "删除 MCP 服务器",
        kind: "warning",
        okLabel: "删除",
        cancelLabel: "取消",
      },
    );
    if (!approved) {
      return;
    }
    setMcpBusyIds((prev) => ({ ...prev, [server.id]: true }));
    try {
      const data = await invoke<McpManageView>("remove_mcp_server", { serverId: server.id });
      setMcpManage(recomputeMcpManage(data));
      setMcpManageError(null);
      setStatusText(`已删除 MCP: ${server.name || server.id}`);
    } catch (err) {
      setMcpManageError(`删除 MCP 失败: ${String(err)}`);
    } finally {
      setMcpBusyIds((prev) => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
    }
  }, []);

  const onOpenMcpDoc = useCallback((server: McpServerView) => {
    const targetUrl = (server.docUrl || "").trim();
    if (!targetUrl) {
      setStatusText(`MCP ${server.name || server.id} 未配置可访问文档链接。`);
      return;
    }
    void (async () => {
      try {
        await invoke<boolean>("open_external_url", { url: targetUrl });
        setStatusText(`已打开 MCP 文档: ${server.name || server.id}`);
      } catch (err) {
        setStatusText(`打开 MCP 文档失败: ${String(err)}`);
      }
    })();
  }, []);

  const onSkillsInstallFromZip = useCallback(async () => {
    try {
      const selected = await open({
        title: "选择 Skills ZIP 包",
        multiple: false,
        directory: false,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!selected || Array.isArray(selected)) {
        return;
      }
      setStatusText(`已选择 ZIP: ${selected}（当前版本暂未接入一键安装）`);
    } catch (err) {
      setStatusText(`读取 ZIP 失败: ${String(err)}`);
    }
  }, []);

  const onSkillsImportExisting = useCallback(async () => {
    await loadSkillsCatalog(false);
    setStatusText("已重新扫描本地 Skills。");
  }, [loadSkillsCatalog]);

  const onSkillsDiscover = useCallback(() => {
    setActiveToolView("skillsDiscovery");
  }, []);

  const onOpenSkillReposManage = useCallback(() => {
    setActiveToolView("skillsRepos");
  }, []);

  const onOpenDiscoverSkillReadme = useCallback((skill: DiscoverSkillEntryView) => {
    void (async () => {
      try {
        await invoke<boolean>("open_external_url", { url: skill.readmeUrl });
        setStatusText(`已打开技能: ${skill.name}`);
      } catch (err) {
        setStatusText(`打开技能详情失败: ${String(err)}`);
      }
    })();
  }, []);

  const onInstallDiscoverySkill = useCallback(
    async (skill: DiscoverSkillEntryView) => {
      if (skill.installed) {
        return;
      }
      setSkillsDiscoveryInstallingIds((prev) => ({ ...prev, [skill.id]: true }));
      try {
        await invoke<SkillsCatalogView>("install_discovery_skill", {
          repoOwner: skill.repoOwner,
          repoName: skill.repoName,
          repoBranch: skill.repoBranch,
          repoDirectory: skill.repoDirectory,
          localDirectory: skill.directory,
          readmeUrl: skill.readmeUrl,
          name: skill.name,
          description: skill.description,
        });
        setSkillsDiscovery((prev) =>
          prev
            ? {
                ...prev,
                skills: prev.skills.map((item) => (item.id === skill.id ? { ...item, installed: true } : item)),
              }
            : prev,
        );
        setStatusText(`已安装技能: ${skill.name}`);
        void loadSkillsCatalog(false);
      } catch (err) {
        setStatusText(`安装技能失败: ${String(err)}`);
      } finally {
        setSkillsDiscoveryInstallingIds((prev) => {
          const next = { ...prev };
          delete next[skill.id];
          return next;
        });
      }
    },
    [loadSkillsCatalog],
  );

  const onAddSkillRepo = useCallback(async () => {
    const repoInput = skillRepoInput.trim();
    if (!repoInput) {
      setSkillReposManageError("仓库 URL 不能为空。");
      return;
    }
    const busyKey = "__add__";
    setSkillRepoActionBusyKeys((prev) => ({ ...prev, [busyKey]: true }));
    try {
      const data = await invoke<SkillRepoManageView>("add_skill_repo", {
        repoInput,
        branch: skillRepoBranch.trim() || "main",
      });
      setSkillReposManage(data);
      setSkillReposManageError(null);
      setSkillRepoInput("");
      setStatusText(`已添加仓库: ${repoInput}`);
      void loadSkillReposManage(false, true);
      void loadSkillsDiscovery(false, true);
    } catch (err) {
      setSkillReposManageError(`添加仓库失败: ${String(err)}`);
    } finally {
      setSkillRepoActionBusyKeys((prev) => {
        const next = { ...prev };
        delete next[busyKey];
        return next;
      });
    }
  }, [skillRepoInput, skillRepoBranch, loadSkillReposManage, loadSkillsDiscovery]);

  const onRemoveSkillRepo = useCallback(
    async (repo: SkillRepoManageItemView) => {
      const key = `${repo.owner}/${repo.name}`;
      if (!window.confirm(`确定删除仓库 ${key} 吗？`)) {
        return;
      }
      setSkillRepoActionBusyKeys((prev) => ({ ...prev, [key]: true }));
      try {
        const data = await invoke<SkillRepoManageView>("remove_skill_repo", { owner: repo.owner, name: repo.name });
        setSkillReposManage(data);
        setSkillReposManageError(null);
        setStatusText(`已删除仓库: ${key}`);
        void loadSkillsDiscovery(false, false);
      } catch (err) {
        setSkillReposManageError(`删除仓库失败: ${String(err)}`);
      } finally {
        setSkillRepoActionBusyKeys((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [loadSkillsDiscovery],
  );

  const onOpenRepoHome = useCallback((repo: SkillRepoManageItemView) => {
    void (async () => {
      try {
        await invoke<boolean>("open_external_url", { url: repo.repoUrl });
        setStatusText(`已打开仓库: ${repo.owner}/${repo.name}`);
      } catch (err) {
        setStatusText(`打开仓库失败: ${String(err)}`);
      }
    })();
  }, []);

  const onToggleSkillTarget = useCallback(
    async (skill: SkillEntryView, target: SkillTarget) => {
      const nextCodex = target === "codex" ? !skill.codexEnabled : skill.codexEnabled;
      const nextOpenCode = target === "opencode" ? !skill.opencodeEnabled : skill.opencodeEnabled;
      setSkillsBusyIds((prev) => ({ ...prev, [skill.id]: true }));
      setSkillsCatalog((prev) => {
        if (!prev) {
          return prev;
        }
        const optimistic = {
          ...prev,
          skills: prev.skills.map((item) =>
            item.id === skill.id
              ? {
                  ...item,
                  codexEnabled: nextCodex,
                  opencodeEnabled: nextOpenCode,
                }
              : item,
          ),
        };
        return recomputeSkillsCatalog(optimistic);
      });
      try {
        const data = await invoke<SkillsCatalogView>("set_skill_targets", {
          skillId: skill.id,
          codex: nextCodex,
          opencode: nextOpenCode,
        });
        setSkillsCatalog(recomputeSkillsCatalog(data));
        setSkillsError(null);
      } catch (err) {
        setSkillsError(`更新 Skills 开关失败: ${String(err)}`);
        await loadSkillsCatalog(false);
      } finally {
        setSkillsBusyIds((prev) => {
          const next = { ...prev };
          delete next[skill.id];
          return next;
        });
      }
    },
    [loadSkillsCatalog],
  );

  const onDeleteSkill = useCallback(
    async (skill: SkillEntryView) => {
      const approved = await confirm(
        `确定删除技能 "${skill.name}" 吗？\n将从 Codex / OpenCode / 本地 Skills 中移除。`,
        {
          title: "删除技能",
          kind: "warning",
          okLabel: "删除",
          cancelLabel: "取消",
        },
      );
      if (!approved) {
        return;
      }
      setSkillsBusyIds((prev) => ({ ...prev, [skill.id]: true }));
      try {
        const data = await invoke<SkillsCatalogView>("delete_skill", { skillId: skill.id });
        setSkillsCatalog(recomputeSkillsCatalog(data));
        setSkillsError(null);
        setStatusText(`已删除技能: ${skill.name}`);
        setSkillsDiscovery((prev) =>
          prev
            ? {
                ...prev,
                skills: prev.skills.map((item) =>
                  item.directory.toLowerCase() === skill.directory.toLowerCase() ? { ...item, installed: false } : item,
                ),
              }
            : prev,
        );
      } catch (err) {
        setSkillsError(`删除技能失败: ${String(err)}`);
      } finally {
        setSkillsBusyIds((prev) => {
          const next = { ...prev };
          delete next[skill.id];
          return next;
        });
      }
    },
    [],
  );

  const skillsSummaryText = useMemo(() => {
    if (!skillsCatalog) {
      return "已安装 · Skills: 0 · Codex: 0 · OpenCode: 0";
    }
    return `已安装 · Skills: ${skillsCatalog.total} · Codex: ${skillsCatalog.codexEnabledCount} · OpenCode: ${skillsCatalog.opencodeEnabledCount}`;
  }, [skillsCatalog]);

  const skillsDiscoverySummaryText = useMemo(() => {
    if (!skillsDiscovery) {
      return "发现来源 · 仓库: 0/0 · Skills: 0";
    }
    const enabledRepoCount = skillsDiscovery.repos.filter((repo) => repo.enabled).length;
    return `发现来源 · 仓库: ${enabledRepoCount}/${skillsDiscovery.repos.length} · Skills: ${skillsDiscovery.total}`;
  }, [skillsDiscovery]);

  const filteredDiscoverySkills = useMemo(() => {
    if (!skillsDiscovery) {
      return [];
    }
    const keyword = skillsDiscoveryKeyword.trim().toLowerCase();
    return skillsDiscovery.skills.filter((skill) => {
      if (skillsDiscoveryInstallFilter === "installed" && !skill.installed) {
        return false;
      }
      if (skillsDiscoveryInstallFilter === "notInstalled" && skill.installed) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const haystack = `${skill.name} ${skill.description} ${skill.repoOwner}/${skill.repoName}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [skillsDiscovery, skillsDiscoveryKeyword, skillsDiscoveryInstallFilter]);

  const skillsDiscoverySyncingEmpty =
    skillsDiscoveryRefreshing && !skillsDiscoveryLoading && (skillsDiscovery?.skills.length ?? 0) === 0;

  const skillReposSyncingEmpty =
    skillReposManageRefreshing && !skillReposManageLoading && (skillReposManage?.repos.length ?? 0) === 0;

  const mcpSummaryText = useMemo(() => {
    if (!mcpManage) {
      return "已配置 0 个 MCP 服务器 · Codex: 0 · OpenCode: 0";
    }
    return `已配置 ${mcpManage.total} 个 MCP 服务器 · Codex: ${mcpManage.codexEnabledCount} · OpenCode: ${mcpManage.opencodeEnabledCount}`;
  }, [mcpManage]);

  const mcpSyncingEmpty =
    mcpManageRefreshing && !mcpManageLoading && (mcpManage?.servers.length ?? 0) === 0;

  useEffect(() => {
    if (activeToolView !== "skills") {
      return;
    }
    if (skillsCatalog || skillsLoading || skillsRefreshing) {
      return;
    }
    void loadSkillsCatalog(true);
  }, [activeToolView, loadSkillsCatalog, skillsCatalog, skillsLoading, skillsRefreshing]);

  useEffect(() => {
    if (activeToolView !== "skillsDiscovery") {
      return;
    }
    if (skillsDiscovery || skillsDiscoveryLoading || skillsDiscoveryRefreshing) {
      return;
    }
    void (async () => {
      await loadSkillsDiscovery(true, false);
      void loadSkillsDiscovery(false, true);
    })();
  }, [activeToolView, loadSkillsDiscovery, skillsDiscovery, skillsDiscoveryLoading, skillsDiscoveryRefreshing]);

  useEffect(() => {
    if (activeToolView !== "skillsRepos") {
      return;
    }
    if (skillReposManage || skillReposManageLoading || skillReposManageRefreshing) {
      return;
    }
    void (async () => {
      await loadSkillReposManage(true, false);
      void loadSkillReposManage(false, true);
    })();
  }, [activeToolView, loadSkillReposManage, skillReposManage, skillReposManageLoading, skillReposManageRefreshing]);

  useEffect(() => {
    if (activeToolView !== "mcp") {
      return;
    }
    if (mcpManage || mcpManageLoading || mcpManageRefreshing) {
      return;
    }
    void loadMcpManage(true);
  }, [activeToolView, loadMcpManage, mcpManage, mcpManageLoading, mcpManageRefreshing]);

  const applyDashboard = useCallback((data: DashboardData, msg?: string) => {
    const currentProfileName = findProfileNameForCurrent(data);
    const currentCheckedAt = formatLocalDateTimeFromMs(Date.now());
    const mergedProfiles =
      currentProfileName && data.current
        ? data.profiles.map((profile) =>
            profile.name === currentProfileName
              ? {
                  ...profile,
                  fiveHourRemainingPercent: data.current?.fiveHourRemainingPercent,
                  fiveHourResetsAt: data.current?.fiveHourResetsAt,
                  oneWeekRemainingPercent: data.current?.oneWeekRemainingPercent,
                  oneWeekResetsAt: data.current?.oneWeekResetsAt,
                  lastCheckedAt: currentCheckedAt,
                }
              : profile,
          )
        : data.profiles;
    const nextDashboard = mergedProfiles === data.profiles ? data : { ...data, profiles: mergedProfiles };
    dashboardSignatureRef.current = buildDashboardSignature(nextDashboard);

    dashboardRef.current = nextDashboard;
    setDashboard(nextDashboard);
    setDisplayProfiles(nextDashboard.profiles);
    setSelected((prev) => {
      if (prev && nextDashboard.profiles.some((p) => p.name === prev)) {
        return prev;
      }
      if (nextDashboard.activeProfile && nextDashboard.profiles.some((p) => p.name === nextDashboard.activeProfile)) {
        return nextDashboard.activeProfile;
      }
      return nextDashboard.profiles[0]?.name ?? null;
    });
    if (msg) {
      setStatusText(msg);
    }
  }, []);

  const loadDashboard = useCallback(
    async (syncCurrent = true, msg?: string, markInitialDone = false) => {
      setBusy(true);
      try {
        const data = await invoke<DashboardData>("load_dashboard", { syncCurrent });
        applyDashboard(data, msg);
        if (data.currentError) {
          const detail = formatCurrentErrorWithProfile(data, data.currentError) ?? data.currentError;
          setStatusText(`当前账号读取失败: ${detail}`);
        }
      } catch (err) {
        setStatusText(`加载失败: ${String(err)}`);
      } finally {
        setBusy(false);
        if (markInitialDone) {
          setInitialLoading(false);
        }
      }
    },
    [applyDashboard],
  );

  useEffect(() => {
    void loadDashboard(true, "已加载", true);
  }, [loadDashboard]);

  const refreshCurrentDashboardSilent = useCallback(async () => {
    if (busyRef.current || Boolean(blockingRef.current)) {
      return;
    }
    if (liveStatusPollingRef.current) {
      return;
    }
    const now = Date.now();
    if (now < liveStatusNextFetchAtRef.current) {
      return;
    }
    liveStatusPollingRef.current = true;
    liveStatusNextFetchAtRef.current = now + LIVE_STATUS_FETCH_MIN_MS;
    try {
      // High-frequency UI polling only reads local dashboard state; backend rate-limit reads are cached.
      const data = await invoke<DashboardData>("load_dashboard", { syncCurrent: false });
      const nextSignature = buildDashboardSignature(data);
      if (nextSignature !== dashboardSignatureRef.current) {
        applyDashboard(data);
      }
      liveStatusErrorStreakRef.current = 0;
      if (data.currentError) {
        const nowMs = Date.now();
        const next = [...liveStatusErrorTimesRef.current, nowMs].filter(
          (ts) => nowMs - ts <= LIVE_STATUS_BURST_WINDOW_MS,
        );
        liveStatusErrorTimesRef.current = next;
        if (next.length >= LIVE_STATUS_BURST_THRESHOLD) {
          liveStatusNextFetchAtRef.current = nowMs + LIVE_STATUS_BURST_COOLDOWN_MS;
          liveStatusErrorTimesRef.current = [];
        }
      } else {
        liveStatusErrorTimesRef.current = [];
      }
    } catch {
      // ignore transient polling failures
      liveStatusErrorStreakRef.current += 1;
      const nowMs = Date.now();
      const next = [...liveStatusErrorTimesRef.current, nowMs].filter(
        (ts) => nowMs - ts <= LIVE_STATUS_BURST_WINDOW_MS,
      );
      liveStatusErrorTimesRef.current = next;
      const retryDelay = Math.min(
        LIVE_STATUS_ERROR_RETRY_MS * Math.pow(2, Math.max(0, liveStatusErrorStreakRef.current - 1)),
        LIVE_STATUS_ERROR_RETRY_MAX_MS,
      );
      const burstCooldown =
        next.length >= LIVE_STATUS_BURST_THRESHOLD ? LIVE_STATUS_BURST_COOLDOWN_MS : 0;
      liveStatusNextFetchAtRef.current = nowMs + Math.max(retryDelay, burstCooldown);
      if (burstCooldown > 0) {
        liveStatusErrorTimesRef.current = [];
      }
    } finally {
      liveStatusPollingRef.current = false;
    }
  }, [applyDashboard]);

  useEffect(() => {
    if (initialLoading) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshCurrentDashboardSilent();
    }, LIVE_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [initialLoading, refreshCurrentDashboardSilent]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    blockingRef.current = blockingMessage;
  }, [blockingMessage]);

  useEffect(() => {
    try {
      window.localStorage.setItem(APP_MODE_STORAGE_KEY, activeAppMode);
    } catch {
      // ignore storage write failures
    }
  }, [activeAppMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(ACTIVE_PROFILE_BY_MODE_STORAGE_KEY, JSON.stringify(activeProfileByMode));
    } catch {
      // ignore storage write failures
    }
  }, [activeProfileByMode]);

  const filteredProfiles = useMemo(
    () => displayProfiles.filter((profile) => supportsAppMode(profile.support, activeAppMode)),
    [activeAppMode, displayProfiles],
  );

  const modeActiveProfileName = useMemo(() => {
    const preferred = activeProfileByMode[activeAppMode];
    if (preferred && filteredProfiles.some((profile) => profile.name === preferred)) {
      return preferred;
    }
    if (dashboard?.activeProfile && filteredProfiles.some((profile) => profile.name === dashboard.activeProfile)) {
      return dashboard.activeProfile;
    }
    return filteredProfiles[0]?.name ?? null;
  }, [activeAppMode, activeProfileByMode, dashboard?.activeProfile, filteredProfiles]);

  const modeActiveProfile = useMemo(
    () => filteredProfiles.find((profile) => profile.name === modeActiveProfileName) ?? null,
    [filteredProfiles, modeActiveProfileName],
  );

  useEffect(() => {
    if (!modeActiveProfileName) {
      return;
    }
    setActiveProfileByMode((prev) =>
      prev[activeAppMode] === modeActiveProfileName ? prev : { ...prev, [activeAppMode]: modeActiveProfileName },
    );
  }, [activeAppMode, modeActiveProfileName]);

  const currentProfileName = useMemo(
    () => (dashboard ? findProfileNameForCurrent(dashboard) : null),
    [dashboard],
  );

  const getProfileCheckedAtForDisplay = useCallback(
    (profile: ProfileView): string | null | undefined => {
      const raw = profile.lastCheckedAt;
      if (!raw || !dashboard?.current || !currentProfileName || profile.name !== currentProfileName) {
        return raw;
      }
      const baseMs = parseCheckedAtToMs(raw);
      if (!baseMs) {
        return raw;
      }
      const nowMs = Date.now();
      if (nowMs - baseMs > LIVE_STATUS_DISPLAY_STALE_MS) {
        return raw;
      }
      return formatLocalDateTimeFromMs(Math.max(baseMs, nowMs));
    },
    [currentProfileName, dashboard?.current],
  );

  useEffect(() => {
    setSelected((prev) => {
      if (prev && filteredProfiles.some((p) => p.name === prev)) {
        return prev;
      }
      if (modeActiveProfileName && filteredProfiles.some((p) => p.name === modeActiveProfileName)) {
        return modeActiveProfileName;
      }
      return filteredProfiles[0]?.name ?? null;
    });
  }, [filteredProfiles, modeActiveProfileName]);

  const selectedProfile = useMemo(
    () => filteredProfiles.find((p) => p.name === selected) ?? null,
    [filteredProfiles, selected],
  );

  const profileNoMap = useMemo(() => {
    const map = new Map<string, number>();
    filteredProfiles.forEach((p, i) => {
      map.set(p.name, i + 1);
    });
    return map;
  }, [filteredProfiles]);

  const profileLabel = useCallback(
    (name: string) => {
      const no = profileNoMap.get(name);
      const p = filteredProfiles.find((item) => item.name === name) ?? displayProfiles.find((item) => item.name === name);
      const title = p?.displayWorkspace || name;
      return no ? `#${no} ${title}` : title;
    },
    [displayProfiles, filteredProfiles, profileNoMap],
  );

  const currentErrorText = useMemo(
    () => formatCurrentErrorWithProfile(dashboard, dashboard?.currentError),
    [dashboard],
  );
  const uiBusy = busy && !initialLoading;

  const currentLine = useMemo(() => {
    const modeLabel = activeAppMode === "gpt" ? "GPT" : "OpenCode";
    if (initialLoading) {
      return `当前${modeLabel}账号: 账号加载中...`;
    }
    if (!modeActiveProfile) {
      return `当前${modeLabel}账号: 未选择`;
    }
    const email = modeActiveProfile.email || "-";
    return `当前${modeLabel}账号: ${email} | 工作空间 ${modeActiveProfile.displayWorkspace} | 5 小时剩余 ${pct(
      modeActiveProfile.fiveHourRemainingPercent,
    )} | 1 周剩余 ${pct(modeActiveProfile.oneWeekRemainingPercent)}`;
  }, [activeAppMode, initialLoading, modeActiveProfile]);

  const hookListenerBadge = useMemo(() => {
    if (vscodeStatus === null || hookInstalled === null) {
      return { level: "unknown", text: "检测中" };
    }
    if (!vscodeStatus.running) {
      return { level: "warn", text: "未监听（VS Code 未运行）" };
    }
    if (hookInstalled) {
      return { level: "ok", text: "监听中" };
    }
    return { level: "warn", text: "未监听（Hook 未注入/版本过旧）" };
  }, [hookInstalled, vscodeStatus]);

  const opencodeListenerBadge = useMemo(() => {
    if (!opencodeMonitorStatus) {
      return { level: "unknown", text: "检测中" };
    }
    if (!opencodeMonitorStatus.authReady) {
      return { level: "warn", text: "未监听（未登录）" };
    }
    if (opencodeMonitorStatus.activityRecent) {
      return { level: "ok", text: "监听中" };
    }
    if (!opencodeMonitorStatus.logReady && opencodeMonitorStatus.lastActivityAgeMs == null) {
      return { level: "warn", text: "未监听（未发现运行数据）" };
    }
    const ageSec = Math.max(
      0,
      Math.floor(
        (typeof opencodeMonitorStatus.lastActivityAgeMs === "number"
          ? opencodeMonitorStatus.lastActivityAgeMs
          : typeof opencodeMonitorStatus.lastLogAgeMs === "number"
            ? opencodeMonitorStatus.lastLogAgeMs
            : 0) / 1000,
      ),
    );
    return { level: "unknown", text: `空闲待命（${ageSec}s 无活动）` };
  }, [opencodeMonitorStatus]);

  const runDashboardCommand = useCallback(
    async (
      command: string,
      args: Record<string, unknown>,
      successText: string,
      beforeText?: string,
      options?: { quotaQuerying?: boolean },
    ): Promise<boolean> => {
      const isQuotaQuerying = options?.quotaQuerying === true;
      if (isQuotaQuerying) {
        setQuotaQuerying(true);
      }
      setBusy(true);
      if (beforeText) {
        setStatusText(beforeText);
      }
      try {
        const data = await invoke<DashboardData>(command, args);
        applyDashboard(data, successText);
        return true;
      } catch (err) {
        setStatusText(`${successText}失败: ${String(err)}`);
        return false;
      } finally {
        setBusy(false);
        if (isQuotaQuerying) {
          setQuotaQuerying(false);
        }
      }
    },
    [applyDashboard],
  );

  const requireSelectedName = useCallback(() => {
    if (!selectedProfile) {
      setStatusText("请先选择一个账号。");
      return null;
    }
    return selectedProfile.name;
  }, [selectedProfile]);

  const onAddByLogin = async () => {
    setBusy(true);
    setBlockingMessage("正在打开登录窗口...");
    let unlisten: (() => void) | null = null;
    let finalLoginNotice: string | null = null;
    try {
      unlisten = await listen<LoginProgressPayload>(
        "codex-switch://login-progress",
        (event) => {
          const phase = event.payload?.phase?.trim();
          const msg = event.payload?.message?.trim();
          if (msg) {
            if (phase === "done") {
              finalLoginNotice = msg;
            }
            setBlockingMessage(msg);
            setStatusText(msg);
          }
        },
      );
      const data = await invoke<DashboardData>("add_account_by_login", {});
      applyDashboard(data, finalLoginNotice ?? "添加账号完成");
      const matched = findProfileNameForCurrent(data) ?? data.activeProfile ?? null;
      if (
        matched &&
        data.profiles.some((profile) => profile.name === matched && supportsAppMode(profile.support, activeAppMode))
      ) {
        setActiveProfileByMode((prev) =>
          prev[activeAppMode] === matched ? prev : { ...prev, [activeAppMode]: matched },
        );
      }
    } catch (err) {
      setStatusText(`添加账号失败: ${String(err)}`);
    } finally {
      if (unlisten) {
        unlisten();
      }
      setBlockingMessage(null);
      setBusy(false);
    }
  };

  const onApplySelected = async (name?: string) => {
    const target = name ?? requireSelectedName();
    if (!target) {
      return;
    }
    const label = profileLabel(target);
    const ok = await runDashboardCommand(
      "apply_profile",
      { name: target, mode: activeAppMode },
      `已切换到账号: ${label}`,
      `正在切换账号: ${label}...`,
    );
    if (ok) {
      setActiveProfileByMode((prev) =>
        prev[activeAppMode] === target ? prev : { ...prev, [activeAppMode]: target },
      );
    }
  };

  const onSetAlias = async (name?: string) => {
    const target = name ?? requireSelectedName();
    if (!target) {
      return;
    }
    const label = profileLabel(target);
    const currentAlias = dashboard?.profiles.find((p) => p.name === target)?.workspaceAlias || "";
    const aliasInput = window.prompt("输入工作空间别名（留空清除）：", currentAlias);
    if (aliasInput === null) {
      return;
    }
    await runDashboardCommand(
      "set_workspace_alias",
      { name: target, alias: aliasInput.trim() || null },
      aliasInput.trim() ? `已更新工作空间别名: ${label}` : `已清除工作空间别名: ${label}`,
    );
  };

  const onRefreshSelectedQuota = async (name?: string, refreshToken = false) => {
    const target = name ?? requireSelectedName();
    if (!target) {
      return;
    }
    const label = profileLabel(target);
    await runDashboardCommand(
      "refresh_profile_quota",
      { name: target, refreshToken },
      `已刷新额度: ${label}`,
      `正在刷新额度: ${label}...`,
      { quotaQuerying: true },
    );
  };

  const onRefreshAllQuota = useCallback(
    async (refreshToken = false) => {
      await runDashboardCommand(
        "refresh_all_quota",
        { refreshToken },
        "已刷新全部账号额度",
        "正在刷新全部账号额度...",
        { quotaQuerying: true },
      );
    },
    [runDashboardCommand],
  );

  useEffect(() => {
    if (initialLoading || startupQuotaRefreshDoneRef.current) {
      return;
    }
    startupQuotaRefreshDoneRef.current = true;
    if (autoRefreshOnStartup) {
      void onRefreshAllQuota(false);
    }
  }, [autoRefreshOnStartup, initialLoading, onRefreshAllQuota]);

  const onDeleteSelected = async (name?: string) => {
    const target = name ?? requireSelectedName();
    if (!target) {
      return;
    }
    const label = profileLabel(target);
    if (!window.confirm(`确定删除账号配置 "${label}" 吗？`)) {
      return;
    }
    const ok = await runDashboardCommand("delete_profile", { name: target }, `已删除账号: ${label}`);
    if (ok) {
      setActiveProfileByMode((prev) => ({
        gpt: prev.gpt === target ? null : prev.gpt,
        opencode: prev.opencode === target ? null : prev.opencode,
      }));
    }
  };

  const refreshVsCodeStatus = useCallback(async (silent = false) => {
    try {
      const status = await invoke<VsCodeStatusView>("get_vscode_status");
      setVsCodeStatus((prev) => {
        if (prev && prev.running === status.running && prev.processCount === status.processCount) {
          return prev;
        }
        return status;
      });
      if (!silent && !status.running) {
        setStatusText("未检测到 VS Code 正在运行，请先启动 VS Code。");
      }
      return status;
    } catch (err) {
      if (!silent) {
        setStatusText(`检测 VS Code 状态失败: ${String(err)}`);
      }
      return null;
    }
  }, []);

  const refreshOpenCodeMonitorStatus = useCallback(async (silent = false) => {
    try {
      const status = await invoke<OpenCodeMonitorStatusView>("get_opencode_monitor_status");
      setOpenCodeMonitorStatus((prev) => {
        if (
          prev &&
          prev.authReady === status.authReady &&
          prev.logReady === status.logReady &&
          prev.logRecent === status.logRecent &&
          (prev.lastLogAgeMs ?? null) === (status.lastLogAgeMs ?? null) &&
          prev.activityRecent === status.activityRecent &&
          (prev.lastActivityAgeMs ?? null) === (status.lastActivityAgeMs ?? null) &&
          (prev.activitySource ?? null) === (status.activitySource ?? null)
        ) {
          return prev;
        }
        return status;
      });
      if (!silent && !status.authReady) {
        setStatusText("OpenCode 未登录，监听未激活。");
      }
      return status;
    } catch (err) {
      if (!silent) {
        setStatusText(`检测 OpenCode 监听状态失败: ${String(err)}`);
      }
      return null;
    }
  }, []);

  const refreshCodexExtensionInfo = useCallback(
    async (silent = false) => {
      try {
        const info = await invoke<CodexExtensionInfoView>("get_codex_extension_info");
        setCodexExtInfo((prev) => {
          if (
            prev &&
            prev.currentVersion === info.currentVersion &&
            stringArrayEqual(prev.allVersions, info.allVersions)
          ) {
            return prev;
          }
          return info;
        });
        if (!silent && !info.currentVersion) {
          setStatusText("未检测到官方 Codex 扩展版本信息。");
        }
        return info;
      } catch (err) {
        if (!silent) {
          setStatusText(`检测 Codex 扩展版本失败: ${String(err)}`);
        }
        return null;
      }
    },
    [],
  );

  const onReloadVsCode = async () => {
    setBusy(true);
    setStatusText("正在请求 VS Code 重载窗口...");
    try {
      const status = await refreshVsCodeStatus(true);
      if (!status?.running) {
        setStatusText("未检测到 VS Code 正在运行，请先启动 VS Code。");
        return;
      }
      const result = await invoke<string>("reload_vscode_window");
      setStatusText(result);
    } catch (err) {
      setStatusText(`重载失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const refreshHookStatus = useCallback(
    async (silent = false) => {
      try {
        const installed = await invoke<boolean>("is_codex_hook_installed");
        setHookInstalled((prev) => (prev === installed ? prev : installed));
        if (!silent && postSwitchStrategy === "hook" && !installed) {
          setStatusText("检测到方案2 Hook 提速版未注入，可在设置中心一键注入。");
        }
        return installed;
      } catch (err) {
        setHookInstalled(null);
        if (!silent) {
          setStatusText(`检测 Hook 状态失败: ${String(err)}`);
        }
        return null;
      }
    },
    [postSwitchStrategy],
  );

  const onInstallCodexHook = async () => {
    setBusy(true);
    setStatusText("正在安装/更新方案2 Hook 提速版...");
    try {
      const status = await refreshVsCodeStatus(true);
      if (!status?.running) {
        setStatusText("未检测到 VS Code 正在运行，无法注入 Hook。请先启动 VS Code。");
        return;
      }
      const result = await invoke<string>("install_codex_hook");
      await refreshHookStatus(true);
      const info = await refreshCodexExtensionInfo(true);
      if (info?.currentVersion) {
        setHookVersionSnapshot(info.currentVersion);
      }
      setStatusText(result);
    } catch (err) {
      setStatusText(`安装 Hook 失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const runPostSwitchStrategy = useCallback(
    async (strategy: PostSwitchStrategy, fromAutoSwitch: boolean) => {
      const effectiveStrategy: PostSwitchStrategy =
        fromAutoSwitch && strategy === "restart_extension_host" ? "hook" : strategy;
      const result = await invoke<string>("run_post_switch_action", { strategy: effectiveStrategy });
      if (!fromAutoSwitch) {
        setStatusText(result);
      }
      return result;
    },
    [],
  );

  const onRunPostSwitchStrategy = async (strategy: PostSwitchStrategy) => {
    setBusy(true);
    setStatusText(
      strategy === "hook"
        ? "正在执行方案2（Hook 提速重启 Extension Host）..."
        : "正在执行方案1（重启 Extension Host）...",
    );
    try {
      const status = await refreshVsCodeStatus(true);
      if (!status?.running) {
        setStatusText("未检测到 VS Code 正在运行，请先启动后再执行该策略。");
        return;
      }
      if (strategy === "hook") {
        const installed = await refreshHookStatus(true);
        if (installed === false) {
          setStatusText(
            "方案2 Hook 提速版未注入或版本过旧，请先点击“一键注入并启用方案2提速版”或“安装/更新方案2 Hook 提速版”。",
          );
          return;
        }
      }
      await runPostSwitchStrategy(strategy, false);
    } catch (err) {
      setStatusText(`执行策略失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onInjectHookOneClick = async () => {
    setBusy(true);
    setStatusText("正在一键注入 Hook 提速版并启用方案2...");
    try {
      const status = await refreshVsCodeStatus(true);
      if (!status?.running) {
        setStatusText("未检测到 VS Code 正在运行。请先启动 VS Code，再执行一键注入。");
        return;
      }
      const installMsg = await invoke<string>("install_codex_hook");
      await refreshHookStatus(true);
      const info = await refreshCodexExtensionInfo(true);
      if (info?.currentVersion) {
        setHookVersionSnapshot(info.currentVersion);
      }
      const restartMsg = await invoke<string>("run_post_switch_action", { strategy: "restart_extension_host" });
      setPostSwitchStrategy("hook");
      setStatusText(
        `${installMsg} ${restartMsg} 已切换为方案2（Hook 提速版）。${
          info?.currentVersion ? `已记录扩展版本 ${info.currentVersion}。` : ""
        }`,
      );
    } catch (err) {
      setStatusText(`一键注入失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onExportDataBackup = async () => {
    let outputDir: string | null = null;
    try {
      const selected = await open({
        title: "选择备份导出目录",
        directory: true,
        multiple: false,
      });
      if (!selected) {
        return;
      }
      outputDir = Array.isArray(selected) ? selected[0] ?? null : selected;
      if (!outputDir) {
        return;
      }
    } catch (err) {
      setStatusText(`选择导出目录失败: ${String(err)}`);
      return;
    }

    setBusy(true);
    setStatusText("正在导出数据备份...");
    try {
      const result = await invoke<BackupExportResult>("export_data_backup", { outputDir });
      setStatusText(`备份已导出：${result.archivePath}`);
      window.alert(
        `备份导出完成。\n\n文件：${result.archivePath}\n条目数：${result.fileCount}\n估算大小：${result.estimatedTotalBytes} 字节`,
      );
    } catch (err) {
      setStatusText(`导出备份失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onImportDataBackupClick = () => {
    if (uiBusy) {
      return;
    }
    importBackupInputRef.current?.click();
  };

  const onImportDataBackupFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) {
      return;
    }
    if (!window.confirm("导入恢复会覆盖当前账号列表和已保存快照，恢复前会自动创建一份安全备份。\n\n确定继续吗？")) {
      return;
    }

    setBusy(true);
    setStatusText("正在导入备份并恢复数据...");
    try {
      const archiveBase64 = await fileToBase64(file);
      const result = await invoke<BackupImportResult>("import_data_backup_base64", {
        fileName: file.name,
        archiveBase64,
      });
      applyDashboard(result.dashboard, `备份恢复完成：已恢复 ${result.restoredCount} 个文件`);
      window.alert(
        `备份恢复完成。\n\n来源文件：${result.sourceFileName}\n已恢复条目：${result.restoredCount}\n恢复前备份：${result.safeguardArchivePath}`,
      );
    } catch (err) {
      setStatusText(`导入备份失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const flushSortPersist = useCallback(async () => {
    if (sortSavingRef.current) {
      return;
    }
    const names = pendingSortNamesRef.current;
    if (!names) {
      return;
    }
    pendingSortNamesRef.current = null;
    sortSavingRef.current = true;
    setStatusText("正在保存排序...");
    try {
      const data = await invoke<DashboardData>("reorder_profiles", { names });
      if (!pendingSortNamesRef.current) {
        applyDashboard(data, "排序已保存");
      } else {
        setStatusText("排序已保存，正在同步最新顺序...");
      }
    } catch (err) {
      setStatusText(`保存排序失败: ${String(err)}`);
      void loadDashboard(false, "已回读排序");
    } finally {
      sortSavingRef.current = false;
      if (pendingSortNamesRef.current) {
        void flushSortPersist();
      }
    }
  }, [applyDashboard, loadDashboard]);

  const queuePersistOrder = useCallback(
    (names: string[]) => {
      pendingSortNamesRef.current = [...names];
      void flushSortPersist();
    },
    [flushSortPersist],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const profileIds = useMemo(() => filteredProfiles.map((p) => p.name), [filteredProfiles]);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!filteredProfiles.length) {
        return;
      }

      if (!over) {
        return;
      }

      const oldIndex = filteredProfiles.findIndex((p) => p.name === String(active.id));
      const newIndex = filteredProfiles.findIndex((p) => p.name === String(over.id));
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
        return;
      }

      const reorderedFiltered = arrayMove(filteredProfiles, oldIndex, newIndex);
      const reorderedFilteredMap = new Map(reorderedFiltered.map((p) => [p.name, p]));
      const reorderedFilteredNames = reorderedFiltered.map((p) => p.name);
      let filteredCursor = 0;
      const reorderedAll = displayProfiles.map((profile) => {
        if (!supportsAppMode(profile.support, activeAppMode)) {
          return profile;
        }
        const name = reorderedFilteredNames[filteredCursor];
        filteredCursor += 1;
        if (!name) {
          return profile;
        }
        return reorderedFilteredMap.get(name) ?? profile;
      });
      setDisplayProfiles(reorderedAll);
      queuePersistOrder(reorderedAll.map((p) => p.name));
    },
    [activeAppMode, displayProfiles, filteredProfiles, queuePersistOrder],
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_SEAMLESS_STORAGE_KEY, autoSeamlessSwitch ? "1" : "0");
    } catch {
      // ignore storage write failures
    }
  }, [autoSeamlessSwitch]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_REFRESH_ON_STARTUP_STORAGE_KEY, autoRefreshOnStartup ? "1" : "0");
    } catch {
      // ignore storage write failures
    }
  }, [autoRefreshOnStartup]);

  useEffect(() => {
    try {
      window.localStorage.setItem(POST_SWITCH_STRATEGY_STORAGE_KEY, postSwitchStrategy);
    } catch {
      // ignore storage write failures
    }
  }, [postSwitchStrategy]);

  useEffect(() => {
    try {
      if (hookVersionSnapshot) {
        window.localStorage.setItem(HOOK_VERSION_SNAPSHOT_STORAGE_KEY, hookVersionSnapshot);
      } else {
        window.localStorage.removeItem(HOOK_VERSION_SNAPSHOT_STORAGE_KEY);
      }
    } catch {
      // ignore storage write failures
    }
  }, [hookVersionSnapshot]);

  useEffect(() => {
    void refreshVsCodeStatus(true);
  }, [refreshVsCodeStatus]);

  useEffect(() => {
    void refreshCodexExtensionInfo(true);
  }, [refreshCodexExtensionInfo]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    void refreshVsCodeStatus(true);
    void refreshCodexExtensionInfo(true);
    const timer = window.setInterval(() => {
      void refreshVsCodeStatus(true);
      void refreshCodexExtensionInfo(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [settingsOpen, refreshVsCodeStatus, refreshCodexExtensionInfo]);

  useEffect(() => {
    if (hookInstalled !== true && !hookVersionSnapshot) {
      return;
    }

    let cancelled = false;
    const pollAndAutoUpgrade = async () => {
      if (cancelled || autoHookUpgradeRunningRef.current) {
        return;
      }

      const info = await refreshCodexExtensionInfo(true);
      if (cancelled || !info?.currentVersion) {
        return;
      }

      const currentVersion = info.currentVersion;
      if (hookInstalled !== true) {
        return;
      }

      if (!hookVersionSnapshot) {
        setHookVersionSnapshot(currentVersion);
        return;
      }

      if (hookVersionSnapshot === currentVersion) {
        return;
      }

      if (busyRef.current || Boolean(blockingRef.current)) {
        return;
      }

      autoHookUpgradeRunningRef.current = true;
      setBusy(true);
      const previousVersion = hookVersionSnapshot;
      try {
        const result = await invoke<string>("install_codex_hook");
        await refreshHookStatus(true);
        const latestInfo = await refreshCodexExtensionInfo(true);
        const savedVersion = latestInfo?.currentVersion || currentVersion;
        setHookVersionSnapshot(savedVersion);
        if (!cancelled) {
          setStatusText(
            `检测到 Codex 扩展版本更新（${previousVersion} -> ${currentVersion}），已自动执行“安装/更新方案2 Hook 提速版”。${result}`,
          );
        }
      } catch (err) {
        if (!cancelled) {
          setStatusText(
            `检测到 Codex 扩展版本更新（${previousVersion} -> ${currentVersion}），自动更新 Hook 失败: ${String(err)}`,
          );
        }
      } finally {
        autoHookUpgradeRunningRef.current = false;
        setBusy(false);
      }
    };

    void pollAndAutoUpgrade();
    const timer = window.setInterval(() => {
      void pollAndAutoUpgrade();
    }, AUTO_HOOK_VERSION_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hookInstalled, hookVersionSnapshot, refreshCodexExtensionInfo, refreshHookStatus]);

  useEffect(() => {
    void refreshHookStatus(true);
  }, [refreshHookStatus]);

  useEffect(() => {
    let cancelled = false;
    const pollOpenCodeListener = async () => {
      const status = await refreshOpenCodeMonitorStatus(true);
      if (cancelled || !status) {
        return;
      }
      if (activeAppMode !== "opencode") {
        return;
      }
      if (!status.authReady) {
        setStatusText("OpenCode 未登录，监听未激活。");
      }
    };

    void pollOpenCodeListener();
    const timer = window.setInterval(() => {
      void pollOpenCodeListener();
    }, HOOK_LISTEN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeAppMode, refreshOpenCodeMonitorStatus]);

  useEffect(() => {
    let cancelled = false;
    const pollHookListener = async () => {
      let status = vscodeStatus;
      const now = Date.now();
      if (!status || now - hookListenerVsCodeLastPollAtRef.current >= HOOK_LISTEN_VSCODE_POLL_MS) {
        hookListenerVsCodeLastPollAtRef.current = now;
        status = await refreshVsCodeStatus(true);
      }
      const installed = await refreshHookStatus(true);
      if (cancelled) {
        return;
      }
      const listening = Boolean(status?.running) && installed === true;
      if (listening) {
        hookListenerWarnedRef.current = false;
        return;
      }
      if (hookListenerWarnedRef.current) {
        return;
      }
      hookListenerWarnedRef.current = true;
      if (status?.running === false) {
        setStatusText(
          postSwitchStrategy === "hook"
            ? "监听异常：VS Code 未运行，方案2监听未激活。"
            : "监听未激活：VS Code 未运行。当前为方案1可继续使用；若切换到方案2请先启动 VS Code。",
        );
        return;
      }
      if (installed === false) {
        setStatusText(
          postSwitchStrategy === "hook"
            ? "监听异常：未检测到方案2 Hook 提速监听，请先安装/更新方案2 Hook 提速版。"
            : "监听未就绪：尚未注入方案2 Hook 提速版。当前为方案1可继续使用。",
        );
        return;
      }
      setStatusText(
        postSwitchStrategy === "hook"
          ? "监听状态检测失败，正在轮询重试。"
          : "监听状态暂不可用，正在轮询重试。",
      );
    };

    void pollHookListener();
    const timer = window.setInterval(() => {
      void pollHookListener();
    }, HOOK_LISTEN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [postSwitchStrategy, refreshHookStatus, refreshVsCodeStatus, vscodeStatus]);

  useEffect(() => {
    if (postSwitchStrategy !== "hook") {
      return;
    }
    void refreshHookStatus(true).then((installed) => {
      if (installed !== false) {
        return;
      }
      setStatusText("方案2 Hook 提速版尚未注入，可在设置中心点击“一键注入并启用方案2提速版”。");
    });
  }, [postSwitchStrategy, refreshHookStatus]);

  useEffect(() => {
    if (hookInstalled !== false || postSwitchStrategy !== "hook") {
      return;
    }
    setStatusText("方案2 Hook 提速版未注入或版本过旧。自动场景不会回退到方案1，请先安装/更新 Hook。");
  }, [hookInstalled, postSwitchStrategy]);

  useEffect(() => {
    seamlessEnabledRef.current = autoSeamlessSwitch;
    if (seamlessTimerRef.current) {
      window.clearTimeout(seamlessTimerRef.current);
      seamlessTimerRef.current = null;
    }

    if (!autoSeamlessSwitch) {
      seamlessRunningRef.current = false;
      void invoke<string>("auto_switch_reset").catch(() => {});
      setStatusText("无感换号已关闭。");
      return;
    }

    let cancelled = false;
    const schedule = (delayMs: number) => {
      if (!seamlessEnabledRef.current || cancelled) {
        return;
      }
      seamlessTimerRef.current = window.setTimeout(async () => {
        if (!seamlessEnabledRef.current || cancelled) {
          return;
        }
        if (busyRef.current || Boolean(blockingRef.current)) {
          schedule(AUTO_SWITCH_TICK_MS);
          return;
        }
        if (seamlessRunningRef.current) {
          schedule(AUTO_SWITCH_TICK_MS);
          return;
        }
        seamlessRunningRef.current = true;
        try {
          const result = await invoke<AutoSwitchTickResult>("auto_switch_tick", {
            mode: activeAppMode,
          });
          if (!cancelled && result.dashboard) {
            applyDashboard(result.dashboard);
          }
          if (!cancelled && result.action === "switched") {
            const switchedTo = result.switchedTo?.trim();
            if (switchedTo) {
              setActiveProfileByMode((prev) =>
                prev[activeAppMode] === switchedTo ? prev : { ...prev, [activeAppMode]: switchedTo },
              );
              setSelected(switchedTo);
            }
            const baseMessage = result.message || "已切换账号。";
            if (activeAppMode === "gpt") {
              try {
                const actionResult = await runPostSwitchStrategy(postSwitchStrategy, true);
                if (!cancelled) {
                  setStatusText(`${baseMessage} ${actionResult}`);
                }
              } catch (err) {
                if (!cancelled) {
                  const fallbackTip =
                    postSwitchStrategy === "hook"
                      ? "方案2提速失败，可在设置中心切换到方案1（直接重启 Extension Host）。"
                      : "可稍后重试该策略。";
                  setStatusText(`${baseMessage} 切后动作失败: ${String(err)}。${fallbackTip}`);
                }
              }
            } else {
              setStatusText(baseMessage);
            }
          } else if (
            !cancelled &&
            result.message &&
            !["idle", "cooldown", "no_candidate_cooldown"].includes(result.action)
          ) {
            setStatusText(result.message);
          }
        } catch (err) {
          if (!cancelled) {
            setStatusText(`无感换号检测失败: ${String(err)}`);
          }
        } finally {
          seamlessRunningRef.current = false;
        }
        if (!cancelled && seamlessEnabledRef.current) {
          schedule(AUTO_SWITCH_TICK_MS);
        }
      }, delayMs);
    };

    setStatusText("无感换号已开启（实时监控中）。");
    schedule(AUTO_SWITCH_TICK_MS);

    return () => {
      cancelled = true;
      if (seamlessTimerRef.current) {
        window.clearTimeout(seamlessTimerRef.current);
        seamlessTimerRef.current = null;
      }
      seamlessRunningRef.current = false;
      void invoke<string>("auto_switch_reset").catch(() => {});
    };
  }, [activeAppMode, autoSeamlessSwitch, applyDashboard, postSwitchStrategy, runPostSwitchStrategy]);

  useEffect(() => {
    if (!autoSeamlessSwitch) {
      if (threadRecoverTimerRef.current) {
        window.clearTimeout(threadRecoverTimerRef.current);
        threadRecoverTimerRef.current = null;
      }
      threadRecoverRunningRef.current = false;
      return;
    }

    let cancelled = false;
    const schedule = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      threadRecoverTimerRef.current = window.setTimeout(async () => {
        if (cancelled) {
          return;
        }
        if (busyRef.current || Boolean(blockingRef.current)) {
          schedule(THREAD_RECOVER_TICK_MS);
          return;
        }
        if (threadRecoverRunningRef.current) {
          schedule(THREAD_RECOVER_TICK_MS);
          return;
        }
        threadRecoverRunningRef.current = true;
        try {
          const result = await invoke<AutoSwitchTickResult>("thread_recover_tick", {
            mode: activeAppMode,
          });
          if (
            !cancelled &&
            result.message &&
            ["thread_recovered", "thread_recover_failed"].includes(result.action)
          ) {
            setStatusText(result.message);
          }
        } catch {
          // Keep silent for recovery monitor; avoid noisy transient toast.
        } finally {
          threadRecoverRunningRef.current = false;
        }
        if (!cancelled) {
          schedule(THREAD_RECOVER_TICK_MS);
        }
      }, delayMs);
    };

    schedule(THREAD_RECOVER_TICK_MS);
    return () => {
      cancelled = true;
      if (threadRecoverTimerRef.current) {
        window.clearTimeout(threadRecoverTimerRef.current);
        threadRecoverTimerRef.current = null;
      }
      threadRecoverRunningRef.current = false;
    };
  }, [activeAppMode, autoSeamlessSwitch]);

  useEffect(() => {
    autoEnabledRef.current = autoKeepalive;
    if (autoTimerRef.current) {
      window.clearTimeout(autoTimerRef.current);
      autoTimerRef.current = null;
    }

    if (!autoKeepalive) {
      setStatusText("自动保活已关闭。");
      return;
    }

    let cancelled = false;

    const runKeepalive = async (successText: string, failPrefix: string) => {
      if (autoRunningRef.current) {
        return;
      }
      autoRunningRef.current = true;
      try {
        const data = await invoke<DashboardData>("keepalive_all");
        if (!cancelled) {
          applyDashboard(data, successText);
        }
      } catch (err) {
        if (!cancelled) {
          setStatusText(`${failPrefix}: ${String(err)}`);
        }
      } finally {
        autoRunningRef.current = false;
      }
    };

    const schedule = (delayMs: number, reason: "startup" | "periodic") => {
      if (!autoEnabledRef.current || cancelled) {
        return;
      }
      autoTimerRef.current = window.setTimeout(async () => {
        if (!autoEnabledRef.current || cancelled) {
          return;
        }
        if (autoRunningRef.current) {
          schedule(AUTO_BUSY_RETRY_MS, reason);
          return;
        }
        if (reason === "startup") {
          await runKeepalive("启动保活完成（24h + 错峰）", "启动保活失败");
        } else {
          await runKeepalive("自动保活完成（48h + 错峰）", "自动保活失败");
        }

        if (autoEnabledRef.current && !cancelled) {
          schedule(nextPeriodicKeepaliveDelayMs(), "periodic");
        }
      }, delayMs);
    };

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });

    const bootstrap = async () => {
      let steps = 0;
      while (!cancelled && !dashboardRef.current && steps < DASHBOARD_WAIT_MAX_STEPS) {
        await wait(DASHBOARD_WAIT_STEP_MS);
        steps += 1;
      }
      if (cancelled || !autoEnabledRef.current) {
        return;
      }

      if (!startupKeepaliveCheckedRef.current) {
        startupKeepaliveCheckedRef.current = true;
        const lastKeepaliveAt = dashboardRef.current?.lastKeepaliveAt ?? null;
        const lastKeepaliveMs = lastKeepaliveAt ? lastKeepaliveAt * 1000 : null;
        const shouldRunStartupKeepalive =
          !lastKeepaliveMs || Date.now() - lastKeepaliveMs >= STARTUP_KEEPALIVE_THRESHOLD_MS;

        if (shouldRunStartupKeepalive) {
          const startupDelay = nextStartupStaggerDelayMs();
          const mins = Math.max(1, Math.round(startupDelay / 60_000));
          setStatusText(`满足启动保活条件（>=24h），已错峰排队，约 ${mins} 分钟后执行。`);
          schedule(startupDelay, "startup");
          return;
        }
      }

      setStatusText("自动保活已开启（按上次保活时间判断，运行中每48h错峰）。");
      schedule(nextPeriodicDelayFromLastKeepalive(dashboardRef.current?.lastKeepaliveAt), "periodic");
    };

    void bootstrap();

    return () => {
      cancelled = true;
      if (autoTimerRef.current) {
        window.clearTimeout(autoTimerRef.current);
        autoTimerRef.current = null;
      }
    };
  }, [autoKeepalive, applyDashboard]);

  return (
    <div className="app-root">
      <input
        ref={importBackupInputRef}
        type="file"
        accept=".tar,.tar.gz,.tgz,application/x-tar,application/gzip"
        style={{ display: "none" }}
        onChange={onImportDataBackupFileSelected}
      />
      {blockingMessage ? (
        <div className="blocking-overlay" role="alertdialog" aria-busy="true" aria-live="polite">
          <div className="blocking-dialog">
            <span className="blocking-spinner" aria-hidden />
            <div className="blocking-title">{blockingMessage}</div>
            <div className="blocking-tip">请等待当前流程完成，期间主窗口已锁定。</div>
          </div>
        </div>
      ) : null}
      {settingsOpen ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="VSCode Codex 设置中心" onClick={() => setSettingsOpen(false)}>
          <section className="settings-panel" onClick={(e) => e.stopPropagation()}>
            <header className="settings-header">
              <div className="settings-title">VSCode Codex 设置中心</div>
              <button className="header-icon" type="button" onClick={() => setSettingsOpen(false)} title="关闭设置">
                ✕
              </button>
            </header>
            <div className="settings-body">
              <section className="settings-group">
                <div className="settings-group-title">VSCode Codex 切号后动作策略</div>
                <label className={`strategy-item ${postSwitchStrategy === "restart_extension_host" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="postSwitchStrategy"
                    value="restart_extension_host"
                    checked={postSwitchStrategy === "restart_extension_host"}
                    onChange={() => setPostSwitchStrategy("restart_extension_host")}
                    disabled={uiBusy}
                  />
                  <div className="strategy-main">
                    <div className="strategy-title">方案1：重启 Extension Host（更稳）</div>
                    <div className="strategy-desc">
                      面向 VSCode Codex：不重载整个窗口，仅重启扩展宿主。作为兜底策略最稳。
                    </div>
                  </div>
                </label>
                <label className={`strategy-item ${postSwitchStrategy === "hook" ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="postSwitchStrategy"
                    value="hook"
                    checked={postSwitchStrategy === "hook"}
                    onChange={() => setPostSwitchStrategy("hook")}
                    disabled={uiBusy || hookInstalled !== true}
                  />
                  <div className="strategy-main">
                    <div className="strategy-title">方案2：Hook 提速版（方案1语义）</div>
                    <div className="strategy-desc">
                      面向 VSCode Codex：通过 Hook 触发 Extension Host 重启，保留方案1的会话兼容性，并减少切后等待时间。
                    </div>
                  </div>
                </label>
                <div className={`runtime-alert ${vscodeStatus?.running && hookInstalled !== false ? "ok" : "warn"}`}>
                  <div className="runtime-alert-text">
                    <div className="runtime-status-line">
                      <span className="runtime-status-label">VSCode Codex 状态:</span>
                      <span
                        className={`runtime-status-badge ${
                          vscodeStatus === null ? "unknown" : vscodeStatus.running ? "ok" : "warn"
                        }`}
                      >
                        {vscodeStatus === null
                          ? "未检测"
                          : vscodeStatus.running
                            ? `运行中（进程 ${vscodeStatus.processCount}）`
                            : "未启动"}
                      </span>
                    </div>
                    <div className="runtime-status-line">
                      <span className="runtime-status-label">Codex Hook 状态:</span>
                      <span
                        className={`runtime-status-badge ${
                          hookInstalled === null ? "unknown" : hookInstalled ? "ok" : "warn"
                        }`}
                      >
                        {hookInstalled === null
                          ? "未检测"
                          : hookInstalled
                            ? "已注入"
                            : "未注入（方案2提速版暂不可用）"}
                      </span>
                    </div>
                    {vscodeStatus?.running === false ? (
                      <div className="runtime-alert-tip">VSCode Codex 未运行，无法注入 Hook。请先启动 VSCode。</div>
                    ) : null}
                  </div>
                  <div className="runtime-alert-actions">
                    <button className="settings-btn" type="button" disabled={uiBusy} onClick={() => void refreshVsCodeStatus(false)}>
                      检测 VSCode Codex
                    </button>
                    <button className="settings-btn" type="button" disabled={uiBusy} onClick={() => void refreshHookStatus(false)}>
                      检测 Codex Hook
                    </button>
                    {hookInstalled === false ? (
                      <button
                        className="settings-btn primary"
                        type="button"
                        disabled={uiBusy || vscodeStatus?.running === false}
                        onClick={() => void onInjectHookOneClick()}
                        title={vscodeStatus?.running === false ? "VSCode Codex 未运行，无法注入" : "一键注入并启用方案2提速版"}
                      >
                        一键注入并启用方案2提速版
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="strategy-desc">
                  扩展版本: {codexExtInfo?.currentVersion || "-"} | Hook 记录版本: {hookVersionSnapshot || "-"}
                </div>
              </section>

              <section className="settings-group">
                <div className="settings-group-title">手动操作</div>
                <div className="settings-actions">
                  <button
                    className="settings-btn"
                    type="button"
                    disabled={uiBusy || vscodeStatus?.running === false}
                    onClick={() => void onInstallCodexHook()}
                    title={
                      vscodeStatus?.running === false
                        ? "VSCode Codex 未运行，无法注入"
                        : "首次安装后请点一次；后续仅在 VSCode Codex 扩展更新或 Hook 未注入/版本过旧时再点"
                    }
                  >
                    安装/更新方案2 Hook 提速版
                  </button>
                  <button
                    className="settings-btn"
                    type="button"
                    disabled={uiBusy || vscodeStatus?.running === false}
                    onClick={() => void onRunPostSwitchStrategy(postSwitchStrategy)}
                  >
                    测试当前策略
                  </button>
                  <button
                    className="settings-btn"
                    type="button"
                    disabled={uiBusy || vscodeStatus?.running === false}
                    onClick={() => void onRunPostSwitchStrategy("restart_extension_host")}
                  >
                    手动执行方案1
                  </button>
                  <button
                    className="settings-btn"
                    type="button"
                    disabled={uiBusy || vscodeStatus?.running === false || hookInstalled !== true}
                    onClick={() => void onRunPostSwitchStrategy("hook")}
                  >
                    手动执行方案2
                  </button>
                  <button className="settings-btn" type="button" disabled={uiBusy} onClick={() => void onExportDataBackup()}>
                    导出备份
                  </button>
                  <button className="settings-btn" type="button" disabled={uiBusy} onClick={onImportDataBackupClick}>
                    导入恢复
                  </button>
                </div>
                <div className="strategy-desc">
                  提示：首次安装后请点一次“安装/更新方案2 Hook 提速版”；之后仅在 Codex 扩展版本更新，或 Hook
                  状态显示“未注入/版本过旧”时再点一次。
                </div>
              </section>
            </div>
          </section>
        </div>
      ) : null}
      {activeToolView === "dashboard" ? (
      <header className="top-bar">
        <div className="top-left">
          <img className="brand-logo" src={openaiLogo} alt="" aria-hidden />
          <div className="brand">Codex Switch</div>
          <button
            className="header-icon"
            disabled={uiBusy}
            onClick={() => void onRefreshAllQuota(false)}
            title={quotaQuerying ? "配额查询中..." : "刷新全部额度"}
            aria-label={quotaQuerying ? "配额查询中" : "刷新全部额度"}
          >
            <span className={quotaQuerying ? "icon-spin" : undefined} aria-hidden>
              ↻
            </span>
          </button>
        </div>
        <div className="top-center">
          <div className="app-switcher" role="tablist" aria-label="应用切换">
            <button
              type="button"
              role="tab"
              aria-selected={activeAppMode === "gpt"}
              className={`app-switch-btn ${activeAppMode === "gpt" ? "active" : ""}`}
              onClick={() => switchAppMode("gpt")}
              disabled={uiBusy}
            >
              <img className="app-switch-icon" src={vscodeLogo} alt="" aria-hidden />
              <span>VSCode</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeAppMode === "opencode"}
              className={`app-switch-btn ${activeAppMode === "opencode" ? "active" : ""}`}
              onClick={() => switchAppMode("opencode")}
              disabled={uiBusy}
            >
              <img className="app-switch-icon" src={opencodeLogo} alt="" aria-hidden />
              <span>OpenCode</span>
            </button>
          </div>
        </div>
        <div className="top-right">
          <label
            className="keepalive-switch startup-refresh-switch"
            title={autoRefreshOnStartup ? "启动时自动刷新配额已开启" : "启动时自动刷新配额已关闭"}
          >
            <span className={`startup-refresh-icon ${autoRefreshOnStartup ? "active" : ""}`} aria-hidden>
              ↻
            </span>
            <input
              type="checkbox"
              checked={autoRefreshOnStartup}
              onChange={(e) => setAutoRefreshOnStartup(e.target.checked)}
              disabled={uiBusy}
              aria-label="启动自动刷新全部配额"
            />
            <span className="switch-track">
              <span className="switch-knob" />
            </span>
          </label>
          <label
            className="keepalive-switch seamless-switch"
            title={autoSeamlessSwitch ? "无感换号已开启（实时监控）" : "无感换号已关闭"}
          >
            <span className={`seamless-icon ${autoSeamlessSwitch ? "active" : ""}`} aria-hidden>
              <svg
                className="seamless-icon-glyph"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M16 3H21V8" />
                <path d="M4 20L21 3" />
                <path d="M21 16V21H16" />
                <path d="M15 15L21 21" />
                <path d="M4 4L9 9" />
              </svg>
            </span>
            <input
              type="checkbox"
              checked={autoSeamlessSwitch}
              onChange={(e) => setAutoSeamlessSwitch(e.target.checked)}
              disabled={uiBusy}
              aria-label="自动无感换号"
            />
            <span className="switch-track">
              <span className="switch-knob" />
            </span>
          </label>
          <label
            className="keepalive-switch"
            title={autoKeepalive ? "自动保活已开启（48h + 错峰）" : "自动保活已关闭"}
          >
            <span className={`keepalive-icon ${autoKeepalive ? "active" : ""}`} aria-hidden>
              <span className="dot" />
              <span className="ring ring-1" />
              <span className="ring ring-2" />
            </span>
            <input
              type="checkbox"
              checked={autoKeepalive}
              onChange={(e) => setAutoKeepalive(e.target.checked)}
              disabled={uiBusy}
              aria-label="自动保活(48h)"
            />
            <span className="switch-track">
              <span className="switch-knob" />
            </span>
          </label>
          <div className="top-tool-group" role="group" aria-label="工具面板切换">
            <button
              type="button"
              className="top-tool-btn"
              onClick={() => setActiveToolView("skills")}
              title="Skills 管理"
              aria-label="Skills 管理"
            >
              <Wrench className="tool-icon-lucide" />
            </button>
            <button
              type="button"
              className="top-tool-btn"
              onClick={() => setActiveToolView("prompts")}
              title="Prompts 面板"
              aria-label="Prompts 面板"
            >
              <Book className="tool-icon-lucide" />
            </button>
            <button
              type="button"
              className="top-tool-btn"
              onClick={() => setActiveToolView("mcp")}
              title="MCP 服务器管理"
              aria-label="MCP 服务器管理"
            >
              <McpIcon className="tool-icon-lucide" size={16} />
            </button>
          </div>
          <button className="header-icon" disabled={uiBusy} onClick={() => setSettingsOpen(true)} title="设置中心">
            ⚙
          </button>
          <button
            className="header-icon"
            disabled={uiBusy || vscodeStatus?.running === false}
            onClick={() => void onReloadVsCode()}
            title={vscodeStatus?.running === false ? "未检测到 VS Code 运行" : "刷新 VS Code"}
          >
            ◫
          </button>
          <button
            className="add-btn"
            disabled={uiBusy}
            onClick={() => void onAddByLogin()}
            title="添加账号"
            aria-label="添加账号"
          />
        </div>
      </header>
      ) : null}

      {activeToolView === "dashboard" ? (
        <>
          <section className="summary">{currentLine}</section>
          {quotaQuerying ? (
            <section className="quota-querying" aria-live="polite">
              <span className="status-spinner" aria-hidden />
              <span>配额查询中...</span>
            </section>
          ) : null}
          {!initialLoading && currentErrorText ? (
            <div className="error-banner">当前账号读取失败: {currentErrorText}</div>
          ) : null}

          <main className="cards-wrap">
            {initialLoading ? (
              <div className="loading-panel">
                <span className="loading-spinner" aria-hidden />
                <span className="loading-text">账号加载中...</span>
              </div>
            ) : filteredProfiles.length ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(event) => void onDragEnd(event)}
              >
                <SortableContext items={profileIds} strategy={verticalListSortingStrategy}>
                  <div className="cards-list">
                    {filteredProfiles.map((p, idx) => (
                      <SortableProfileCard
                        key={p.name}
                        profile={p}
                        index={idx}
                        selected={selected === p.name}
                        isModeActive={modeActiveProfileName === p.name}
                        busy={uiBusy}
                        checkedAtOverride={getProfileCheckedAtForDisplay(p)}
                        onSelect={setSelected}
                        onRefreshQuota={(name) => void onRefreshSelectedQuota(name, false)}
                        onApply={(name) => void onApplySelected(name)}
                        onSetAlias={(name) => void onSetAlias(name)}
                        onDelete={(name) => void onDeleteSelected(name)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            ) : (
              <div className="empty">
                当前{activeAppMode === "gpt" ? "GPT" : "OpenCode"}分组暂无账号。点击右上角 + 添加账号（内嵌登录）。
              </div>
            )}
          </main>
        </>
      ) : activeToolView === "skills" ? (
        <main className="tools-pane-wrap tools-pane-wrap-sticky-head">
          <div className="tools-pane-sticky-head">
            <section className="skills-page-header">
              <div className="skills-page-left">
                <button
                  type="button"
                  className="skills-back-btn"
                  onClick={() => setActiveToolView("dashboard")}
                  title="返回账号列表"
                  aria-label="返回账号列表"
                >
                  <ArrowLeft className="skills-back-icon" />
                </button>
                <h1 className="skills-inline-title">Skills 管理</h1>
              </div>
              <div className="skills-page-actions">
                <button
                  type="button"
                  className="skills-head-action"
                  disabled={skillsLoading || skillsRefreshing}
                  onClick={() => void onRefreshSkillsCatalog()}
                  title={skillsRefreshing ? "Skills 刷新中..." : "刷新 Skills"}
                  aria-label={skillsRefreshing ? "Skills 刷新中" : "刷新 Skills"}
                >
                  <RefreshCw className={`skills-head-action-icon ${skillsRefreshing ? "icon-spin" : ""}`} />
                  {skillsRefreshing ? "刷新中..." : "刷新"}
                </button>
                <button type="button" className="skills-head-action" onClick={() => void onSkillsInstallFromZip()}>
                  <FileArchive className="skills-head-action-icon" />
                  从 ZIP 安装
                </button>
                <button type="button" className="skills-head-action" onClick={() => void onSkillsImportExisting()}>
                  <Download className="skills-head-action-icon" />
                  导入已有
                </button>
                <button type="button" className="skills-head-action" onClick={() => void onSkillsDiscover()}>
                  <Search className="skills-head-action-icon" />
                  发现技能
                </button>
              </div>
            </section>

            <section className="skills-inline-summary">{skillsSummaryText}</section>
          </div>

          {skillsError ? <section className="skills-inline-error">{skillsError}</section> : null}

          {skillsLoading ? (
            <section className="skills-inline-empty">正在读取本地 Skills...</section>
          ) : skillsCatalog && skillsCatalog.skills.length === 0 ? (
            <section className="skills-inline-empty">
              未找到 Skills，请检查 `~/.cc-switch/skills`、`~/.codex/skills`、`~/.config/opencode/skills`。
            </section>
          ) : (
            <section className="skills-inline-list">
              {skillsCatalog?.skills.map((skill) => {
                const busy = !!skillsBusyIds[skill.id];
                const codexAvailable = skill.codexAvailable;
                const opencodeAvailable = skill.opencodeAvailable;
                return (
                  <article key={skill.id} className="skills-inline-item">
                    <div className="skills-inline-main">
                      <h2>{skill.name}</h2>
                      <p>{skill.description}</p>
                      <div className="skills-inline-meta">
                        <span className="skills-inline-pill">本地</span>
                        <span className="skills-inline-pill">{skill.source}</span>
                      </div>
                      <div className="skills-inline-path" title={skill.locations.join("\n")}>
                        {skill.locations.join(" | ")}
                      </div>
                    </div>
                    <div className="skills-inline-targets">
                      <SkillTargetSwitch
                        label="Codex"
                        icon={openaiLogo}
                        checked={skill.codexEnabled}
                        busy={busy || !codexAvailable}
                        onClick={() => void onToggleSkillTarget(skill, "codex")}
                      />
                      <SkillTargetSwitch
                        label="OpenCode"
                        icon={opencodeLogo}
                        checked={skill.opencodeEnabled}
                        busy={busy || !opencodeAvailable}
                        onClick={() => void onToggleSkillTarget(skill, "opencode")}
                      />
                      <button
                        type="button"
                        className="skill-delete-btn"
                        disabled={busy}
                        onClick={() => void onDeleteSkill(skill)}
                        title="删除该技能"
                      >
                        <Trash2 className="skill-delete-btn-icon" />
                        删除
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>
          )}
        </main>
      ) : activeToolView === "skillsDiscovery" ? (
        <main className="tools-pane-wrap">
          <section className="skills-page-header">
            <div className="skills-page-left">
              <button
                type="button"
                className="skills-back-btn"
                onClick={() => setActiveToolView("skills")}
                title="返回 Skills 管理"
                aria-label="返回 Skills 管理"
              >
                <ArrowLeft className="skills-back-icon" />
              </button>
              <h1 className="skills-inline-title">Skills 发现</h1>
            </div>
            <div className="skills-page-actions">
              <button
                type="button"
                className="skills-head-action"
                disabled={skillsDiscoveryRefreshing}
                onClick={() => void loadSkillsDiscovery(false, true)}
              >
                <RefreshCw className="skills-head-action-icon" />
                刷新
              </button>
              <button type="button" className="skills-head-action" onClick={() => void onOpenSkillReposManage()}>
                <Settings className="skills-head-action-icon" />
                仓库管理
              </button>
            </div>
          </section>

          <section className="skills-inline-summary">{skillsDiscoverySummaryText}</section>

          <section className="skills-discovery-toolbar">
            <label className="skills-discovery-search">
              <Search className="skills-discovery-search-icon" />
              <input
                type="text"
                value={skillsDiscoveryKeyword}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSkillsDiscoveryKeyword(event.target.value)}
                placeholder="搜索技能名称或描述..."
              />
            </label>
            <label className="skills-discovery-filter">
              <div className="skills-discovery-select-wrap">
                <select
                  value={skillsDiscoveryInstallFilter}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    setSkillsDiscoveryInstallFilter(event.target.value as "all" | "installed" | "notInstalled")
                  }
                >
                  <option value="all">全部</option>
                  <option value="installed">已安装</option>
                  <option value="notInstalled">未安装</option>
                </select>
                <ChevronDown className="skills-discovery-select-icon" />
              </div>
            </label>
          </section>

          {skillsDiscoveryError ? <section className="skills-inline-error">{skillsDiscoveryError}</section> : null}

          {skillsDiscoveryLoading ? (
            <section className="skills-inline-empty">正在读取发现技能...</section>
          ) : skillsDiscoverySyncingEmpty ? (
            <section className="skills-inline-empty skills-inline-loading">
              <span className="status-spinner" aria-hidden />
              <span>正在同步发现技能，请稍候...</span>
            </section>
          ) : filteredDiscoverySkills.length === 0 ? (
            <section className="skills-inline-empty">当前筛选条件下没有可展示的技能。</section>
          ) : (
            <section className="skills-discovery-grid">
              {filteredDiscoverySkills.map((skill) => (
                <article key={skill.id} className="skills-discovery-card">
                  <div className="skills-discovery-card-main">
                    <h2>{skill.name}</h2>
                    <span className="skills-discovery-repo-pill">
                      {skill.repoOwner}/{skill.repoName}
                    </span>
                    <p>{skill.description}</p>
                  </div>
                  <div className="skills-discovery-card-actions">
                    <button
                      type="button"
                      className="skills-discovery-btn ghost"
                      onClick={() => void onOpenDiscoverSkillReadme(skill)}
                    >
                      <ExternalLink className="skills-discovery-btn-icon" />
                      查看
                    </button>
                    <button
                      type="button"
                      className="skills-discovery-btn install"
                      disabled={skill.installed || !!skillsDiscoveryInstallingIds[skill.id]}
                      onClick={() => void onInstallDiscoverySkill(skill)}
                      title={skill.installed ? "已安装" : "安装到 Codex/OpenCode 并同步到 CC 数据库"}
                    >
                      <Download className="skills-discovery-btn-icon" />
                      {skillsDiscoveryInstallingIds[skill.id]
                        ? "安装中..."
                        : skill.installed
                          ? "已安装"
                          : "安装"}
                    </button>
                  </div>
                </article>
              ))}
            </section>
          )}
        </main>
      ) : activeToolView === "skillsRepos" ? (
        <main className="tools-pane-wrap">
          <section className="skills-page-header">
            <div className="skills-page-left">
              <button
                type="button"
                className="skills-back-btn"
                onClick={() => setActiveToolView("skillsDiscovery")}
                title="返回 Skills 发现"
                aria-label="返回 Skills 发现"
              >
                <ArrowLeft className="skills-back-icon" />
              </button>
              <h1 className="skills-inline-title">管理技能仓库</h1>
            </div>
            <div className="skills-page-actions">
              <button
                type="button"
                className="skills-head-action"
                disabled={skillReposManageRefreshing}
                onClick={() => void loadSkillReposManage(false, true)}
              >
                <RefreshCw className="skills-head-action-icon" />
                刷新
              </button>
            </div>
          </section>

          <section className="skill-repo-form-panel">
            <h2>添加技能仓库</h2>
            <label className="skill-repo-form-label">
              <span>仓库 URL</span>
              <input
                type="text"
                value={skillRepoInput}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSkillRepoInput(event.target.value)}
                placeholder="owner/name 或 https://github.com/owner/name"
              />
            </label>
            <label className="skill-repo-form-label">
              <span>分支</span>
              <input
                type="text"
                value={skillRepoBranch}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setSkillRepoBranch(event.target.value)}
                placeholder="main"
              />
            </label>
            <button
              type="button"
              className="skill-repo-add-btn"
              disabled={!!skillRepoActionBusyKeys.__add__}
              onClick={() => void onAddSkillRepo()}
            >
              <Plus className="skill-repo-add-icon" />
              添加仓库
            </button>
          </section>

          {skillReposManageError ? <section className="skills-inline-error">{skillReposManageError}</section> : null}

          <section className="skill-repo-list-panel">
            <h2>已添加的仓库</h2>
            {skillReposManageLoading ? (
              <section className="skills-inline-empty">正在读取仓库...</section>
            ) : skillReposSyncingEmpty ? (
              <section className="skills-inline-empty skills-inline-loading">
                <span className="status-spinner" aria-hidden />
                <span>正在同步仓库信息，请稍候...</span>
              </section>
            ) : !skillReposManage?.repos.length ? (
              <section className="skills-inline-empty">暂无仓库，先在上方添加一个。</section>
            ) : (
              <div className="skill-repo-list">
                {skillReposManage.repos.map((repo) => {
                  const rowKey = `${repo.owner}/${repo.name}`;
                  const busy = !!skillRepoActionBusyKeys[rowKey];
                  return (
                    <article key={rowKey} className="skill-repo-item">
                      <div className="skill-repo-item-main">
                        <div className="skill-repo-item-title">{rowKey}</div>
                        <div className="skill-repo-item-meta">
                          <span className="skill-repo-meta-branch">分支: {repo.branch}</span>
                          {repo.skillCount !== undefined && repo.skillCount !== null ? (
                            <span className="skill-repo-meta-count-chip">识别到 {repo.skillCount} 个技能</span>
                          ) : null}
                        </div>
                      </div>
                      <div className="skill-repo-item-actions">
                        <button
                          type="button"
                          className="skill-repo-item-btn"
                          disabled={busy}
                          onClick={() => void onOpenRepoHome(repo)}
                          title="打开仓库"
                        >
                          <ExternalLink className="skill-repo-item-btn-icon" />
                        </button>
                        <button
                          type="button"
                          className="skill-repo-item-btn danger"
                          disabled={busy}
                          onClick={() => void onRemoveSkillRepo(repo)}
                          title="删除仓库"
                        >
                          <Trash2 className="skill-repo-item-btn-icon" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </main>
      ) : activeToolView === "mcp" ? (
        <main className="tools-pane-wrap tools-pane-wrap-sticky-head">
          <div className="tools-pane-sticky-head">
            <section className="skills-page-header">
              <div className="skills-page-left">
                <button
                  type="button"
                  className="skills-back-btn"
                  onClick={() => setActiveToolView("dashboard")}
                  title="返回账号列表"
                  aria-label="返回账号列表"
                >
                  <ArrowLeft className="skills-back-icon" />
                </button>
                <h1 className="skills-inline-title">MCP 服务器管理</h1>
              </div>
              <div className="skills-page-actions">
                <button
                  type="button"
                  className="skills-head-action"
                  disabled={mcpManageLoading || mcpManageRefreshing}
                  onClick={() => void onRefreshMcpManage()}
                  title={mcpManageRefreshing ? "MCP 刷新中..." : "刷新 MCP"}
                  aria-label={mcpManageRefreshing ? "MCP 刷新中" : "刷新 MCP"}
                >
                  <RefreshCw className={`skills-head-action-icon ${mcpManageRefreshing ? "icon-spin" : ""}`} />
                  {mcpManageRefreshing ? "刷新中..." : "刷新"}
                </button>
                <button
                  type="button"
                  className="skills-head-action"
                  disabled={mcpManageRefreshing}
                  onClick={() => void onImportExistingMcp()}
                >
                  <Download className="skills-head-action-icon" />
                  导入已有
                </button>
                <button
                  type="button"
                  className="skills-head-action"
                  disabled={mcpManageRefreshing}
                  onClick={() => openMcpAddPage()}
                >
                  <Plus className="skills-head-action-icon" />
                  新增MCP
                </button>
              </div>
            </section>

            <section className="skills-inline-summary">{mcpSummaryText}</section>
          </div>

          {mcpManageError ? <section className="skills-inline-error">{mcpManageError}</section> : null}

          {mcpManageLoading ? (
            <section className="skills-inline-empty">正在读取 MCP 服务器...</section>
          ) : mcpSyncingEmpty ? (
            <section className="skills-inline-empty skills-inline-loading">
              <span className="status-spinner" aria-hidden />
              <span>正在同步 MCP 配置，请稍候...</span>
            </section>
          ) : !mcpManage?.servers.length ? (
            <section className="skills-inline-empty mcp-inline-empty">
              <span className="mcp-empty-icon-wrap">
                <Server className="mcp-empty-icon" />
              </span>
              <span className="mcp-empty-title">暂无服务器</span>
              <span className="mcp-empty-text">点击右上角按钮添加第一个 MCP 服务器</span>
            </section>
          ) : (
            <section className="skills-inline-list">
              {mcpManage.servers.map((server) => {
                const busy = !!mcpBusyIds[server.id];
                const hasDocLink = !!server.docUrl;
                return (
                  <article key={server.id} className="skills-inline-item">
                    <div className="skills-inline-main">
                      <h2>{server.name || server.id}</h2>
                      <p>{server.description}</p>
                      <div className="skills-inline-meta">
                        <span className="skills-inline-pill">{server.kind ? server.kind.toUpperCase() : "MCP"}</span>
                        <span className="skills-inline-pill">{server.source}</span>
                        {hasDocLink ? (
                          <button
                            type="button"
                            className="skills-inline-link-btn"
                            onClick={() => onOpenMcpDoc(server)}
                            title={server.docUrl || server.endpointUrl || ""}
                          >
                            <ExternalLink className="skills-inline-link-icon" />
                            文档
                          </button>
                        ) : null}
                      </div>
                      <div className="skills-inline-path" title={server.id}>
                        {server.id}
                      </div>
                    </div>
                    <div className="skills-inline-targets">
                      <SkillTargetSwitch
                        label="Codex"
                        icon={openaiLogo}
                        checked={server.codexEnabled}
                        busy={busy || !server.codexAvailable}
                        onClick={() => void onToggleMcpTarget(server, "codex")}
                      />
                      <SkillTargetSwitch
                        label="OpenCode"
                        icon={opencodeLogo}
                        checked={server.opencodeEnabled}
                        busy={busy || !server.opencodeAvailable}
                        onClick={() => void onToggleMcpTarget(server, "opencode")}
                      />
                      <button
                        type="button"
                        className="skill-delete-btn"
                        disabled={busy}
                        onClick={() => void onRemoveMcpServer(server)}
                        title="删除该 MCP 服务器"
                      >
                        <Trash2 className="skill-delete-btn-icon" />
                        删除
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>
          )}
        </main>
      ) : activeToolView === "mcpAdd" ? (
        <main className="tools-pane-wrap tools-pane-wrap-sticky-head mcp-create-view">
          <div className="tools-pane-sticky-head">
            <section className="skills-page-header">
              <div className="skills-page-left">
                <button
                  type="button"
                  className="skills-back-btn"
                  onClick={() => closeMcpAddPage()}
                  title="返回 MCP 管理"
                  aria-label="返回 MCP 管理"
                >
                  <ArrowLeft className="skills-back-icon" />
                </button>
                <h1 className="skills-inline-title">新增 MCP</h1>
              </div>
            </section>
          </div>

          <section className="skill-repo-form-panel mcp-create-card">
            <h2>选择 MCP 类型</h2>
            <div className="mcp-type-chip-row">
              <button
                type="button"
                className={`mcp-type-chip ${mcpSelectedPreset === "custom" ? "active" : ""}`}
                onClick={() => applyMcpPreset("custom")}
              >
                自定义
              </button>
              {MCP_PRESET_OPTIONS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`mcp-type-chip ${mcpSelectedPreset === preset.id ? "active" : ""}`}
                  onClick={() => applyMcpPreset(preset.id)}
                >
                  {preset.id}
                </button>
              ))}
            </div>

            <label className="skill-repo-form-label">
              <span>
                MCP 标题（唯一）
                <em className="mcp-required-mark">*</em>
              </span>
              <input
                type="text"
                value={mcpFormId}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormId(event.target.value)}
                placeholder="my-mcp-server"
              />
            </label>

            <label className="skill-repo-form-label">
              <span>显示名称</span>
              <input
                type="text"
                value={mcpFormName}
                onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormName(event.target.value)}
                placeholder="例如 @modelcontextprotocol/server-time"
              />
            </label>

            <div className="mcp-create-subtitle">启用到应用</div>
            <div className="mcp-form-targets">
              <label className="mcp-form-target">
                <input
                  type="checkbox"
                  checked={mcpFormClaudeEnabled}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormClaudeEnabled(event.target.checked)}
                />
                <span>Claude</span>
              </label>
              <label className="mcp-form-target">
                <input
                  type="checkbox"
                  checked={mcpFormCodexEnabled}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormCodexEnabled(event.target.checked)}
                />
                <img src={openaiLogo} alt="" aria-hidden className="skill-target-icon" />
                <span>Codex</span>
              </label>
              <label className="mcp-form-target">
                <input
                  type="checkbox"
                  checked={mcpFormGeminiEnabled}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormGeminiEnabled(event.target.checked)}
                />
                <span>Gemini</span>
              </label>
              <label className="mcp-form-target">
                <input
                  type="checkbox"
                  checked={mcpFormOpencodeEnabled}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormOpencodeEnabled(event.target.checked)}
                />
                <img src={opencodeLogo} alt="" aria-hidden className="skill-target-icon" />
                <span>OpenCode</span>
              </label>
            </div>

            <button
              type="button"
              className="mcp-metadata-toggle"
              onClick={() => setMcpShowMetadata((prev) => !prev)}
            >
              {mcpShowMetadata ? <ChevronUp className="mcp-metadata-icon" /> : <ChevronDown className="mcp-metadata-icon" />}
              附加信息
            </button>

            {mcpShowMetadata ? (
              <div className="mcp-metadata-fields">
                <label className="skill-repo-form-label">
                  <span>描述</span>
                  <input
                    type="text"
                    value={mcpFormDescription}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormDescription(event.target.value)}
                    placeholder="可选的描述信息"
                  />
                </label>
                <label className="skill-repo-form-label">
                  <span>标签（逗号分隔）</span>
                  <input
                    type="text"
                    value={mcpFormTags}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormTags(event.target.value)}
                    placeholder="stdio, time, utility"
                  />
                </label>
                <label className="skill-repo-form-label">
                  <span>主页链接</span>
                  <input
                    type="text"
                    value={mcpFormHomepage}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormHomepage(event.target.value)}
                    placeholder="https://example.com"
                  />
                </label>
                <label className="skill-repo-form-label">
                  <span>文档链接</span>
                  <input
                    type="text"
                    value={mcpFormDocs}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => setMcpFormDocs(event.target.value)}
                    placeholder="https://example.com/docs"
                  />
                </label>
              </div>
            ) : null}

            {mcpFormError ? <div className="mcp-form-error">{mcpFormError}</div> : null}
          </section>

          <section className="skill-repo-form-panel mcp-create-card">
            <div className="mcp-json-header">
              <h2>完整的 JSON 配置</h2>
              <div className="mcp-json-actions">
                <button
                  type="button"
                  className="mcp-json-guide-btn"
                  onClick={() => setStatusText("当前已使用表单自动生成 JSON 配置。")}
                >
                  配置向导
                </button>
                <button
                  type="button"
                  className="skill-repo-add-btn mcp-inline-add-btn"
                  disabled={!!mcpBusyIds.__add__}
                  onClick={() => void onSubmitMcpAdd()}
                >
                  <Plus className="skill-repo-add-icon" />
                  {mcpBusyIds.__add__ ? "添加中..." : "添加"}
                </button>
              </div>
            </div>
            <textarea
              className="mcp-json-editor"
              value={mcpFormConfig}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setMcpFormConfig(event.target.value)}
              spellCheck={false}
              rows={6}
              placeholder={MCP_CONFIG_PLACEHOLDER}
            />
            <button type="button" className="mcp-json-format-btn" onClick={onFormatMcpConfig}>
              <Wrench className="mcp-json-format-icon" />
              格式化
            </button>
          </section>
        </main>
      ) : (
        <main className="tools-pane-wrap">
          <section className="tools-view-header">
            <div className="tools-view-left">
              <button
                type="button"
                className="skills-back-btn"
                onClick={() => setActiveToolView("dashboard")}
                title="返回账号列表"
                aria-label="返回账号列表"
              >
                <ArrowLeft className="skills-back-icon" />
              </button>
              <h1 className="skills-inline-title">Prompts 面板</h1>
            </div>
          </section>
          <section className="tools-placeholder-panel">
            <h2>Prompts</h2>
            <p>按钮已接入为 CC Switch 同款三按钮结构。Prompts 内容后续可继续扩展。</p>
          </section>
        </main>
      )}

      <footer className="status-bar">
        <span className="status-listener-group">
          <span className="status-listener">
            <span className="status-listener-label">GPT:</span>
            <span className={`runtime-status-badge ${hookListenerBadge.level}`}>{hookListenerBadge.text}</span>
          </span>
          <span className="status-listener">
            <span className="status-listener-label">OpenCode:</span>
            <span className={`runtime-status-badge ${opencodeListenerBadge.level}`}>{opencodeListenerBadge.text}</span>
          </span>
        </span>
        <span className="status-main">
          {quotaQuerying ? (
            <span className="status-inline">
              <span className="status-spinner" aria-hidden />
              <span>配额查询中...</span>
            </span>
          ) : uiBusy ? (
            `处理中... ${statusText}`
          ) : (
            statusText
          )}
        </span>
      </footer>
    </div>
  );
}

export default App;
