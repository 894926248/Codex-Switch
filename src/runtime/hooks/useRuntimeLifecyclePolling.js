import { useEffect } from "react";
import {
  autoSwitchResetCommand,
  autoSwitchTickCommand,
  applyProfileCommand,
  installCodexHookCommand,
  keepaliveAllCommand,
  threadRecoverTickCommand,
} from "../../adapters/commands";
import {
  AUTO_BUSY_RETRY_MS,
  AUTO_HOOK_VERSION_POLL_MS,
  AUTO_REFRESH_ON_STARTUP_STORAGE_KEY,
  AUTO_SEAMLESS_STORAGE_KEY,
  AUTO_SWITCH_TICK_MS,
  DASHBOARD_WAIT_MAX_STEPS,
  DASHBOARD_WAIT_STEP_MS,
  HOOK_LISTEN_POLL_MS,
  HOOK_LISTEN_VSCODE_POLL_MS,
  HOOK_VERSION_SNAPSHOT_STORAGE_KEY,
  POST_SWITCH_STRATEGY_STORAGE_KEY,
  STARTUP_KEEPALIVE_THRESHOLD_MS,
  THREAD_RECOVER_TICK_MS,
  WINDOW_CLOSE_ACTION_STORAGE_KEY,
} from "../../constants";
import { nextPeriodicDelayFromLastKeepalive, nextPeriodicKeepaliveDelayMs, nextStartupStaggerDelayMs } from "../../utils";

