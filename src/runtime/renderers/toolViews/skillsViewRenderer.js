import { jsx, jsxs } from "react/jsx-runtime";
import {
  ArrowLeft,
  Download,
  FileArchive,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  ExternalLink,
} from "lucide-react";

export function renderSkillsView(props) {
  const {
    loadSkillReposManage,
    loadSkillsDiscovery,
    onAddSkillRepo,
    onDeleteSkill,
    onInstallDiscoverySkill,
    onOpenDiscoverSkillReadme,
    onOpenRepoHome,
    onOpenSkillReposManage,
    onRefreshSkillsCatalog,
    onRemoveSkillRepo,
    onSkillsDiscover,
    onSkillsImportExisting,
    onSkillsInstallFromZip,
    onToggleSkillTarget,
    openaiLogo,
    opencodeLogo,
    setActiveToolView,
    setSkillRepoBranch,
    setSkillRepoInput,
    setSkillsDiscoveryInstallFilter,
    setSkillsDiscoveryKeyword,
    skillRepoActionBusyKeys,
    skillRepoBranch,
    skillRepoInput,
    skillReposManage,
    skillReposManageError,
    skillReposManageLoading,
    skillReposManageRefreshing,
    skillReposSyncingEmpty,
    skillsBusyIds,
    skillsCatalog,
    skillsDiscoveryError,
    skillsDiscoveryInstallFilter,
    skillsDiscoveryInstallingIds,
    skillsDiscoveryKeyword,
    skillsDiscoveryLoading,
    skillsDiscoveryRefreshing,
    skillsDiscoverySummaryText,
    skillsDiscoverySyncingEmpty,
    skillsError,
    skillsLoading,
    skillsRefreshing,
    skillsSummaryText,
    SkillTargetSwitch,
    filteredDiscoverySkills,
  } = props;

  return /* @__PURE__ */ jsxs("main", { className: "tools-pane-wrap tools-pane-wrap-sticky-head", children: [
    /* @__PURE__ */ jsxs("div", { className: "tools-pane-sticky-head", children: [
      /* @__PURE__ */ jsxs("section", { className: "skills-page-header", children: [
        /* @__PURE__ */ jsxs("div", { className: "skills-page-left", children: [
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              className: "skills-back-btn",
              onClick: () => setActiveToolView("dashboard"),
              title: "返回账号列表",
              "aria-label": "返回账号列表",
              children: /* @__PURE__ */ jsx(ArrowLeft, { className: "skills-back-icon" })
            }
          ),
          /* @__PURE__ */ jsx("h1", { className: "skills-inline-title", children: "Skills 管理" })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "skills-page-actions", children: [
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "skills-head-action",
              disabled: skillsLoading || skillsRefreshing,
              onClick: () => void onRefreshSkillsCatalog(),
              title: skillsRefreshing ? "Skills 刷新中..." : "刷新 Skills",
              "aria-label": skillsRefreshing ? "Skills 刷新中" : "刷新 Skills",
              children: [
                /* @__PURE__ */ jsx(RefreshCw, { className: `skills-head-action-icon ${skillsRefreshing ? "icon-spin" : ""}` }),
                skillsRefreshing ? "刷新中..." : "刷新"
              ]
            }
          ),
          /* @__PURE__ */ jsxs("button", { type: "button", className: "skills-head-action", onClick: () => void onSkillsInstallFromZip(), children: [
            /* @__PURE__ */ jsx(FileArchive, { className: "skills-head-action-icon" }),
            "从 ZIP 安装"
          ] }),
          /* @__PURE__ */ jsxs("button", { type: "button", className: "skills-head-action", onClick: () => void onSkillsImportExisting(), children: [
            /* @__PURE__ */ jsx(Download, { className: "skills-head-action-icon" }),
            "导入已有"
          ] }),
          /* @__PURE__ */ jsxs("button", { type: "button", className: "skills-head-action", onClick: () => void onSkillsDiscover(), children: [
            /* @__PURE__ */ jsx(Search, { className: "skills-head-action-icon" }),
            "发现技能"
          ] })
        ] })
      ] }),
      /* @__PURE__ */ jsx("section", { className: "skills-inline-summary", children: skillsSummaryText })
    ] }),
    skillsError ? /* @__PURE__ */ jsx("section", { className: "skills-inline-error", children: skillsError }) : null,
    skillsLoading ? /* @__PURE__ */ jsx("section", { className: "skills-inline-empty", children: "正在读取本地 Skills..." }) : skillsCatalog && skillsCatalog.skills.length === 0 ? /* @__PURE__ */ jsx("section", { className: "skills-inline-empty", children: "未找到 Skills，请检查 `~/.cc-switch/skills`、`~/.codex/skills`、`~/.config/opencode/skills`。" }) : /* @__PURE__ */ jsx("section", { className: "skills-inline-list", children: skillsCatalog?.skills.map((skill) => {
      const busy2 = !!skillsBusyIds[skill.id];
      const codexAvailable = skill.codexAvailable;
      const opencodeAvailable = skill.opencodeAvailable;
      return /* @__PURE__ */ jsxs("article", { className: "skills-inline-item", children: [
        /* @__PURE__ */ jsxs("div", { className: "skills-inline-main", children: [
          /* @__PURE__ */ jsx("h2", { children: skill.name }),
          /* @__PURE__ */ jsx("p", { children: skill.description }),
          /* @__PURE__ */ jsxs("div", { className: "skills-inline-meta", children: [
            /* @__PURE__ */ jsx("span", { className: "skills-inline-pill", children: "本地" }),
            /* @__PURE__ */ jsx("span", { className: "skills-inline-pill", children: skill.source })
          ] }),
          /* @__PURE__ */ jsx("div", { className: "skills-inline-path", title: skill.locations.join("\n"), children: skill.locations.join(" | ") })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "skills-inline-targets", children: [
          /* @__PURE__ */ jsx(
            SkillTargetSwitch,
            {
              label: "Claude",
              checked: skill.claudeEnabled,
              busy: busy2,
              onClick: () => void onToggleSkillTarget(skill, "claude")
            }
          ),
          /* @__PURE__ */ jsx(
            SkillTargetSwitch,
            {
              label: "Codex",
              icon: openaiLogo,
              checked: skill.codexEnabled,
              busy: busy2 || !codexAvailable,
              onClick: () => void onToggleSkillTarget(skill, "codex")
            }
          ),
          /* @__PURE__ */ jsx(
            SkillTargetSwitch,
            {
              label: "Gemini",
              checked: skill.geminiEnabled,
              busy: busy2,
              onClick: () => void onToggleSkillTarget(skill, "gemini")
            }
          ),
          /* @__PURE__ */ jsx(
            SkillTargetSwitch,
            {
              label: "OpenCode",
              icon: opencodeLogo,
              checked: skill.opencodeEnabled,
              busy: busy2 || !opencodeAvailable,
              onClick: () => void onToggleSkillTarget(skill, "opencode")
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "skill-delete-btn",
              disabled: busy2,
              onClick: () => void onDeleteSkill(skill),
              title: "删除该技能",
              children: [
                /* @__PURE__ */ jsx(Trash2, { className: "skill-delete-btn-icon" }),
                "删除"
              ]
            }
          )
        ] })
      ] }, skill.id);
    }) })
  ] });
}

