import { useCallback, useEffect, useMemo } from "react";
import { invoke } from "../../adapters/tauri";
import { recomputeMcpManage, recomputeSkillsCatalog } from "../../utils";
import { useMcpPanelActions } from "./toolsPanel/useMcpPanelActions";
import { useSkillsPanelActions } from "./toolsPanel/useSkillsPanelActions";

export function useToolsPanelLogic(ctx) {
  const {
    activeToolView,
    skillsCatalog,
    skillsDiscovery,
    skillsDiscoveryInstallFilter,
    skillsDiscoveryKeyword,
    skillsLoading,
    skillsRefreshing,
    skillsDiscoveryLoading,
    skillsDiscoveryRefreshing,
    skillReposManage,
    skillReposManageLoading,
    skillReposManageRefreshing,
    mcpManage,
    mcpManageLoading,
    mcpManageRefreshing,
    setMcpManage,
    setMcpManageError,
    setMcpManageLoading,
    setMcpManageRefreshing,
    setSkillReposManage,
    setSkillReposManageError,
    setSkillReposManageLoading,
    setSkillReposManageRefreshing,
    setSkillsCatalog,
    setSkillsDiscovery,
    setSkillsDiscoveryError,
    setSkillsDiscoveryLoading,
    setSkillsDiscoveryRefreshing,
    setSkillsError,
    setSkillsLoading,
    setSkillsRefreshing,
    setStatusText,
  } = ctx;

  const loadSkillsCatalog = useCallback(
    async (showLoading) => {
      if (showLoading) {
        setSkillsLoading(true);
      } else {
        setSkillsRefreshing(true);
      }
      try {
        const data = await invoke("load_skills_catalog");
        setSkillsCatalog(recomputeSkillsCatalog(data));
        setSkillsError(null);
        return true;
      } catch (err) {
        setSkillsError(`读取 Skills 失败: ${String(err)}`);
        return false;
      } finally {
        setSkillsLoading(false);
        setSkillsRefreshing(false);
      }
    },
    [setSkillsLoading, setSkillsRefreshing, setSkillsCatalog, setSkillsError]
  );

  const onRefreshSkillsCatalog = useCallback(async () => {
    if (skillsLoading || skillsRefreshing) {
      return;
    }
    setStatusText("正在刷新 Skills...");
    const ok = await loadSkillsCatalog(false);
    setStatusText(ok ? "已刷新 Skills" : "刷新 Skills 失败");
  }, [skillsLoading, skillsRefreshing, loadSkillsCatalog, setStatusText]);

  const loadSkillsDiscovery = useCallback(
    async (showLoading, syncRemote) => {
      if (showLoading) {
        setSkillsDiscoveryLoading(true);
      } else {
        setSkillsDiscoveryRefreshing(true);
      }
      try {
        const data = await invoke("load_skills_discovery", { syncRemote });
        setSkillsDiscovery(data);
        setSkillsDiscoveryError(null);
      } catch (err) {
        setSkillsDiscoveryError(`读取发现技能失败: ${String(err)}`);
      } finally {
        setSkillsDiscoveryLoading(false);
        setSkillsDiscoveryRefreshing(false);
      }
    },
    [
      setSkillsDiscoveryLoading,
      setSkillsDiscoveryRefreshing,
      setSkillsDiscovery,
      setSkillsDiscoveryError,
    ]
  );

  const loadSkillReposManage = useCallback(
    async (showLoading, refreshCount) => {
      if (showLoading) {
        setSkillReposManageLoading(true);
      } else {
        setSkillReposManageRefreshing(true);
      }
      try {
        const data = await invoke("load_skill_repos_manage", { refreshCount });
        setSkillReposManage(data);
        setSkillReposManageError(null);
      } catch (err) {
        setSkillReposManageError(`读取仓库管理失败: ${String(err)}`);
      } finally {
        setSkillReposManageLoading(false);
        setSkillReposManageRefreshing(false);
      }
    },
    [
      setSkillReposManageLoading,
      setSkillReposManageRefreshing,
      setSkillReposManage,
      setSkillReposManageError,
    ]
  );

  const loadMcpManage = useCallback(
    async (showLoading) => {
      if (showLoading) {
        setMcpManageLoading(true);
      } else {
        setMcpManageRefreshing(true);
      }
      try {
        const data = await invoke("load_mcp_manage");
        setMcpManage(recomputeMcpManage(data));
        setMcpManageError(null);
        return true;
      } catch (err) {
        setMcpManageError(`读取 MCP 失败: ${String(err)}`);
        return false;
      } finally {
        setMcpManageLoading(false);
        setMcpManageRefreshing(false);
      }
    },
    [setMcpManageLoading, setMcpManageRefreshing, setMcpManage, setMcpManageError]
  );

  const onRefreshMcpManage = useCallback(async () => {
    if (mcpManageLoading || mcpManageRefreshing) {
      return;
    }
    setStatusText("正在刷新 MCP...");
    const ok = await loadMcpManage(false);
    setStatusText(ok ? "已刷新 MCP" : "刷新 MCP 失败");
  }, [mcpManageLoading, mcpManageRefreshing, loadMcpManage, setStatusText]);

  const mcpActions = useMcpPanelActions({
    ...ctx,
    loadMcpManage,
  });

  const skillsActions = useSkillsPanelActions({
    ...ctx,
    loadSkillReposManage,
    loadSkillsCatalog,
    loadSkillsDiscovery,
  });

  const skillsSummaryText = useMemo(() => {
    if (!skillsCatalog) {
      return "已安装 · Skills: 0 · Claude: 0 · Codex: 0 · Gemini: 0 · OpenCode: 0";
    }
    return `已安装 · Skills: ${skillsCatalog.total} · Claude: ${skillsCatalog.claudeEnabledCount} · Codex: ${skillsCatalog.codexEnabledCount} · Gemini: ${skillsCatalog.geminiEnabledCount} · OpenCode: ${skillsCatalog.opencodeEnabledCount}`;
  }, [skillsCatalog]);

  const skillsDiscoverySummaryText = useMemo(() => {
    if (!skillsDiscovery) {
      return "发现来源 · 仓库: 0/0 · Skills: 0";
    }
    const enabledRepoCount = skillsDiscovery.repos.filter((repo) => repo.enabled).length;
    return `发现来源 · 仓库: ${enabledRepoCount}/${skillsDiscovery.repos.length} · Skills: ${skillsDiscovery.total}`;
  }, [skillsDiscovery]);

  const filteredDiscoverySkills = useMemo(() => {
    if (!skillsDiscovery) {
      return [];
    }
    const keyword = skillsDiscoveryKeyword.trim().toLowerCase();
    return skillsDiscovery.skills.filter((skill) => {
      if (skillsDiscoveryInstallFilter === "installed" && !skill.installed) {
        return false;
      }
      if (skillsDiscoveryInstallFilter === "notInstalled" && skill.installed) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      const haystack = `${skill.name} ${skill.description} ${skill.repoOwner}/${skill.repoName}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }, [skillsDiscovery, skillsDiscoveryKeyword, skillsDiscoveryInstallFilter]);

  const skillsDiscoverySyncingEmpty =
    skillsDiscoveryRefreshing && !skillsDiscoveryLoading && (skillsDiscovery?.skills.length ?? 0) === 0;
  const skillReposSyncingEmpty =
    skillReposManageRefreshing && !skillReposManageLoading && (skillReposManage?.repos.length ?? 0) === 0;

  const mcpSummaryText = useMemo(() => {
    if (!mcpManage) {
      return "已配置 0 个 MCP 服务器 · Claude: 0 · Codex: 0 · Gemini: 0 · OpenCode: 0";
    }
    return `已配置 ${mcpManage.total} 个 MCP 服务器 · Claude: ${mcpManage.claudeEnabledCount} · Codex: ${mcpManage.codexEnabledCount} · Gemini: ${mcpManage.geminiEnabledCount} · OpenCode: ${mcpManage.opencodeEnabledCount}`;
  }, [mcpManage]);

  const mcpSyncingEmpty =
    mcpManageRefreshing && !mcpManageLoading && (mcpManage?.servers.length ?? 0) === 0;

  useEffect(() => {
    if (activeToolView !== "skills") {
      return;
    }
    if (skillsCatalog || skillsLoading || skillsRefreshing) {
      return;
    }
    void loadSkillsCatalog(true);
  }, [activeToolView, loadSkillsCatalog, skillsCatalog, skillsLoading, skillsRefreshing]);

  useEffect(() => {
    if (activeToolView !== "skillsDiscovery") {
      return;
    }
    if (skillsDiscovery || skillsDiscoveryLoading || skillsDiscoveryRefreshing) {
      return;
    }
    void (async () => {
      await loadSkillsDiscovery(true, false);
      void loadSkillsDiscovery(false, true);
    })();
  }, [
    activeToolView,
    loadSkillsDiscovery,
    skillsDiscovery,
    skillsDiscoveryLoading,
    skillsDiscoveryRefreshing,
  ]);

  useEffect(() => {
    if (activeToolView !== "skillsRepos") {
      return;
    }
    if (skillReposManage || skillReposManageLoading || skillReposManageRefreshing) {
      return;
    }
    void (async () => {
      await loadSkillReposManage(true, false);
      void loadSkillReposManage(false, true);
    })();
  }, [
    activeToolView,
    loadSkillReposManage,
    skillReposManage,
    skillReposManageLoading,
    skillReposManageRefreshing,
  ]);

  useEffect(() => {
    if (activeToolView !== "mcp") {
      return;
    }
    if (mcpManage || mcpManageLoading || mcpManageRefreshing) {
      return;
    }
    void loadMcpManage(true);
  }, [activeToolView, loadMcpManage, mcpManage, mcpManageLoading, mcpManageRefreshing]);

  return {
    ...mcpActions,
    ...skillsActions,
    filteredDiscoverySkills,
    loadMcpManage,
    loadSkillReposManage,
    loadSkillsCatalog,
    loadSkillsDiscovery,
    mcpSummaryText,
    mcpSyncingEmpty,
    onRefreshMcpManage,
    onRefreshSkillsCatalog,
    skillReposSyncingEmpty,
    skillsDiscoverySummaryText,
    skillsDiscoverySyncingEmpty,
    skillsSummaryText,
  };
}