export function useRuntimeLifecyclePolling(ctx) {
  const {
    activeAppMode,
    applyDashboard,
    autoEnabledRef,
    autoHookUpgradeRunningRef,
    autoKeepalive,
    autoRefreshOnStartup,
    autoRunningRef,
    autoSeamlessSwitch,
    autoTimerRef,
    blockingRef,
    busyRef,
    dashboardRef,
    hookInstalled,
    hookListenerVsCodeLastPollAtRef,
    hookListenerWarnedRef,
    hookVersionSnapshot,
    initialLoading,
    postSwitchStrategy,
    refreshCodexExtensionInfo,
    refreshHookStatus,
    refreshOpenCodeMonitorStatus,
    refreshVsCodeStatus,
    runPostSwitchStrategy,
    seamlessEnabledRef,
    seamlessRunningRef,
    seamlessTimerRef,
    setActiveProfileByMode,
    setAutoSeamlessSwitch,
    setBusy,
    setHookVersionSnapshot,
    setSelected,
    setStatusText,
    startupKeepaliveCheckedRef,
    threadRecoverRunningRef,
    threadRecoverTimerRef,
    vscodeStatus,
    windowCloseAction,
  } = ctx;

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_SEAMLESS_STORAGE_KEY, autoSeamlessSwitch ? "1" : "0");
    } catch {
    }
  }, [autoSeamlessSwitch]);

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_REFRESH_ON_STARTUP_STORAGE_KEY, autoRefreshOnStartup ? "1" : "0");
    } catch {
    }
  }, [autoRefreshOnStartup]);

  useEffect(() => {
    try {
      window.localStorage.setItem(POST_SWITCH_STRATEGY_STORAGE_KEY, postSwitchStrategy);
    } catch {
    }
  }, [postSwitchStrategy]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WINDOW_CLOSE_ACTION_STORAGE_KEY, windowCloseAction);
    } catch {
    }
  }, [windowCloseAction]);

  useEffect(() => {
    try {
      if (hookVersionSnapshot) {
        window.localStorage.setItem(HOOK_VERSION_SNAPSHOT_STORAGE_KEY, hookVersionSnapshot);
      } else {
        window.localStorage.removeItem(HOOK_VERSION_SNAPSHOT_STORAGE_KEY);
      }
    } catch {
    }
  }, [hookVersionSnapshot]);

  useEffect(() => {
    void refreshVsCodeStatus(true);
  }, [refreshVsCodeStatus]);

  useEffect(() => {
    void refreshCodexExtensionInfo(true);
  }, [refreshCodexExtensionInfo]);

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
  }, [activeAppMode, refreshOpenCodeMonitorStatus, setStatusText]);

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
          postSwitchStrategy === "hook" ? "监听异常：VS Code 未运行，方案2监听未激活。" : "监听未激活：VS Code 未运行。当前为方案1可继续使用；若切换到方案2请先启动 VS Code。"
        );
        return;
      }
      if (installed === false) {
        setStatusText(
          postSwitchStrategy === "hook" ? "监听异常：未检测到方案2 Hook 提速监听，请先安装/更新方案2 Hook 提速版。" : "监听未就绪：尚未注入方案2 Hook 提速版。当前为方案1可继续使用。"
        );
        return;
      }
      setStatusText(
        postSwitchStrategy === "hook" ? "监听状态检测失败，正在轮询重试。" : "监听状态暂不可用，正在轮询重试。"
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
  }, [postSwitchStrategy, refreshHookStatus, refreshVsCodeStatus, setStatusText, vscodeStatus, hookListenerVsCodeLastPollAtRef, hookListenerWarnedRef]);

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
        const result = await installCodexHookCommand();
        await refreshHookStatus(true);
        const latestInfo = await refreshCodexExtensionInfo(true);
        const savedVersion = latestInfo?.currentVersion || currentVersion;
        setHookVersionSnapshot(savedVersion);
        if (!cancelled) {
          setStatusText(`检测到 Codex 扩展版本更新（${previousVersion} -> ${currentVersion}），已自动执行“安装/更新方案2 Hook 提速版”。${result}`);
        }
      } catch (err) {
        if (!cancelled) {
          setStatusText(`检测到 Codex 扩展版本更新（${previousVersion} -> ${currentVersion}），自动更新 Hook 失败: ${String(err)}`);
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
  }, [hookInstalled, hookVersionSnapshot, refreshCodexExtensionInfo, refreshHookStatus, autoHookUpgradeRunningRef, setHookVersionSnapshot, busyRef, blockingRef, setBusy, setStatusText]);

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
  }, [postSwitchStrategy, refreshHookStatus, setStatusText]);

  useEffect(() => {
    if (hookInstalled !== false || postSwitchStrategy !== "hook") {
      return;
    }
    setStatusText("方案2 Hook 提速版未注入或版本过旧。自动场景不会回退到方案1，请先安装/更新 Hook。");
  }, [hookInstalled, postSwitchStrategy, setStatusText]);

  useEffect(() => {
    seamlessEnabledRef.current = autoSeamlessSwitch;
    if (seamlessTimerRef.current) {
      window.clearTimeout(seamlessTimerRef.current);
      seamlessTimerRef.current = null;
    }
    if (initialLoading) {
      seamlessRunningRef.current = false;
      return;
    }
    if (!autoSeamlessSwitch) {
      seamlessRunningRef.current = false;
      void autoSwitchResetCommand().catch(() => {
      });
      setStatusText("无感换号已关闭。");
      return;
    }
    let cancelled = false;
    const schedule = (delayMs) => {
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
          const result = await autoSwitchTickCommand(activeAppMode);
          if (!cancelled && result.dashboard) {
            applyDashboard(result.dashboard);
          }
          if (!cancelled && result.action === "switched") {
            const switchedTo = result.switchedTo?.trim();
            if (switchedTo) {
              setActiveProfileByMode((prev) => prev[activeAppMode] === switchedTo ? prev : { ...prev, [activeAppMode]: switchedTo });
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
                  const fallbackTip = postSwitchStrategy === "hook" ? "方案2提速失败，可在设置中心切换到方案1（直接重启 Extension Host）。" : "可稍后重试该策略。";
                  setStatusText(`${baseMessage} 切后动作失败: ${String(err)}。${fallbackTip}`);
                }
              }
            } else if (switchedTo) {
              try {
                const calibrated = await applyProfileCommand(switchedTo, "opencode");
                if (!cancelled) {
                  applyDashboard(calibrated, `${baseMessage}（已自动执行一次手动切号校准）`);
                }
              } catch (err) {
                if (!cancelled) {
                  setStatusText(`${baseMessage} 自动切后校准失败: ${String(err)}`);
                }
              }
            } else {
              setStatusText(baseMessage);
            }
          } else if (!cancelled && result.message && !["idle", "cooldown", "no_candidate_cooldown"].includes(result.action)) {
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
      void autoSwitchResetCommand().catch(() => {
      });
    };
  }, [activeAppMode, autoSeamlessSwitch, applyDashboard, initialLoading, postSwitchStrategy, runPostSwitchStrategy, setActiveProfileByMode, setSelected, setStatusText, seamlessEnabledRef, seamlessTimerRef, seamlessRunningRef, busyRef, blockingRef]);

  useEffect(() => {
    if (initialLoading || !autoSeamlessSwitch) {
      if (threadRecoverTimerRef.current) {
        window.clearTimeout(threadRecoverTimerRef.current);
        threadRecoverTimerRef.current = null;
      }
      threadRecoverRunningRef.current = false;
      return;
    }
    let cancelled = false;
    const schedule = (delayMs) => {
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
          const result = await threadRecoverTickCommand(activeAppMode);
          if (!cancelled && result.message && ["thread_recovered", "thread_recover_failed"].includes(result.action)) {
            setStatusText(result.message);
          }
        } catch {
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
  }, [activeAppMode, autoSeamlessSwitch, initialLoading, threadRecoverTimerRef, threadRecoverRunningRef, busyRef, blockingRef, setStatusText]);

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
    const runKeepalive = async (successText, failPrefix) => {
      if (autoRunningRef.current) {
        return;
      }
      autoRunningRef.current = true;
      try {
        const data = await keepaliveAllCommand();
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
    const schedule = (delayMs, reason) => {
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
    const wait = (ms) => new Promise((resolve) => {
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
        const lastKeepaliveMs = lastKeepaliveAt ? lastKeepaliveAt * 1e3 : null;
        const shouldRunStartupKeepalive = !lastKeepaliveMs || Date.now() - lastKeepaliveMs >= STARTUP_KEEPALIVE_THRESHOLD_MS;
        if (shouldRunStartupKeepalive) {
          const startupDelay = nextStartupStaggerDelayMs();
          const mins = Math.max(1, Math.round(startupDelay / 6e4));
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
  }, [autoKeepalive, applyDashboard, autoEnabledRef, autoTimerRef, autoRunningRef, dashboardRef, startupKeepaliveCheckedRef, setStatusText]);
}