export function renderSkillsDiscoveryView(props) {
  const {
    loadSkillsDiscovery,
    onInstallDiscoverySkill,
    onOpenDiscoverSkillReadme,
    onOpenSkillReposManage,
    setActiveToolView,
    setSkillsDiscoveryInstallFilter,
    setSkillsDiscoveryKeyword,
    skillsDiscoveryError,
    skillsDiscoveryInstallFilter,
    skillsDiscoveryInstallingIds,
    skillsDiscoveryKeyword,
    skillsDiscoveryLoading,
    skillsDiscoveryRefreshing,
    skillsDiscoverySummaryText,
    skillsDiscoverySyncingEmpty,
    filteredDiscoverySkills,
  } = props;

  return /* @__PURE__ */ jsxs("main", { className: "tools-pane-wrap", children: [
    /* @__PURE__ */ jsxs("section", { className: "skills-page-header", children: [
      /* @__PURE__ */ jsxs("div", { className: "skills-page-left", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "skills-back-btn",
            onClick: () => setActiveToolView("skills"),
            title: "返回 Skills 管理",
            "aria-label": "返回 Skills 管理",
            children: /* @__PURE__ */ jsx(ArrowLeft, { className: "skills-back-icon" })
          }
        ),
        /* @__PURE__ */ jsx("h1", { className: "skills-inline-title", children: "Skills 发现" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "skills-page-actions", children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            className: "skills-head-action",
            disabled: skillsDiscoveryRefreshing,
            onClick: () => void loadSkillsDiscovery(false, true),
            children: [
              /* @__PURE__ */ jsx(RefreshCw, { className: "skills-head-action-icon" }),
              "刷新"
            ]
          }
        ),
        /* @__PURE__ */ jsxs("button", { type: "button", className: "skills-head-action", onClick: () => void onOpenSkillReposManage(), children: [
          /* @__PURE__ */ jsx(Settings, { className: "skills-head-action-icon" }),
          "仓库管理"
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsx("section", { className: "skills-inline-summary", children: skillsDiscoverySummaryText }),
    /* @__PURE__ */ jsxs("section", { className: "skills-discovery-toolbar", children: [
      /* @__PURE__ */ jsxs("label", { className: "skills-discovery-search", children: [
        /* @__PURE__ */ jsx(Search, { className: "skills-discovery-search-icon" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: skillsDiscoveryKeyword,
            onChange: (event) => setSkillsDiscoveryKeyword(event.target.value),
            placeholder: "搜索技能名称或描述..."
          }
        )
      ] }),
      /* @__PURE__ */ jsx("label", { className: "skills-discovery-filter", children: /* @__PURE__ */ jsxs("div", { className: "skills-discovery-select-wrap", children: [
        /* @__PURE__ */ jsxs(
          "select",
          {
            value: skillsDiscoveryInstallFilter,
            onChange: (event) => setSkillsDiscoveryInstallFilter(event.target.value),
            children: [
              /* @__PURE__ */ jsx("option", { value: "all", children: "全部" }),
              /* @__PURE__ */ jsx("option", { value: "installed", children: "已安装" }),
              /* @__PURE__ */ jsx("option", { value: "notInstalled", children: "未安装" })
            ]
          }
        ),
        /* @__PURE__ */ jsx(ChevronDown, { className: "skills-discovery-select-icon" })
      ] }) })
    ] }),
    skillsDiscoveryError ? /* @__PURE__ */ jsx("section", { className: "skills-inline-error", children: skillsDiscoveryError }) : null,
    skillsDiscoveryLoading ? /* @__PURE__ */ jsx("section", { className: "skills-inline-empty", children: "正在读取发现技能..." }) : skillsDiscoverySyncingEmpty ? /* @__PURE__ */ jsxs("section", { className: "skills-inline-empty skills-inline-loading", children: [
      /* @__PURE__ */ jsx("span", { className: "status-spinner", "aria-hidden": true }),
      /* @__PURE__ */ jsx("span", { children: "正在同步发现技能，请稍候..." })
    ] }) : filteredDiscoverySkills.length === 0 ? /* @__PURE__ */ jsx("section", { className: "skills-inline-empty", children: "当前筛选条件下没有可展示的技能。" }) : /* @__PURE__ */ jsx("section", { className: "skills-discovery-grid", children: filteredDiscoverySkills.map((skill) => /* @__PURE__ */ jsxs("article", { className: "skills-discovery-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "skills-discovery-card-main", children: [
        /* @__PURE__ */ jsx("h2", { children: skill.name }),
        /* @__PURE__ */ jsxs("span", { className: "skills-discovery-repo-pill", children: [
          skill.repoOwner,
          "/",
          skill.repoName
        ] }),
        /* @__PURE__ */ jsx("p", { children: skill.description })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "skills-discovery-card-actions", children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            className: "skills-discovery-btn ghost",
            onClick: () => void onOpenDiscoverSkillReadme(skill),
            children: [
              /* @__PURE__ */ jsx(ExternalLink, { className: "skills-discovery-btn-icon" }),
              "查看"
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            className: "skills-discovery-btn install",
            disabled: skill.installed || !!skillsDiscoveryInstallingIds[skill.id],
            onClick: () => void onInstallDiscoverySkill(skill),
            title: skill.installed ? "已安装" : "安装到 Codex/OpenCode 并同步到 CC 数据库",
            children: [
              /* @__PURE__ */ jsx(Download, { className: "skills-discovery-btn-icon" }),
              skillsDiscoveryInstallingIds[skill.id] ? "安装中..." : skill.installed ? "已安装" : "安装"
            ]
          }
        )
      ] })
    ] }, skill.id)) })
  ] });
}

export function renderSkillsReposView(props) {
  const {
    loadSkillReposManage,
    onAddSkillRepo,
    onOpenRepoHome,
    onRemoveSkillRepo,
    setActiveToolView,
    setSkillRepoBranch,
    setSkillRepoInput,
    skillRepoActionBusyKeys,
    skillRepoBranch,
    skillRepoInput,
    skillReposManage,
    skillReposManageError,
    skillReposManageLoading,
    skillReposManageRefreshing,
    skillReposSyncingEmpty,
  } = props;

  return /* @__PURE__ */ jsxs("main", { className: "tools-pane-wrap", children: [
    /* @__PURE__ */ jsxs("section", { className: "skills-page-header", children: [
      /* @__PURE__ */ jsxs("div", { className: "skills-page-left", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "skills-back-btn",
            onClick: () => setActiveToolView("skillsDiscovery"),
            title: "返回 Skills 发现",
            "aria-label": "返回 Skills 发现",
            children: /* @__PURE__ */ jsx(ArrowLeft, { className: "skills-back-icon" })
          }
        ),
        /* @__PURE__ */ jsx("h1", { className: "skills-inline-title", children: "管理技能仓库" })
      ] }),
      /* @__PURE__ */ jsx("div", { className: "skills-page-actions", children: /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          className: "skills-head-action",
          disabled: skillReposManageRefreshing,
          onClick: () => void loadSkillReposManage(false, true),
          children: [
            /* @__PURE__ */ jsx(RefreshCw, { className: "skills-head-action-icon" }),
            "刷新"
          ]
        }
      ) })
    ] }),
    /* @__PURE__ */ jsxs("section", { className: "skill-repo-form-panel", children: [
      /* @__PURE__ */ jsx("h2", { children: "添加技能仓库" }),
      /* @__PURE__ */ jsxs("label", { className: "skill-repo-form-label", children: [
        /* @__PURE__ */ jsx("span", { children: "仓库 URL" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: skillRepoInput,
            onChange: (event) => setSkillRepoInput(event.target.value),
            placeholder: "owner/name 或 https://github.com/owner/name"
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "skill-repo-form-label", children: [
        /* @__PURE__ */ jsx("span", { children: "分支" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: skillRepoBranch,
            onChange: (event) => setSkillRepoBranch(event.target.value),
            placeholder: "main"
          }
        )
      ] }),
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          className: "skill-repo-add-btn",
          disabled: !!skillRepoActionBusyKeys.__add__,
          onClick: () => void onAddSkillRepo(),
          children: [
            /* @__PURE__ */ jsx(Plus, { className: "skill-repo-add-icon" }),
            "添加仓库"
          ]
        }
      )
    ] }),
    skillReposManageError ? /* @__PURE__ */ jsx("section", { className: "skills-inline-error", children: skillReposManageError }) : null,
    /* @__PURE__ */ jsxs("section", { className: "skill-repo-list-panel", children: [
      /* @__PURE__ */ jsx("h2", { children: "已添加的仓库" }),
      skillReposManageLoading ? /* @__PURE__ */ jsx("section", { className: "skills-inline-empty", children: "正在读取仓库..." }) : skillReposSyncingEmpty ? /* @__PURE__ */ jsxs("section", { className: "skills-inline-empty skills-inline-loading", children: [
        /* @__PURE__ */ jsx("span", { className: "status-spinner", "aria-hidden": true }),
        /* @__PURE__ */ jsx("span", { children: "正在同步仓库信息，请稍候..." })
      ] }) : !skillReposManage?.repos.length ? /* @__PURE__ */ jsx("section", { className: "skills-inline-empty", children: "暂无仓库，先在上方添加一个。" }) : /* @__PURE__ */ jsx("div", { className: "skill-repo-list", children: skillReposManage.repos.map((repo) => {
        const rowKey = `${repo.owner}/${repo.name}`;
        const busy2 = !!skillRepoActionBusyKeys[rowKey];
        return /* @__PURE__ */ jsxs("article", { className: "skill-repo-item", children: [
          /* @__PURE__ */ jsxs("div", { className: "skill-repo-item-main", children: [
            /* @__PURE__ */ jsx("div", { className: "skill-repo-item-title", children: rowKey }),
            /* @__PURE__ */ jsxs("div", { className: "skill-repo-item-meta", children: [
              /* @__PURE__ */ jsxs("span", { className: "skill-repo-meta-branch", children: [
                "分支: ",
                repo.branch
              ] }),
              repo.skillCount !== void 0 && repo.skillCount !== null ? /* @__PURE__ */ jsxs("span", { className: "skill-repo-meta-count-chip", children: [
                "识别到 ",
                repo.skillCount,
                " 个技能"
              ] }) : null
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "skill-repo-item-actions", children: [
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                className: "skill-repo-item-btn",
                disabled: busy2,
                onClick: () => void onOpenRepoHome(repo),
                title: "打开仓库",
                children: /* @__PURE__ */ jsx(ExternalLink, { className: "skill-repo-item-btn-icon" })
              }
            ),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                className: "skill-repo-item-btn danger",
                disabled: busy2,
                onClick: () => void onRemoveSkillRepo(repo),
                title: "删除仓库",
                children: /* @__PURE__ */ jsx(Trash2, { className: "skill-repo-item-btn-icon" })
              }
            )
          ] })
        ] }, rowKey);
      }) })
    ] })
  ] });
}
