import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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

type PostSwitchStrategy = "hook" | "restart_extension_host";
type AppMode = "gpt" | "opencode";
type ActiveProfileByMode = Record<AppMode, string | null>;

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
