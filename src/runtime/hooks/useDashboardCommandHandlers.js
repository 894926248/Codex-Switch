import { useCallback, useMemo } from "react";
import { KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import {
  addAccountByLoginCommand,
  DASHBOARD_COMMANDS,
  exportDataBackupCommand,
  importDataBackupBase64Command,
  invokeCommand,
  keepaliveAllCommand,
  refreshProfileQuotaCommand,
  reorderProfilesCommand,
} from "../../adapters/commands";
import { listen, open } from "../../adapters/tauri";
import {
  dashboardCurrentByMode,
  fileToBase64,
  findProfileNameForCurrent,
  supportsAppMode,
} from "../../utils";

export function useDashboardCommandHandlers(ctx) {
  const {
    activeAppMode,
    activeAppModeRef,
    activeProfileByModeRef,
    applyDashboard,
    currentProfileName,
    dashboard,
    displayProfiles,
    filteredProfiles,
    importBackupInputRef,
    loadDashboard,
    modeActiveProfileName,
    pendingSortNamesRef,
    profileLabel,
    selectedProfile,
    setActiveProfileByMode,
    setBlockingMessage,
    setBusy,
    setDisplayProfiles,
    setQuotaQuerying,
    setRefreshingProfileNames,
    setStatusText,
    sortSavingRef,
    uiBusy,
  } = ctx;

  const runDashboardCommand = useCallback(
    async (command, args, successText, beforeText, options) => {
      const isQuotaQuerying = options?.quotaQuerying === true;
      const refreshingProfiles = (options?.refreshingProfiles || []).filter(
        (name) => name.trim().length > 0
      );
      if (isQuotaQuerying) {
        setQuotaQuerying(true);
      }
      if (refreshingProfiles.length > 0) {
        setRefreshingProfileNames((prev) => {
          const next = new Set(prev);
          for (const name of refreshingProfiles) {
            next.add(name);
          }
          return Array.from(next);
        });
      }
      setBusy(true);
      if (beforeText) {
        setStatusText(beforeText);
      }
      try {
        const data = await invokeCommand(command, args);
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
        if (refreshingProfiles.length > 0) {
          const refreshingSet = new Set(refreshingProfiles);
          setRefreshingProfileNames((prev) => prev.filter((name) => !refreshingSet.has(name)));
        }
      }
    },
    [applyDashboard, setBusy, setQuotaQuerying, setRefreshingProfileNames, setStatusText]
  );

  const requireSelectedName = useCallback(() => {
    if (!selectedProfile) {
      setStatusText("请先选择一个账号。");
      return null;
    }
    return selectedProfile.name;
  }, [selectedProfile, setStatusText]);

  const onAddByLogin = useCallback(async () => {
    setBusy(true);
    setBlockingMessage("正在打开登录窗口...");
    setStatusText("正在打开登录窗口...");
    let unlisten = null;
    let finalLoginNotice = null;
    try {
      unlisten = await listen("codex-switch://login-progress", (event) => {
        const phase = event.payload?.phase?.trim();
        const msg = event.payload?.message?.trim();
        if (!msg) {
          return;
        }
        if (phase === "done") {
          finalLoginNotice = msg;
        }
        setBlockingMessage(msg);
        setStatusText(msg);
      });
      const data = await addAccountByLoginCommand();
      applyDashboard(data, finalLoginNotice ?? "添加账号完成");
      const matched =
        findProfileNameForCurrent(
          data,
          dashboardCurrentByMode(data, activeAppModeRef.current),
          activeProfileByModeRef.current[activeAppModeRef.current]
        ) ?? data.activeProfile ?? null;
      if (
        matched &&
        data.profiles.some(
          (profile) => profile.name === matched && supportsAppMode(profile.support, activeAppMode)
        )
      ) {
        setActiveProfileByMode((prev) =>
          prev[activeAppMode] === matched ? prev : { ...prev, [activeAppMode]: matched }
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
  }, [
    activeAppMode,
    activeAppModeRef,
    activeProfileByModeRef,
    applyDashboard,
    setActiveProfileByMode,
    setBlockingMessage,
    setBusy,
    setStatusText,
  ]);

  const onApplySelected = useCallback(
    async (name) => {
      const target = name ?? requireSelectedName();
      if (!target) {
        return;
      }
      const label = profileLabel(target);
      setBlockingMessage(`正在切换账号: ${label}...`);
      try {
        const ok = await runDashboardCommand(
          DASHBOARD_COMMANDS.applyProfile,
          { name: target, mode: activeAppMode },
          `已切换到账号: ${label}`,
          `正在切换账号: ${label}...`
        );
        if (!ok) {
          return;
        }
        setActiveProfileByMode((prev) =>
          prev[activeAppMode] === target ? prev : { ...prev, [activeAppMode]: target }
        );
        setBlockingMessage(`正在校准额度: ${label}...`);
        try {
          const calibrated = await refreshProfileQuotaCommand(target, false, activeAppMode);
          applyDashboard(calibrated, `已切换到账号: ${label}`);
        } catch (err) {
          setStatusText(`已切换到账号: ${label}（额度校准失败: ${String(err)}）`);
        }
      } finally {
        setBlockingMessage(null);
      }
    },
    [
      activeAppMode,
      applyDashboard,
      profileLabel,
      requireSelectedName,
      runDashboardCommand,
      setActiveProfileByMode,
      setBlockingMessage,
      setStatusText,
    ]
  );

  const onSetAlias = useCallback(
    async (name) => {
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
        DASHBOARD_COMMANDS.setWorkspaceAlias,
        { name: target, alias: aliasInput.trim() || null },
        aliasInput.trim() ? `已更新工作空间别名: ${label}` : `已清除工作空间别名: ${label}`
      );
    },
    [dashboard?.profiles, profileLabel, requireSelectedName, runDashboardCommand]
  );

  const onRefreshSelectedQuota = useCallback(
    async (name, refreshToken = true) => {
      const target = name ?? requireSelectedName();
      if (!target) {
        return;
      }
      const label = profileLabel(target);
      await runDashboardCommand(
        DASHBOARD_COMMANDS.refreshProfileQuota,
        { name: target, refreshToken, mode: activeAppMode },
        `已刷新额度: ${label}`,
        `正在刷新额度: ${label}...`,
        { quotaQuerying: true, refreshingProfiles: [target] }
      );
    },
    [activeAppMode, profileLabel, requireSelectedName, runDashboardCommand]
  );

  const onRefreshAllQuota = useCallback(
    async (refreshToken = true) => {
      await runDashboardCommand(
        DASHBOARD_COMMANDS.refreshAllQuota,
        { refreshToken, mode: activeAppMode },
        "已刷新全部账号额度",
        "正在刷新全部账号额度...",
        { quotaQuerying: true, refreshingProfiles: filteredProfiles.map((profile) => profile.name) }
      );
    },
    [activeAppMode, filteredProfiles, runDashboardCommand]
  );

  const onRefreshStartupQuota = useCallback(async () => {
    if (activeAppMode !== "opencode") {
      await onRefreshAllQuota(false);
      return;
    }
    const currentName = currentProfileName ?? modeActiveProfileName;
    const targets = filteredProfiles
      .map((profile) => profile.name)
      .filter((name) => name !== currentName);
    if (targets.length === 0) {
      return;
    }
    await runDashboardCommand(
      DASHBOARD_COMMANDS.refreshProfilesQuota,
      { names: targets, refreshToken: false, mode: "opencode" },
      `已刷新 ${targets.length} 个账号额度`,
      `启动自动查询：正在刷新其余 ${targets.length} 个账号额度...`,
      { quotaQuerying: true, refreshingProfiles: targets }
    );
  }, [
    activeAppMode,
    currentProfileName,
    filteredProfiles,
    modeActiveProfileName,
    onRefreshAllQuota,
    runDashboardCommand,
  ]);

  const onDeleteSelected = useCallback(
    async (name) => {
      const target = name ?? requireSelectedName();
      if (!target) {
        return;
      }
      const label = profileLabel(target);
      if (!window.confirm(`确定删除账号配置 "${label}" 吗？`)) {
        return;
      }
      const ok = await runDashboardCommand(DASHBOARD_COMMANDS.deleteProfile, { name: target }, `已删除账号: ${label}`);
      if (!ok) {
        return;
      }
      setActiveProfileByMode((prev) => ({
        gpt: prev.gpt === target ? null : prev.gpt,
        opencode: prev.opencode === target ? null : prev.opencode,
      }));
    },
    [profileLabel, requireSelectedName, runDashboardCommand, setActiveProfileByMode]
  );

  const onExportDataBackup = useCallback(async () => {
    let outputDir = null;
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
      const result = await exportDataBackupCommand(outputDir);
      setStatusText(`备份已导出：${result.archivePath}`);
      window.alert(`备份导出完成。\n\n文件：${result.archivePath}\n条目数：${result.fileCount}\n估算大小：${result.estimatedTotalBytes} 字节`);
    } catch (err) {
      setStatusText(`导出备份失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [setBusy, setStatusText]);

  const onImportDataBackupClick = useCallback(() => {
    if (uiBusy) {
      return;
    }
    importBackupInputRef.current?.click();
  }, [importBackupInputRef, uiBusy]);

  const onImportDataBackupFileSelected = useCallback(
    async (event) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = "";
      if (!file) {
        return;
      }
      if (
        !window.confirm(
          "导入恢复会覆盖当前账号列表和已保存快照，恢复前会自动创建一份安全备份。\n\n确定继续吗？"
        )
      ) {
        return;
      }
      setBusy(true);
      setStatusText("正在导入备份并恢复数据...");
      try {
        const archiveBase64 = await fileToBase64(file);
        const result = await importDataBackupBase64Command(file.name, archiveBase64);
        applyDashboard(result.dashboard, `备份恢复完成：已恢复 ${result.restoredCount} 个文件`);
        window.alert(`备份恢复完成。\n\n来源文件：${result.sourceFileName}\n已恢复条目：${result.restoredCount}\n恢复前备份：${result.safeguardArchivePath}`);
      } catch (err) {
        setStatusText(`导入备份失败: ${String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [applyDashboard, setBusy, setStatusText]
  );

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
      const data = await reorderProfilesCommand(names);
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
  }, [applyDashboard, loadDashboard, pendingSortNamesRef, setStatusText, sortSavingRef]);

  const queuePersistOrder = useCallback(
    (names) => {
      pendingSortNamesRef.current = [...names];
      void flushSortPersist();
    },
    [flushSortPersist, pendingSortNamesRef]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const profileIds = useMemo(() => filteredProfiles.map((p) => p.name), [filteredProfiles]);

  const onDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      if (!filteredProfiles.length || !over) {
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
    [activeAppMode, displayProfiles, filteredProfiles, queuePersistOrder, setDisplayProfiles]
  );

  const onKeepaliveNow = useCallback(async () => {
    setBusy(true);
    setStatusText("正在手动保活（刷新全部账号 Token）...");
    try {
      const data = await keepaliveAllCommand();
      applyDashboard(data, "手动保活完成，全部账号 Token 已刷新。");
    } catch (err) {
      setStatusText(`手动保活失败: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [applyDashboard, setBusy, setStatusText]);

  return {
    onAddByLogin,
    onApplySelected,
    onDeleteSelected,
    onDragEnd,
    onExportDataBackup,
    onImportDataBackupClick,
    onImportDataBackupFileSelected,
    onKeepaliveNow,
    onRefreshAllQuota,
    onRefreshSelectedQuota,
    onRefreshStartupQuota,
    onSetAlias,
    profileIds,
    sensors,
  };
}
