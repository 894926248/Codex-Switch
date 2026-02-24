import { useCallback, useEffect, useMemo } from "react";
import {
  dashboardCurrentByMode,
  findProfileNameForCurrent,
  formatCurrentErrorWithProfile,
  pct,
  profileMatchesCurrentIdentity,
  supportsAppMode,
} from "../../utils";

export function useRuntimeDerivedViewState(ctx) {
  const {
    activeAppMode,
    activeProfileByMode,
    dashboard,
    displayProfiles,
    hookInstalled,
    initialLoading,
    opencodeMonitorStatus,
    refreshingProfileNames,
    selected,
    setSelected,
    vscodeStatus,
  } = ctx;

  const filteredProfiles = useMemo(
    () => displayProfiles.filter((profile) => supportsAppMode(profile.support, activeAppMode)),
    [activeAppMode, displayProfiles]
  );
  const refreshingProfileNameSet = useMemo(() => new Set(refreshingProfileNames), [refreshingProfileNames]);
  const modeActiveProfileName = useMemo(() => {
    const preferred = activeProfileByMode[activeAppMode];
    if (preferred && filteredProfiles.some((profile) => profile.name === preferred)) {
      return preferred;
    }
    if (activeAppMode !== "opencode" && dashboard?.activeProfile && filteredProfiles.some((profile) => profile.name === dashboard.activeProfile)) {
      return dashboard.activeProfile;
    }
    return filteredProfiles[0]?.name ?? null;
  }, [activeAppMode, activeProfileByMode, dashboard?.activeProfile, filteredProfiles]);
  const modeActiveProfile = useMemo(
    () => filteredProfiles.find((profile) => profile.name === modeActiveProfileName) ?? null,
    [filteredProfiles, modeActiveProfileName]
  );
  const modeCurrent = useMemo(
    () => dashboardCurrentByMode(dashboard, activeAppMode),
    [activeAppMode, dashboard]
  );
  const currentProfileName = useMemo(
    () => dashboard ? findProfileNameForCurrent(dashboard, modeCurrent, activeProfileByMode[activeAppMode]) : null,
    [activeAppMode, activeProfileByMode, dashboard, modeCurrent]
  );
  const liveQueryProfileName = useMemo(
    () => activeAppMode === "opencode" ? modeActiveProfileName : currentProfileName,
    [activeAppMode, currentProfileName, modeActiveProfileName]
  );
  const liveQuotaMergeTargetName = useMemo(() => {
    if (!dashboard || !modeCurrent) {
      return null;
    }
    const matched = dashboard.profiles.filter((profile) => profileMatchesCurrentIdentity(profile, modeCurrent));
    if (matched.length === 1) {
      return matched[0].name;
    }
    return currentProfileName;
  }, [currentProfileName, dashboard, modeCurrent]);

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
  }, [filteredProfiles, modeActiveProfileName, setSelected]);

  const selectedProfile = useMemo(
    () => filteredProfiles.find((p) => p.name === selected) ?? null,
    [filteredProfiles, selected]
  );
  const profileNoMap = useMemo(() => {
    const map = /* @__PURE__ */ new Map();
    filteredProfiles.forEach((p, i) => {
      map.set(p.name, i + 1);
    });
    return map;
  }, [filteredProfiles]);
  const profileLabel = useCallback(
    (name) => {
      const no = profileNoMap.get(name);
      const p = filteredProfiles.find((item) => item.name === name) ?? displayProfiles.find((item) => item.name === name);
      const title = p?.displayWorkspace || name;
      return no ? `#${no} ${title}` : title;
    },
    [displayProfiles, filteredProfiles, profileNoMap]
  );
  const rawCurrentErrorText = useMemo(() => {
    if (!dashboard?.currentError) {
      return null;
    }
    if (dashboard.currentErrorMode && dashboard.currentErrorMode !== activeAppMode) {
      return null;
    }
    return formatCurrentErrorWithProfile(dashboard, dashboard.currentError);
  }, [activeAppMode, dashboard]);
  const currentLine = useMemo(() => {
    const modeLabel = activeAppMode === "gpt" ? "GPT" : "OpenCode";
    const current = modeCurrent;
    if (initialLoading) {
      return `当前${modeLabel}账号: 账号加载中...`;
    }
    if (!modeActiveProfile && !current) {
      return `当前${modeLabel}账号: 未选择`;
    }
    const email = current?.email || modeActiveProfile?.email || "-";
    const workspace = current?.displayWorkspace || modeActiveProfile?.displayWorkspace || "-";
    const fiveHourRemaining = current?.fiveHourRemainingPercent ?? modeActiveProfile?.fiveHourRemainingPercent;
    const oneWeekRemaining = current?.oneWeekRemainingPercent ?? modeActiveProfile?.oneWeekRemainingPercent;
    return `当前${modeLabel}账号: ${email} | 工作空间 ${workspace} | 5 小时剩余 ${pct(
      fiveHourRemaining
    )} | 1 周剩余 ${pct(oneWeekRemaining)}`;
  }, [activeAppMode, initialLoading, modeActiveProfile, modeCurrent]);
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
    if (opencodeMonitorStatus.running) {
      return { level: "ok", text: "监听中" };
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
        (typeof opencodeMonitorStatus.lastActivityAgeMs === "number" ? opencodeMonitorStatus.lastActivityAgeMs : typeof opencodeMonitorStatus.lastLogAgeMs === "number" ? opencodeMonitorStatus.lastLogAgeMs : 0) / 1e3
      )
    );
    return { level: "unknown", text: `空闲待命（${ageSec}s 无活动）` };
  }, [opencodeMonitorStatus]);

  return {
    currentLine,
    currentProfileName,
    filteredProfiles,
    hookListenerBadge,
    liveQueryProfileName,
    liveQuotaMergeTargetName,
    modeActiveProfileName,
    modeCurrent,
    opencodeListenerBadge,
    profileLabel,
    rawCurrentErrorText,
    refreshingProfileNameSet,
    selectedProfile,
  };
}
