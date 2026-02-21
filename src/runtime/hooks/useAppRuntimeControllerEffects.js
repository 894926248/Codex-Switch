import { useEffect } from "react";
import { getCurrentWindow, listen } from "../../adapters/tauri";
import {
  ACTIVE_PROFILE_BY_MODE_STORAGE_KEY,
  APP_MODE_STORAGE_KEY,
  APP_SERVER_CONSOLE_LOG_ENABLED,
  CURRENT_ERROR_BANNER_DELAY_MS,
  LIVE_STATUS_POLL_MS,
  STARTUP_BACKGROUND_SYNC_DELAY_MS,
  STARTUP_LOAD_TIMEOUT_MS,
} from "../../constants";

export function useAppRuntimeControllerEffects(ctx) {
  const {
    activeAppMode,
    activeAppModeRef,
    activeProfileByMode,
    activeProfileByModeRef,
    blockingMessage,
    blockingRef,
    busy,
    busyRef,
    bypassCloseInterceptRef,
    exitApplicationWindow,
    initialLoading,
    loadDashboard,
    minimizeWindowToBackground,
    modeActiveProfileName,
    rawCurrentErrorText,
    refreshCodexExtensionInfo,
    refreshCurrentDashboardSilent,
    refreshVsCodeStatus,
    setActiveProfileByMode,
    setClosePromptOpen,
    setClosePromptRemember,
    setDisplayCurrentErrorText,
    settingsOpen,
    currentErrorCandidateRef,
    currentErrorCandidateSinceRef,
    windowCloseAction,
  } = ctx;

  useEffect(() => {
    if (!APP_SERVER_CONSOLE_LOG_ENABLED) {
      return;
    }
    let unlisten = null;
    const bind = async () => {
      try {
        unlisten = await listen("codex-switch://app-server-log", (event) => {
          const message = event.payload?.message?.trim();
          if (!message) {
            return;
          }
          const ts = event.payload?.ts?.trim();
          if (ts) {
            console.log(`[codex-switch][app-server][${ts}] ${message}`);
          } else {
            console.log(`[codex-switch][app-server] ${message}`);
          }
        });
      } catch {
      }
    };
    void bind();
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    let unlisten = null;
    const bind = async () => {
      try {
        unlisten = await getCurrentWindow().onCloseRequested(async (event) => {
          if (bypassCloseInterceptRef.current) {
            bypassCloseInterceptRef.current = false;
            return;
          }
          event.preventDefault();
          if (windowCloseAction === "exit") {
            await exitApplicationWindow();
            return;
          }
          if (windowCloseAction === "background") {
            await minimizeWindowToBackground();
            return;
          }
          setClosePromptRemember(false);
          setClosePromptOpen(true);
        });
      } catch {
      }
    };
    void bind();
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [
    bypassCloseInterceptRef,
    exitApplicationWindow,
    minimizeWindowToBackground,
    setClosePromptOpen,
    setClosePromptRemember,
    windowCloseAction,
  ]);

  useEffect(() => {
    const startupMode = activeAppModeRef.current;
    if (startupMode !== "opencode") {
      void loadDashboard(true, "已加载", true);
      return;
    }
    let cancelled = false;
    const bootstrap = async () => {
      await loadDashboard(false, "已加载", true, STARTUP_LOAD_TIMEOUT_MS);
      if (cancelled) {
        return;
      }
      window.setTimeout(() => {
        if (!cancelled) {
          void loadDashboard(true);
        }
      }, STARTUP_BACKGROUND_SYNC_DELAY_MS);
    };
    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [activeAppModeRef, loadDashboard]);

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
  }, [busy, busyRef]);

  useEffect(() => {
    blockingRef.current = blockingMessage;
  }, [blockingMessage, blockingRef]);

  useEffect(() => {
    activeAppModeRef.current = activeAppMode;
  }, [activeAppMode, activeAppModeRef]);

  useEffect(() => {
    activeProfileByModeRef.current = activeProfileByMode;
  }, [activeProfileByMode, activeProfileByModeRef]);

  useEffect(() => {
    try {
      window.localStorage.setItem(APP_MODE_STORAGE_KEY, activeAppMode);
    } catch {
    }
  }, [activeAppMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ACTIVE_PROFILE_BY_MODE_STORAGE_KEY,
        JSON.stringify(activeProfileByMode)
      );
    } catch {
    }
  }, [activeProfileByMode]);

  useEffect(() => {
    if (!modeActiveProfileName) {
      return;
    }
    setActiveProfileByMode((prev) =>
      prev[activeAppMode] === modeActiveProfileName
        ? prev
        : { ...prev, [activeAppMode]: modeActiveProfileName }
    );
  }, [activeAppMode, modeActiveProfileName, setActiveProfileByMode]);

  useEffect(() => {
    if (!rawCurrentErrorText) {
      currentErrorCandidateRef.current = null;
      currentErrorCandidateSinceRef.current = 0;
      setDisplayCurrentErrorText(null);
      return;
    }
    const now = Date.now();
    if (currentErrorCandidateRef.current !== rawCurrentErrorText) {
      currentErrorCandidateRef.current = rawCurrentErrorText;
      currentErrorCandidateSinceRef.current = now;
    }
    const elapsed = now - currentErrorCandidateSinceRef.current;
    if (elapsed >= CURRENT_ERROR_BANNER_DELAY_MS) {
      setDisplayCurrentErrorText(rawCurrentErrorText);
      return;
    }
    const timer = window.setTimeout(() => {
      if (currentErrorCandidateRef.current === rawCurrentErrorText) {
        setDisplayCurrentErrorText(rawCurrentErrorText);
      }
    }, CURRENT_ERROR_BANNER_DELAY_MS - elapsed);
    return () => window.clearTimeout(timer);
  }, [
    rawCurrentErrorText,
    currentErrorCandidateRef,
    currentErrorCandidateSinceRef,
    setDisplayCurrentErrorText,
  ]);

  useEffect(() => {
    void refreshVsCodeStatus(true);
    void refreshCodexExtensionInfo(true);
  }, [refreshVsCodeStatus, refreshCodexExtensionInfo]);

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
}
