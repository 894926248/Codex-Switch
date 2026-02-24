import { useCallback } from "react";
import {
  addSkillRepoCommand,
  deleteSkillCommand,
  installDiscoverySkillCommand,
  openExternalUrlCommand,
  removeSkillRepoCommand,
  setSkillTargetsCommand,
} from "../../../adapters/commands";
import { confirm, open } from "../../../adapters/tauri";
import { recomputeSkillsCatalog } from "../../../utils";

export function useSkillsPanelActions(ctx) {
  const {
    skillRepoBranch,
    skillRepoInput,
    setActiveToolView,
    setSkillRepoActionBusyKeys,
    setSkillRepoInput,
    setSkillReposManage,
    setSkillReposManageError,
    setSkillsBusyIds,
    setSkillsCatalog,
    setSkillsDiscovery,
    setSkillsDiscoveryInstallingIds,
    setSkillsError,
    setStatusText,
    loadSkillReposManage,
    loadSkillsCatalog,
    loadSkillsDiscovery,
  } = ctx;

  const onSkillsInstallFromZip = useCallback(async () => {
    try {
      const selectedPath = await open({
        title: "选择 Skills ZIP 包",
        multiple: false,
        directory: false,
        filters: [{ name: "ZIP", extensions: ["zip"] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) {
        return;
      }
      setStatusText(`已选择 ZIP: ${selectedPath}（当前版本暂未接入一键安装）`);
    } catch (err) {
      setStatusText(`读取 ZIP 失败: ${String(err)}`);
    }
  }, [setStatusText]);

  const onSkillsImportExisting = useCallback(async () => {
    await loadSkillsCatalog(false);
    setStatusText("已重新扫描本地 Skills。");
  }, [loadSkillsCatalog, setStatusText]);

  const onSkillsDiscover = useCallback(() => {
    setActiveToolView("skillsDiscovery");
  }, [setActiveToolView]);

  const onOpenSkillReposManage = useCallback(() => {
    setActiveToolView("skillsRepos");
  }, [setActiveToolView]);

  const onOpenDiscoverSkillReadme = useCallback(
    (skill) => {
      void (async () => {
        try {
          await openExternalUrlCommand(skill.readmeUrl);
          setStatusText(`已打开技能: ${skill.name}`);
        } catch (err) {
          setStatusText(`打开技能详情失败: ${String(err)}`);
        }
      })();
    },
    [setStatusText]
  );

  const onInstallDiscoverySkill = useCallback(
    async (skill) => {
      if (skill.installed) {
        return;
      }
      setSkillsDiscoveryInstallingIds((prev) => ({ ...prev, [skill.id]: true }));
      try {
        await installDiscoverySkillCommand({
          repoOwner: skill.repoOwner,
          repoName: skill.repoName,
          repoBranch: skill.repoBranch,
          repoDirectory: skill.repoDirectory,
          localDirectory: skill.directory,
          readmeUrl: skill.readmeUrl,
          name: skill.name,
          description: skill.description,
        });
        setSkillsDiscovery((prev) =>
          prev
            ? {
                ...prev,
                skills: prev.skills.map((item) =>
                  item.id === skill.id ? { ...item, installed: true } : item
                ),
              }
            : prev
        );
        setStatusText(`已安装技能: ${skill.name}`);
        void loadSkillsCatalog(false);
      } catch (err) {
        setStatusText(`安装技能失败: ${String(err)}`);
      } finally {
        setSkillsDiscoveryInstallingIds((prev) => {
          const next = { ...prev };
          delete next[skill.id];
          return next;
        });
      }
    },
    [setSkillsDiscoveryInstallingIds, setSkillsDiscovery, setStatusText, loadSkillsCatalog]
  );

  const onAddSkillRepo = useCallback(async () => {
    const repoInput = skillRepoInput.trim();
    if (!repoInput) {
      setSkillReposManageError("仓库 URL 不能为空。");
      return;
    }
    const busyKey = "__add__";
    setSkillRepoActionBusyKeys((prev) => ({ ...prev, [busyKey]: true }));
    try {
      const data = await addSkillRepoCommand(repoInput, skillRepoBranch.trim() || "main");
      setSkillReposManage(data);
      setSkillReposManageError(null);
      setSkillRepoInput("");
      setStatusText(`已添加仓库: ${repoInput}`);
      void loadSkillReposManage(false, true);
      void loadSkillsDiscovery(false, true);
    } catch (err) {
      setSkillReposManageError(`添加仓库失败: ${String(err)}`);
    } finally {
      setSkillRepoActionBusyKeys((prev) => {
        const next = { ...prev };
        delete next[busyKey];
        return next;
      });
    }
  }, [
    skillRepoInput,
    skillRepoBranch,
    setSkillReposManageError,
    setSkillRepoActionBusyKeys,
    setSkillReposManage,
    setSkillRepoInput,
    setStatusText,
    loadSkillReposManage,
    loadSkillsDiscovery,
  ]);

  const onRemoveSkillRepo = useCallback(
    async (repo) => {
      const key = `${repo.owner}/${repo.name}`;
      if (!window.confirm(`确定删除仓库 ${key} 吗？`)) {
        return;
      }
      setSkillRepoActionBusyKeys((prev) => ({ ...prev, [key]: true }));
      try {
        const data = await removeSkillRepoCommand(repo.owner, repo.name);
        setSkillReposManage(data);
        setSkillReposManageError(null);
        setStatusText(`已删除仓库: ${key}`);
        void loadSkillsDiscovery(false, false);
      } catch (err) {
        setSkillReposManageError(`删除仓库失败: ${String(err)}`);
      } finally {
        setSkillRepoActionBusyKeys((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [
      setSkillRepoActionBusyKeys,
      setSkillReposManage,
      setSkillReposManageError,
      setStatusText,
      loadSkillsDiscovery,
    ]
  );

  const onOpenRepoHome = useCallback(
    (repo) => {
      void (async () => {
        try {
          await openExternalUrlCommand(repo.repoUrl);
          setStatusText(`已打开仓库: ${repo.owner}/${repo.name}`);
        } catch (err) {
          setStatusText(`打开仓库失败: ${String(err)}`);
        }
      })();
    },
    [setStatusText]
  );

  const onToggleSkillTarget = useCallback(
    async (skill, target) => {
      const nextClaude = target === "claude" ? !skill.claudeEnabled : skill.claudeEnabled;
      const nextCodex = target === "codex" ? !skill.codexEnabled : skill.codexEnabled;
      const nextGemini = target === "gemini" ? !skill.geminiEnabled : skill.geminiEnabled;
      const nextOpenCode = target === "opencode" ? !skill.opencodeEnabled : skill.opencodeEnabled;
      setSkillsBusyIds((prev) => ({ ...prev, [skill.id]: true }));
      setSkillsCatalog((prev) => {
        if (!prev) {
          return prev;
        }
        const optimistic = {
          ...prev,
          skills: prev.skills.map((item) =>
            item.id === skill.id
              ? {
                  ...item,
                  claudeEnabled: nextClaude,
                  codexEnabled: nextCodex,
                  geminiEnabled: nextGemini,
                  opencodeEnabled: nextOpenCode,
                }
              : item
          ),
        };
        return recomputeSkillsCatalog(optimistic);
      });
      try {
        const data = await setSkillTargetsCommand({
          skillId: skill.id,
          claude: nextClaude,
          codex: nextCodex,
          gemini: nextGemini,
          opencode: nextOpenCode,
        });
        setSkillsCatalog(recomputeSkillsCatalog(data));
        setSkillsError(null);
      } catch (err) {
        setSkillsError(`更新 Skills 开关失败: ${String(err)}`);
        await loadSkillsCatalog(false);
      } finally {
        setSkillsBusyIds((prev) => {
          const next = { ...prev };
          delete next[skill.id];
          return next;
        });
      }
    },
    [setSkillsBusyIds, setSkillsCatalog, setSkillsError, loadSkillsCatalog]
  );

  const onDeleteSkill = useCallback(
    async (skill) => {
      const approved = await confirm(`确定删除技能 "${skill.name}" 吗？\n将从 Codex / OpenCode / 本地 Skills 中移除。`, {
        title: "删除技能",
        kind: "warning",
        okLabel: "删除",
        cancelLabel: "取消",
      });
      if (!approved) {
        return;
      }
      setSkillsBusyIds((prev) => ({ ...prev, [skill.id]: true }));
      try {
        const data = await deleteSkillCommand(skill.id);
        setSkillsCatalog(recomputeSkillsCatalog(data));
        setSkillsError(null);
        setStatusText(`已删除技能: ${skill.name}`);
        setSkillsDiscovery((prev) =>
          prev
            ? {
                ...prev,
                skills: prev.skills.map((item) =>
                  item.directory.toLowerCase() === skill.directory.toLowerCase()
                    ? { ...item, installed: false }
                    : item
                ),
              }
            : prev
        );
      } catch (err) {
        setSkillsError(`删除技能失败: ${String(err)}`);
      } finally {
        setSkillsBusyIds((prev) => {
          const next = { ...prev };
          delete next[skill.id];
          return next;
        });
      }
    },
    [setSkillsBusyIds, setSkillsCatalog, setSkillsError, setStatusText, setSkillsDiscovery]
  );

  return {
    onAddSkillRepo,
    onDeleteSkill,
    onInstallDiscoverySkill,
    onOpenDiscoverSkillReadme,
    onOpenRepoHome,
    onOpenSkillReposManage,
    onRemoveSkillRepo,
    onSkillsDiscover,
    onSkillsImportExisting,
    onSkillsInstallFromZip,
    onToggleSkillTarget,
  };
}
