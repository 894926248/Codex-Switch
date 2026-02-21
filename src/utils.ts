import {
  ACTIVE_PROFILE_BY_MODE_STORAGE_KEY,
  APP_MODE_STORAGE_KEY,
  AUTO_KEEPALIVE_BASE_MS,
  AUTO_KEEPALIVE_JITTER_MS,
  POST_SWITCH_STRATEGY_STORAGE_KEY,
  STARTUP_STAGGER_MAX_MS,
  STARTUP_STAGGER_MIN_MS,
  WINDOW_CLOSE_ACTION_STORAGE_KEY,
} from "./constants";
import type {
  ActiveProfileByMode,
  AppMode,
  CurrentStatusView,
  DashboardData,
  MaybeNum,
  McpManageView,
  PostSwitchStrategy,
  ProfileSupportView,
  ProfileView,
  SkillsCatalogView,
  WindowCloseAction,
} from "./types";

export function formatCurrentErrorWithProfile(
  data: Pick<DashboardData, "activeProfile" | "profiles"> | null,
  raw?: string | null,
): string | null {
  if (!raw) {
    return null;
  }
  const compacted = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = compacted.length > 260 ? `${compacted.slice(0, 260)}...` : compacted;
  if (!data?.activeProfile) {
    return normalized;
  }
  const idx = data.profiles.findIndex((p) => p.name === data.activeProfile);
  if (idx < 0) {
    return normalized;
  }
  const profile = data.profiles[idx];
  return `账号 #${idx + 1} (${profile.displayWorkspace}): ${normalized}`;
}

