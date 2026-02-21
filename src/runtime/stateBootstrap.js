import { useRef, useState } from "react";
import {
  AUTO_REFRESH_ON_STARTUP_STORAGE_KEY,
  AUTO_SEAMLESS_STORAGE_KEY,
  HOOK_VERSION_SNAPSHOT_STORAGE_KEY,
} from "../constants";
import {
  readActiveProfileByModeStorage,
  readAppModeStorage,
  readBoolStorage,
  readPostSwitchStrategyStorage,
  readStringStorage,
  readWindowCloseActionStorage,
} from "../utils";

export function useRuntimeStateBootstrap() {
  const [dashboard, setDashboard] = useState(null);
  const [displayProfiles, setDisplayProfiles] = useState([]);
  const [selected, setSelected] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [codexExtInfo, setCodexExtInfo] = useState(null);
  const [vscodeStatus, setVsCodeStatus] = useState(null);
  const [opencodeMonitorStatus, setOpenCodeMonitorStatus] = useState(null);
  const [hookInstalled, setHookInstalled] = useState(null);
  const [hookVersionSnapshot, setHookVersionSnapshot] = useState(() => readStringStorage(HOOK_VERSION_SNAPSHOT_STORAGE_KEY));
  const [statusText, setStatusText] = useState("账号加载中...");
  const [busy, setBusy] = useState(true);
  const [quotaQuerying, setQuotaQuerying] = useState(false);
  const [refreshingProfileNames, setRefreshingProfileNames] = useState([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [autoSeamlessSwitch, setAutoSeamlessSwitch] = useState(() => readBoolStorage(AUTO_SEAMLESS_STORAGE_KEY, true));
  const [autoRefreshOnStartup, setAutoRefreshOnStartup] = useState(() => readBoolStorage(AUTO_REFRESH_ON_STARTUP_STORAGE_KEY, false));
  const [postSwitchStrategy, setPostSwitchStrategy] = useState(() => readPostSwitchStrategyStorage("restart_extension_host"));
  const [settingsEditorTarget, setSettingsEditorTarget] = useState("vscode");
  const [windowCloseAction, setWindowCloseAction] = useState(() => readWindowCloseActionStorage("ask"));
  const [closePromptOpen, setClosePromptOpen] = useState(false);
  const [closePromptRemember, setClosePromptRemember] = useState(false);
  const [autoKeepalive, setAutoKeepalive] = useState(true);
  const [blockingMessage, setBlockingMessage] = useState(null);
  const [activeAppMode, setActiveAppMode] = useState(() => readAppModeStorage("gpt"));
  const [activeProfileByMode, setActiveProfileByMode] = useState(() => readActiveProfileByModeStorage());
  const [activeToolView, setActiveToolView] = useState("dashboard");
  const [skillsCatalog, setSkillsCatalog] = useState(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsRefreshing, setSkillsRefreshing] = useState(false);
  const [skillsError, setSkillsError] = useState(null);
  const [skillsBusyIds, setSkillsBusyIds] = useState({});
  const [skillsDiscovery, setSkillsDiscovery] = useState(null);
  const [skillsDiscoveryLoading, setSkillsDiscoveryLoading] = useState(false);
  const [skillsDiscoveryRefreshing, setSkillsDiscoveryRefreshing] = useState(false);
  const [skillsDiscoveryError, setSkillsDiscoveryError] = useState(null);
  const [skillsDiscoveryKeyword, setSkillsDiscoveryKeyword] = useState("");
  const [skillsDiscoveryInstallFilter, setSkillsDiscoveryInstallFilter] = useState("all");
  const [skillsDiscoveryInstallingIds, setSkillsDiscoveryInstallingIds] = useState({});
  const [skillReposManage, setSkillReposManage] = useState(null);
  const [skillReposManageLoading, setSkillReposManageLoading] = useState(false);
  const [skillReposManageRefreshing, setSkillReposManageRefreshing] = useState(false);
  const [skillReposManageError, setSkillReposManageError] = useState(null);
  const [skillRepoInput, setSkillRepoInput] = useState("");
  const [skillRepoBranch, setSkillRepoBranch] = useState("main");
  const [skillRepoActionBusyKeys, setSkillRepoActionBusyKeys] = useState({});
  const [mcpManage, setMcpManage] = useState(null);
  const [mcpManageLoading, setMcpManageLoading] = useState(false);
  const [mcpManageRefreshing, setMcpManageRefreshing] = useState(false);
  const [mcpManageError, setMcpManageError] = useState(null);
  const [mcpBusyIds, setMcpBusyIds] = useState({});
  const [mcpFormId, setMcpFormId] = useState("");
  const [mcpFormName, setMcpFormName] = useState("");
  const [mcpFormDescription, setMcpFormDescription] = useState("");
  const [mcpFormTags, setMcpFormTags] = useState("");
  const [mcpFormHomepage, setMcpFormHomepage] = useState("");
  const [mcpFormDocs, setMcpFormDocs] = useState("");
  const [mcpFormConfig, setMcpFormConfig] = useState("");
  const [mcpSelectedPreset, setMcpSelectedPreset] = useState("custom");
  const [mcpShowMetadata, setMcpShowMetadata] = useState(false);
  const [mcpFormClaudeEnabled, setMcpFormClaudeEnabled] = useState(true);
  const [mcpFormGeminiEnabled, setMcpFormGeminiEnabled] = useState(true);
  const [mcpFormCodexEnabled, setMcpFormCodexEnabled] = useState(true);
  const [mcpFormOpencodeEnabled, setMcpFormOpencodeEnabled] = useState(true);
  const [mcpFormError, setMcpFormError] = useState(null);
  const [displayCurrentErrorText, setDisplayCurrentErrorText] = useState(null);

  const autoTimerRef = useRef(null);
  const autoRunningRef = useRef(false);
  const autoEnabledRef = useRef(true);
  const seamlessTimerRef = useRef(null);
  const seamlessRunningRef = useRef(false);
  const seamlessEnabledRef = useRef(true);
  const threadRecoverTimerRef = useRef(null);
  const threadRecoverRunningRef = useRef(false);
  const busyRef = useRef(false);
  const blockingRef = useRef(null);
  const dashboardRef = useRef(null);
  const dashboardSignatureRef = useRef("");
  const startupKeepaliveCheckedRef = useRef(false);
  const startupQuotaRefreshDoneRef = useRef(false);
  const hookListenerWarnedRef = useRef(false);
  const sortSavingRef = useRef(false);
  const pendingSortNamesRef = useRef(null);
  const autoHookUpgradeRunningRef = useRef(false);
  const importBackupInputRef = useRef(null);
  const bypassCloseInterceptRef = useRef(false);
  const liveStatusPollingRef = useRef(false);
  const liveStatusNextFetchAtRef = useRef(0);
  const liveStatusErrorStreakRef = useRef(0);
  const liveStatusErrorTimesRef = useRef([]);
  const currentErrorCandidateRef = useRef(null);
  const currentErrorCandidateSinceRef = useRef(0);
  const hookListenerVsCodeLastPollAtRef = useRef(0);
  const activeAppModeRef = useRef(activeAppMode);
  const activeProfileByModeRef = useRef(activeProfileByMode);

  return {
    activeAppMode,
    activeAppModeRef,
    activeProfileByMode,
    activeProfileByModeRef,
    activeToolView,
    autoEnabledRef,
    autoHookUpgradeRunningRef,
    autoKeepalive,
    autoRefreshOnStartup,
    autoRunningRef,
    autoSeamlessSwitch,
    autoTimerRef,
    blockingMessage,
    blockingRef,
    busy,
    busyRef,
    bypassCloseInterceptRef,
    closePromptOpen,
    closePromptRemember,
    codexExtInfo,
    currentErrorCandidateRef,
    currentErrorCandidateSinceRef,
    dashboard,
    dashboardRef,
    dashboardSignatureRef,
    displayCurrentErrorText,
    displayProfiles,
    hookInstalled,
    hookListenerVsCodeLastPollAtRef,
    hookListenerWarnedRef,
    hookVersionSnapshot,
    importBackupInputRef,
    initialLoading,
    liveStatusErrorStreakRef,
    liveStatusErrorTimesRef,
    liveStatusNextFetchAtRef,
    liveStatusPollingRef,
    mcpBusyIds,
    mcpFormClaudeEnabled,
    mcpFormCodexEnabled,
    mcpFormConfig,
    mcpFormDescription,
    mcpFormDocs,
    mcpFormError,
    mcpFormGeminiEnabled,
    mcpFormHomepage,
    mcpFormId,
    mcpFormName,
    mcpFormOpencodeEnabled,
    mcpFormTags,
    mcpManage,
    mcpManageError,
    mcpManageLoading,
    mcpManageRefreshing,
    mcpSelectedPreset,
    mcpShowMetadata,
    opencodeMonitorStatus,
    pendingSortNamesRef,
    postSwitchStrategy,
    quotaQuerying,
    refreshingProfileNames,
    seamlessEnabledRef,
    seamlessRunningRef,
    seamlessTimerRef,
    selected,
    setActiveAppMode,
    setActiveProfileByMode,
    setActiveToolView,
    setAutoKeepalive,
    setAutoRefreshOnStartup,
    setAutoSeamlessSwitch,
    setBlockingMessage,
    setBusy,
    setClosePromptOpen,
    setClosePromptRemember,
    setCodexExtInfo,
    setDashboard,
    setDisplayCurrentErrorText,
    setDisplayProfiles,
    setHookInstalled,
    setHookVersionSnapshot,
    setInitialLoading,
    setMcpBusyIds,
    setMcpFormClaudeEnabled,
    setMcpFormCodexEnabled,
    setMcpFormConfig,
    setMcpFormDescription,
    setMcpFormDocs,
    setMcpFormError,
    setMcpFormGeminiEnabled,
    setMcpFormHomepage,
    setMcpFormId,
    setMcpFormName,
    setMcpFormOpencodeEnabled,
    setMcpFormTags,
    setMcpManage,
    setMcpManageError,
    setMcpManageLoading,
    setMcpManageRefreshing,
    setMcpSelectedPreset,
    setMcpShowMetadata,
    setOpenCodeMonitorStatus,
    setPostSwitchStrategy,
    setQuotaQuerying,
    setRefreshingProfileNames,
    setSelected,
    setSettingsEditorTarget,
    setSettingsOpen,
    setSkillRepoActionBusyKeys,
    setSkillRepoBranch,
    setSkillRepoInput,
    setSkillReposManage,
    setSkillReposManageError,
    setSkillReposManageLoading,
    setSkillReposManageRefreshing,
    setSkillsBusyIds,
    setSkillsCatalog,
    setSkillsDiscovery,
    setSkillsDiscoveryError,
    setSkillsDiscoveryInstallFilter,
    setSkillsDiscoveryInstallingIds,
    setSkillsDiscoveryKeyword,
    setSkillsDiscoveryLoading,
    setSkillsDiscoveryRefreshing,
    setSkillsError,
    setSkillsLoading,
    setSkillsRefreshing,
    setStatusText,
    setVsCodeStatus,
    setWindowCloseAction,
    settingsEditorTarget,
    settingsOpen,
    skillRepoActionBusyKeys,
    skillRepoBranch,
    skillRepoInput,
    skillReposManage,
    skillReposManageError,
    skillReposManageLoading,
    skillReposManageRefreshing,
    skillsBusyIds,
    skillsCatalog,
    skillsDiscovery,
    skillsDiscoveryError,
    skillsDiscoveryInstallFilter,
    skillsDiscoveryInstallingIds,
    skillsDiscoveryKeyword,
    skillsDiscoveryLoading,
    skillsDiscoveryRefreshing,
    skillsError,
    skillsLoading,
    skillsRefreshing,
    sortSavingRef,
    startupKeepaliveCheckedRef,
    startupQuotaRefreshDoneRef,
    statusText,
    threadRecoverRunningRef,
    threadRecoverTimerRef,
    vscodeStatus,
    windowCloseAction,
  };
}
