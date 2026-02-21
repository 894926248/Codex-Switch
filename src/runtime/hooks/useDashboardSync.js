import { useCallback } from "react";
import { invoke } from "../../adapters/tauri";
import {
  LIVE_STATUS_BURST_COOLDOWN_MS,
  LIVE_STATUS_BURST_THRESHOLD,
  LIVE_STATUS_BURST_WINDOW_MS,
  LIVE_STATUS_ERROR_RETRY_MAX_MS,
  LIVE_STATUS_ERROR_RETRY_MS,
  LIVE_STATUS_FETCH_MIN_MS,
} from "../../constants";
import {
  buildDashboardSignature,
  dashboardCurrentByMode,
  formatCurrentErrorWithProfile,
  profileMatchesCurrentIdentity,
  withTimeout,
} from "../../utils";

export function useDashboardSync(ctx) {
  const {
    activeAppModeRef,
    blockingRef,
    busyRef,
    dashboardRef,
    dashboardSignatureRef,
    liveStatusErrorStreakRef,
    liveStatusErrorTimesRef,
    liveStatusNextFetchAtRef,
    liveStatusPollingRef,
    setBusy,
    setDashboard,
    setDisplayProfiles,
    setInitialLoading,
    setSelected,
    setStatusText,
  } = ctx;

  const applyDashboard = useCallback((data, msg, options) => {
    const preserveQuotaFromCurrentDashboard = options?.preserveQuotaFromCurrentDashboard === true;
    const previousDashboard = dashboardRef.current;
    const previousProfileMap = new Map((previousDashboard?.profiles ?? []).map((profile) => [profile.name, profile]));
    const mergeQuotaFromPreviousProfile = (profile) => {
      if (!preserveQuotaFromCurrentDashboard) {
        return profile;
      }
      const previous = previousProfileMap.get(profile.name);
      if (!previous) {
        return profile;
      }
      const pick = (oldValue, nextValue) => oldValue !== void 0 ? oldValue : nextValue;
      return {
        ...profile,
        fiveHourRemainingPercent: pick(previous.fiveHourRemainingPercent, profile.fiveHourRemainingPercent),
        fiveHourResetsAt: pick(previous.fiveHourResetsAt, profile.fiveHourResetsAt),
        oneWeekRemainingPercent: pick(previous.oneWeekRemainingPercent, profile.oneWeekRemainingPercent),
        oneWeekResetsAt: pick(previous.oneWeekResetsAt, profile.oneWeekResetsAt),
        lastCheckedAt: pick(previous.lastCheckedAt, profile.lastCheckedAt),
        lastError: pick(previous.lastError, profile.lastError)
      };
    };
    const mergeQuotaFromPreviousCurrent = (current) => {
      if (!preserveQuotaFromCurrentDashboard || !current) {
        return current;
      }
      const previousCurrent = dashboardCurrentByMode(previousDashboard, activeAppModeRef.current);
      if (!previousCurrent) {
        return current;
      }
      const pick = (oldValue, nextValue) => oldValue !== void 0 ? oldValue : nextValue;
      return {
        ...current,
        fiveHourRemainingPercent: pick(previousCurrent.fiveHourRemainingPercent, current.fiveHourRemainingPercent),
        fiveHourResetsAt: pick(previousCurrent.fiveHourResetsAt, current.fiveHourResetsAt),
        oneWeekRemainingPercent: pick(previousCurrent.oneWeekRemainingPercent, current.oneWeekRemainingPercent),
        oneWeekResetsAt: pick(previousCurrent.oneWeekResetsAt, current.oneWeekResetsAt)
      };
    };
    const currentMode = activeAppModeRef.current;
    const modeCurrent2 = dashboardCurrentByMode(data, currentMode);
    const mergeQuotaFromCurrent = (profile) => ({
      ...profile,
      fiveHourRemainingPercent: modeCurrent2?.fiveHourRemainingPercent,
      fiveHourResetsAt: modeCurrent2?.fiveHourResetsAt,
      oneWeekRemainingPercent: modeCurrent2?.oneWeekRemainingPercent,
      oneWeekResetsAt: modeCurrent2?.oneWeekResetsAt
    });
    const matchedByIdentity = modeCurrent2 != null ? data.profiles.filter((profile) => profileMatchesCurrentIdentity(profile, modeCurrent2)) : [];
    const uniqueIdentityMatchName = matchedByIdentity.length === 1 ? matchedByIdentity[0].name : null;
    const mergeTargetName = uniqueIdentityMatchName;
    const mergedProfiles = modeCurrent2 != null && mergeTargetName ? data.profiles.map(
      (profile) => profile.name === mergeTargetName ? mergeQuotaFromCurrent(profile) : profile
    ) : data.profiles;
    const mergedProfilesWithPreservedQuota = preserveQuotaFromCurrentDashboard ? mergedProfiles.map((profile) => mergeQuotaFromPreviousProfile(profile)) : mergedProfiles;
    const hasProfileMutation = mergedProfilesWithPreservedQuota !== data.profiles;
    const nextDashboardBase = hasProfileMutation ? { ...data, profiles: mergedProfilesWithPreservedQuota } : data;
    const nextDashboard = currentMode === "opencode" ? {
      ...nextDashboardBase,
      opencodeCurrent: mergeQuotaFromPreviousCurrent(nextDashboardBase.opencodeCurrent)
    } : {
      ...nextDashboardBase,
      current: mergeQuotaFromPreviousCurrent(nextDashboardBase.current)
    };
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
  }, [activeAppModeRef, dashboardRef, dashboardSignatureRef, setDashboard, setDisplayProfiles, setSelected, setStatusText]);

  const loadDashboard = useCallback(
    async (syncCurrent = true, msg, markInitialDone = false, timeoutMs) => {
      setBusy(true);
      try {
        const mode = activeAppModeRef.current;
        const task = invoke("load_dashboard", {
          syncCurrent,
          mode
        });
        const data = mode === "opencode" ? await withTimeout(task, timeoutMs ?? 0, "加载账号") : await task;
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
    [activeAppModeRef, applyDashboard, setBusy, setInitialLoading, setStatusText]
  );

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
      const data = await invoke("load_dashboard", {
        syncCurrent: false,
        mode: activeAppModeRef.current
      });
      const nextSignature = buildDashboardSignature(data);
      if (nextSignature !== dashboardSignatureRef.current) {
        applyDashboard(data, void 0, { preserveQuotaFromCurrentDashboard: true });
      }
      liveStatusErrorStreakRef.current = 0;
      if (data.currentError) {
        const nowMs = Date.now();
        const next = [...liveStatusErrorTimesRef.current, nowMs].filter(
          (ts) => nowMs - ts <= LIVE_STATUS_BURST_WINDOW_MS
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
      liveStatusErrorStreakRef.current += 1;
      const nowMs = Date.now();
      const next = [...liveStatusErrorTimesRef.current, nowMs].filter(
        (ts) => nowMs - ts <= LIVE_STATUS_BURST_WINDOW_MS
      );
      liveStatusErrorTimesRef.current = next;
      const retryDelay = Math.min(
        LIVE_STATUS_ERROR_RETRY_MS * Math.pow(2, Math.max(0, liveStatusErrorStreakRef.current - 1)),
        LIVE_STATUS_ERROR_RETRY_MAX_MS
      );
      const burstCooldown = next.length >= LIVE_STATUS_BURST_THRESHOLD ? LIVE_STATUS_BURST_COOLDOWN_MS : 0;
      liveStatusNextFetchAtRef.current = nowMs + Math.max(retryDelay, burstCooldown);
      if (burstCooldown > 0) {
        liveStatusErrorTimesRef.current = [];
      }
    } finally {
      liveStatusPollingRef.current = false;
    }
  }, [
    activeAppModeRef,
    applyDashboard,
    blockingRef,
    busyRef,
    dashboardSignatureRef,
    liveStatusErrorStreakRef,
    liveStatusErrorTimesRef,
    liveStatusNextFetchAtRef,
    liveStatusPollingRef,
  ]);

  return {
    applyDashboard,
    loadDashboard,
    refreshCurrentDashboardSilent,
  };
}
