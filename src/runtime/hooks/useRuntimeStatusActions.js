import { useCallback } from "react";
import {
  getCodexExtensionInfoCommand,
  getOpenCodeMonitorStatusCommand,
  getVsCodeStatusCommand,
  installCodexHookCommand,
  isCodexHookInstalledCommand,
  reloadVsCodeWindowCommand,
  runPostSwitchActionCommand,
} from "../../adapters/commands";
import { stringArrayEqual } from "../../utils";

export function useRuntimeStatusActions(ctx) {
  const {
    postSwitchStrategy,
    refreshCodexExtensionInfoSetter,
    refreshHookStatusSetter,
    refreshOpenCodeMonitorStatusSetter,
    refreshVsCodeStatusSetter,
    settingsEditorTarget,
    settingsTargetName,
    settingsTargetShortName,
    setBusy,
    setCodexExtInfo,
    setHookInstalled,
    setHookVersionSnapshot,
    setOpenCodeMonitorStatus,
    setPostSwitchStrategy,
    setStatusText,
    setVsCodeStatus,
    vscodeStatus,
  } = ctx;

  const refreshVsCodeStatus = useCallback(async (silent = false, editorTarget = settingsEditorTarget) => {
    try {
      const status = await getVsCodeStatusCommand(editorTarget);
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
  }, [setStatusText, setVsCodeStatus, settingsEditorTarget]);

  const refreshOpenCodeMonitorStatus = useCallback(async (silent = false) => {
    try {
      const status = await getOpenCodeMonitorStatusCommand();
      setOpenCodeMonitorStatus((prev) => {
        if (prev && prev.authReady === status.authReady && prev.running === status.running && prev.processCount === status.processCount && prev.logReady === status.logReady && prev.logRecent === status.logRecent && (prev.lastLogAgeMs ?? null) === (status.lastLogAgeMs ?? null) && prev.activityRecent === status.activityRecent && (prev.lastActivityAgeMs ?? null) === (status.lastActivityAgeMs ?? null) && (prev.activitySource ?? null) === (status.activitySource ?? null)) {
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
  }, [setOpenCodeMonitorStatus, setStatusText]);

  const refreshCodexExtensionInfo = useCallback(
    async (silent = false) => {
      try {
        const info = await getCodexExtensionInfoCommand();
        setCodexExtInfo((prev) => {
          if (prev && prev.currentVersion === info.currentVersion && stringArrayEqual(prev.allVersions, info.allVersions)) {
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
    [setCodexExtInfo, setStatusText]
  );

  const refreshHookStatus = useCallback(
    async (silent = false, editorTarget = settingsEditorTarget) => {
      try {
        const installed = await isCodexHookInstalledCommand(editorTarget);
        setHookInstalled((prev) => prev === installed ? prev : installed);
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
    [postSwitchStrategy, setHookInstalled, setStatusText, settingsEditorTarget]
  );

  const runPostSwitchStrategy = useCallback(
    async (strategy, fromAutoSwitch) => {
      const effectiveStrategy = fromAutoSwitch && strategy === "restart_extension_host" ? "hook" : strategy;
      const result = await runPostSwitchActionCommand(effectiveStrategy, settingsEditorTarget);
      if (!fromAutoSwitch) {
        setStatusText(result);
      }
      return result;
    },
    [setStatusText, settingsEditorTarget]
  );

  const onReloadVsCode = useCallback(async () => {
    setBusy(true);
    setStatusText("正在请求 VS Code 重载窗口...");
    try {
      const status = await refreshVsCodeStatus(true, "vscode");
      if (!status?.running) {
        setStatusText("未检测到 VS Code 正在运行，请先启动 VS Code。");
        return;
      }
      const result = await reloadVsCodeWindowCommand();
      setStatusText(result);
    } catch (err) {
      setStatusText(`重载失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [refreshVsCodeStatus, setBusy, setStatusText]);

  const onInstallCodexHook = useCallback(async () => {
    setBusy(true);
    setStatusText("正在安装/更新方案2 Hook 提速版...");
    try {
      const status = await refreshVsCodeStatus(true, settingsEditorTarget);
      if (!status?.running) {
        setStatusText(`未检测到 ${settingsTargetName} 正在运行，无法注入 Hook。请先启动 ${settingsTargetShortName}。`);
        return;
      }
      const result = await installCodexHookCommand(settingsEditorTarget);
      await refreshHookStatus(true, settingsEditorTarget);
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
  }, [
    refreshCodexExtensionInfo,
    refreshHookStatus,
    refreshVsCodeStatus,
    setBusy,
    setHookVersionSnapshot,
    setStatusText,
    settingsEditorTarget,
    settingsTargetName,
    settingsTargetShortName,
  ]);

  const onRunPostSwitchStrategy = useCallback(async (strategy) => {
    setBusy(true);
    setStatusText(
      strategy === "hook" ? "正在执行方案2（Hook 提速重启 Extension Host）..." : "正在执行方案1（重启 Extension Host）..."
    );
    try {
      const status = await refreshVsCodeStatus(true, settingsEditorTarget);
      if (!status?.running) {
        setStatusText(`未检测到 ${settingsTargetName} 正在运行，请先启动后再执行该策略。`);
        return;
      }
      if (strategy === "hook") {
        const installed = await refreshHookStatus(true, settingsEditorTarget);
        if (installed === false) {
          setStatusText(
            "方案2 Hook 提速版未注入或版本过旧，请先点击“一键注入并启用方案2提速版”或“安装/更新方案2 Hook 提速版”。"
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
  }, [
    refreshHookStatus,
    refreshVsCodeStatus,
    runPostSwitchStrategy,
    setBusy,
    setStatusText,
    settingsEditorTarget,
    settingsTargetName,
  ]);

  const onInjectHookOneClick = useCallback(async () => {
    setBusy(true);
    setStatusText("正在一键注入 Hook 提速版并启用方案2...");
    try {
      const status = await refreshVsCodeStatus(true, settingsEditorTarget);
      if (!status?.running) {
        setStatusText(`未检测到 ${settingsTargetName} 正在运行。请先启动 ${settingsTargetShortName}，再执行一键注入。`);
        return;
      }
      const installMsg = await installCodexHookCommand(settingsEditorTarget);
      await refreshHookStatus(true, settingsEditorTarget);
      const info = await refreshCodexExtensionInfo(true);
      if (info?.currentVersion) {
        setHookVersionSnapshot(info.currentVersion);
      }
      const restartMsg = await runPostSwitchActionCommand("restart_extension_host", settingsEditorTarget);
      setPostSwitchStrategy("hook");
      setStatusText(
        `${installMsg} ${restartMsg} 已切换为方案2（Hook 提速版）。${info?.currentVersion ? `已记录扩展版本 ${info.currentVersion}。` : ""}`
      );
    } catch (err) {
      setStatusText(`一键注入失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [
    refreshCodexExtensionInfo,
    refreshHookStatus,
    refreshVsCodeStatus,
    setBusy,
    setHookVersionSnapshot,
    setPostSwitchStrategy,
    setStatusText,
    settingsEditorTarget,
    settingsTargetName,
    settingsTargetShortName,
  ]);

  if (refreshCodexExtensionInfoSetter) {
    refreshCodexExtensionInfoSetter.current = refreshCodexExtensionInfo;
  }
  if (refreshHookStatusSetter) {
    refreshHookStatusSetter.current = refreshHookStatus;
  }
  if (refreshOpenCodeMonitorStatusSetter) {
    refreshOpenCodeMonitorStatusSetter.current = refreshOpenCodeMonitorStatus;
  }
  if (refreshVsCodeStatusSetter) {
    refreshVsCodeStatusSetter.current = refreshVsCodeStatus;
  }

  return {
    onInjectHookOneClick,
    onInstallCodexHook,
    onReloadVsCode,
    onRunPostSwitchStrategy,
    refreshCodexExtensionInfo,
    refreshHookStatus,
    refreshOpenCodeMonitorStatus,
    refreshVsCodeStatus,
    runPostSwitchStrategy,
  };
}
