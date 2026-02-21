export type SettingsEditorTarget = "vscode" | "kiro";

export type MaybeNum = number | null | undefined;

export interface ProfileSupportView {
  gpt: boolean;
  opencode: boolean;
}

export interface CurrentStatusView {
  email?: string | null;
  workspaceName?: string | null;
  workspaceId?: string | null;
  displayWorkspace: string;
  fiveHourRemainingPercent?: number | null;
  fiveHourResetsAt?: number | null;
  oneWeekRemainingPercent?: number | null;
  oneWeekResetsAt?: number | null;
}

export interface ProfileView {
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

export interface DashboardData {
  appName: string;
  activeProfile?: string | null;
  current?: CurrentStatusView | null;
  opencodeCurrent?: CurrentStatusView | null;
  currentError?: string | null;
  currentErrorMode?: "gpt" | "opencode" | null;
  lastKeepaliveAt?: number | null;
  profiles: ProfileView[];
}

export interface ApplyDashboardOptions {
  preserveQuotaFromCurrentDashboard?: boolean;
}

export interface AutoSwitchTickResult {
  action: string;
  message?: string | null;
  switchedTo?: string | null;
  reloadTriggered: boolean;
  pendingReason?: string | null;
  dashboard?: DashboardData | null;
}

export interface VsCodeStatusView {
  running: boolean;
  processCount: number;
}

export interface OpenCodeMonitorStatusView {
  authReady: boolean;
  running: boolean;
  processCount: number;
  logReady: boolean;
  logRecent: boolean;
  lastLogAgeMs?: number | null;
  activityRecent: boolean;
  lastActivityAgeMs?: number | null;
  activitySource?: string | null;
}

export interface CodexExtensionInfoView {
  currentVersion?: string | null;
  allVersions: string[];
}

export interface LoginProgressPayload {
  phase: string;
  message: string;
}

export interface AppServerLogPayload {
  message?: string;
  ts?: string;
}

export interface BackupExportResult {
  archivePath: string;
  fileCount: number;
  estimatedTotalBytes: number;
}

export interface BackupImportResult {
  sourceFileName: string;
  safeguardArchivePath: string;
  restoredCount: number;
  dashboard: DashboardData;
}

export interface SkillEntryView {
  id: string;
  directory: string;
  name: string;
  description: string;
  claudeEnabled: boolean;
  codexEnabled: boolean;
  geminiEnabled: boolean;
  opencodeEnabled: boolean;
  codexAvailable: boolean;
  opencodeAvailable: boolean;
  source: string;
  locations: string[];
}

export interface SkillsCatalogView {
  total: number;
  claudeEnabledCount: number;
  codexEnabledCount: number;
  geminiEnabledCount: number;
  opencodeEnabledCount: number;
  skills: SkillEntryView[];
}

export interface DiscoverSkillRepoView {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
}

export interface DiscoverSkillEntryView {
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

export interface SkillsDiscoveryView {
  total: number;
  repos: DiscoverSkillRepoView[];
  skills: DiscoverSkillEntryView[];
}

export interface SkillRepoManageItemView {
  owner: string;
  name: string;
  branch: string;
  enabled: boolean;
  skillCount?: number | null;
  repoUrl: string;
}

export interface SkillRepoManageView {
  repos: SkillRepoManageItemView[];
}

export interface McpServerView {
  id: string;
  name: string;
  description: string;
  docUrl?: string | null;
  endpointUrl?: string | null;
  source: string;
  kind: string;
  claudeEnabled: boolean;
  codexEnabled: boolean;
  geminiEnabled: boolean;
  opencodeEnabled: boolean;
  codexAvailable: boolean;
  opencodeAvailable: boolean;
}

export interface McpManageView {
  total: number;
  claudeEnabledCount: number;
  codexEnabledCount: number;
  geminiEnabledCount: number;
  opencodeEnabledCount: number;
  servers: McpServerView[];
}

export interface McpPresetOption {
  id: string;
  name: string;
  description: string;
  tags: string[];
  homepage: string;
  docs: string;
  spec: Record<string, unknown>;
}

export type PostSwitchStrategy = "hook" | "restart_extension_host";
export type AppMode = "gpt" | "opencode";
export type ActiveProfileByMode = Record<AppMode, string | null>;
export type WindowCloseAction = "ask" | "exit" | "background";
export type SkillTarget = "claude" | "codex" | "gemini" | "opencode";
export type McpTarget = "claude" | "codex" | "gemini" | "opencode";
export type ToolView = "dashboard" | "skills" | "skillsDiscovery" | "skillsRepos" | "prompts" | "mcp" | "mcpAdd";

export interface SortableProfileCardProps {
  profile: ProfileView;
  index: number;
  selected: boolean;
  isModeActive: boolean;
  busy: boolean;
  showLiveQuerying?: boolean;
  isQuotaRefreshing?: boolean;
  liveQueryError?: string | null;
  onSelect: (name: string) => void;
  onRefreshQuota: (name: string) => void;
  onApply: (name: string) => void;
  onSetAlias: (name: string) => void;
  onDelete: (name: string) => void;
}

export interface SkillTargetSwitchProps {
  label: string;
  icon?: string;
  checked: boolean;
  busy: boolean;
  onClick: () => void;
}