export function readBoolStorage(key: string, fallback: boolean): boolean {
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

export function readPostSwitchStrategyStorage(fallback: PostSwitchStrategy): PostSwitchStrategy {
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

export function readWindowCloseActionStorage(fallback: WindowCloseAction): WindowCloseAction {
  try {
    const raw = window.localStorage.getItem(WINDOW_CLOSE_ACTION_STORAGE_KEY);
    if (raw === "ask" || raw === "exit" || raw === "background") {
      return raw;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function readStringStorage(key: string): string | null {
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

export function readAppModeStorage(fallback: AppMode): AppMode {
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

export function readActiveProfileByModeStorage(): ActiveProfileByMode {
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

export function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return task;
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`${label}超时（>${Math.floor(timeoutMs / 1000)}秒）`));
    }, timeoutMs);
    task.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function fileToBase64(file: File): Promise<string> {
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

export function nextPeriodicKeepaliveDelayMs() {
  const jitter = Math.floor((Math.random() * 2 - 1) * AUTO_KEEPALIVE_JITTER_MS);
  return AUTO_KEEPALIVE_BASE_MS + jitter;
}

export function nextStartupStaggerDelayMs() {
  return STARTUP_STAGGER_MIN_MS + Math.floor(Math.random() * (STARTUP_STAGGER_MAX_MS - STARTUP_STAGGER_MIN_MS + 1));
}

export function nextPeriodicDelayFromLastKeepalive(lastKeepaliveAt?: number | null) {
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

export function formatReset(ts: MaybeNum, mode: "time" | "dateTime" = "dateTime"): string {
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

export function formatCheckedAt(value?: string | null): string {
  if (!value) {
    return "-";
  }
  const text = value.trim();
  if (!text) {
    return "-";
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (m) {
    const ss = m[6] || "00";
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${ss}`;
  }
  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) {
    return formatLocalDateTimeFromMs(d.getTime());
  }
  return text.replace("T", " ").replace("Z", "");
}

export function pct(v: MaybeNum): string {
  if (v === undefined || v === null) {
    return "-";
  }
  return `${v}%`;
}

export function statusClass(text: string): string {
  if (text.includes("受限") || text.includes("无权限")) {
    return "warn";
  }
  return text.includes("失效") ? "bad" : "good";
}

export function stripCurrentActiveSuffix(status: string): string {
  return status.replace(/\(当前生效\)$/u, "");
}

export function quotaClass(v: MaybeNum): string {
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

export function supportBadgeText(support?: ProfileSupportView | null): string {
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

export function supportBadgeClass(support?: ProfileSupportView | null): string {
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

export function supportsAppMode(support: ProfileSupportView | null | undefined, mode: AppMode): boolean {
  const gpt = support?.gpt ?? true;
  const opencode = support?.opencode ?? false;
  return mode === "gpt" ? gpt : opencode;
}

export function formatLocalDateTimeFromMs(ms: number): string {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

export function normalizeIdentityValue(value?: string | null): string | null {
  const text = (value || "").trim().toLowerCase();
  return text || null;
}

export function dashboardCurrentByMode(data: DashboardData | null | undefined, mode: AppMode): CurrentStatusView | null {
  if (!data) {
    return null;
  }
  if (mode === "opencode") {
    return data.opencodeCurrent ?? data.current ?? null;
  }
  return data.current ?? null;
}

export function findProfileNameForCurrent(
  data: DashboardData,
  current?: CurrentStatusView | null,
  fallbackProfileName?: string | null,
): string | null {
  const targetCurrent = current ?? data.current ?? null;
  if (!targetCurrent) {
    return fallbackProfileName ?? data.activeProfile ?? null;
  }
  const currentWorkspace = normalizeIdentityValue(targetCurrent.workspaceId);
  const currentWorkspaceName = normalizeIdentityValue(targetCurrent.workspaceName ?? targetCurrent.displayWorkspace);
  const currentEmail = normalizeIdentityValue(targetCurrent.email);

  let exactMatch: string | null = null;
  let exactCount = 0;
  let workspaceMatch: string | null = null;
  let workspaceCount = 0;
  let workspaceNameMatch: string | null = null;
  let workspaceNameCount = 0;
  let workspaceNameEmailMatch: string | null = null;
  let workspaceNameEmailCount = 0;
  let emailMatch: string | null = null;
  let emailCount = 0;

  for (const profile of data.profiles) {
    const profileWorkspace = normalizeIdentityValue(profile.workspaceId);
    const profileWorkspaceName = normalizeIdentityValue(profile.workspaceName ?? profile.displayWorkspace);
    const profileEmail = normalizeIdentityValue(profile.email);

    if (currentWorkspace && profileWorkspace === currentWorkspace) {
      workspaceCount += 1;
      workspaceMatch = profile.name;
    }
    if (currentWorkspaceName && profileWorkspaceName === currentWorkspaceName) {
      workspaceNameCount += 1;
      workspaceNameMatch = profile.name;
    }
    if (currentEmail && profileEmail === currentEmail) {
      emailCount += 1;
      emailMatch = profile.name;
    }
    if (currentWorkspaceName && currentEmail && profileWorkspaceName === currentWorkspaceName && profileEmail === currentEmail) {
      workspaceNameEmailCount += 1;
      workspaceNameEmailMatch = profile.name;
    }
    if (currentWorkspace && currentEmail && profileWorkspace === currentWorkspace && profileEmail === currentEmail) {
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
  if (currentWorkspaceName && currentEmail && workspaceNameEmailCount === 1 && workspaceNameEmailMatch) {
    return workspaceNameEmailMatch;
  }
  if (currentWorkspaceName && workspaceNameCount === 1 && workspaceNameMatch) {
    return workspaceNameMatch;
  }
  if (currentEmail && emailCount === 1 && emailMatch) {
    return emailMatch;
  }
  return fallbackProfileName ?? data.activeProfile ?? null;
}

export function profileMatchesCurrentIdentity(profile: ProfileView, current: CurrentStatusView): boolean {
  const currentWorkspace = normalizeIdentityValue(current.workspaceId);
  const currentWorkspaceName = normalizeIdentityValue(current.workspaceName ?? current.displayWorkspace);
  const currentEmail = normalizeIdentityValue(current.email);
  const profileWorkspace = normalizeIdentityValue(profile.workspaceId);
  const profileWorkspaceName = normalizeIdentityValue(profile.workspaceName ?? profile.displayWorkspace);
  const profileEmail = normalizeIdentityValue(profile.email);

  if (currentWorkspace && profileWorkspace === currentWorkspace) {
    if (!currentEmail || !profileEmail) {
      return true;
    }
    return profileEmail === currentEmail;
  }
  if (currentWorkspaceName && currentEmail && profileWorkspaceName === currentWorkspaceName && profileEmail === currentEmail) {
    return true;
  }
  return false;
}

export function buildDashboardSignature(data: DashboardData): string {
  return JSON.stringify(data);
}

export function stringArrayEqual(a: string[], b: string[]): boolean {
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

export function recomputeSkillsCatalog(catalog: SkillsCatalogView): SkillsCatalogView {
  const claudeEnabledCount = catalog.skills.filter((item) => item.claudeEnabled).length;
  const codexEnabledCount = catalog.skills.filter((item) => item.codexEnabled).length;
  const geminiEnabledCount = catalog.skills.filter((item) => item.geminiEnabled).length;
  const opencodeEnabledCount = catalog.skills.filter((item) => item.opencodeEnabled).length;
  return {
    ...catalog,
    total: catalog.skills.length,
    claudeEnabledCount,
    codexEnabledCount,
    geminiEnabledCount,
    opencodeEnabledCount,
  };
}

export function recomputeMcpManage(view: McpManageView): McpManageView {
  const claudeEnabledCount = view.servers.filter((item) => item.claudeEnabled).length;
  const codexEnabledCount = view.servers.filter((item) => item.codexEnabled).length;
  const geminiEnabledCount = view.servers.filter((item) => item.geminiEnabled).length;
  const opencodeEnabledCount = view.servers.filter((item) => item.opencodeEnabled).length;
  return {
    ...view,
    total: view.servers.length,
    claudeEnabledCount,
    codexEnabledCount,
    geminiEnabledCount,
    opencodeEnabledCount,
  };
}
