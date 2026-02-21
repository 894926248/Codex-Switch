import { jsx, jsxs } from "react/jsx-runtime";
import { ArrowLeft, Download, ExternalLink, Plus, RefreshCw, Server, Trash2 } from "lucide-react";

export function renderMcpView(props) {
  const {
    mcpBusyIds,
    mcpManage,
    mcpManageError,
    mcpManageLoading,
    mcpManageRefreshing,
    mcpSummaryText,
    mcpSyncingEmpty,
    onImportExistingMcp,
    onOpenMcpDoc,
    onRefreshMcpManage,
    onRemoveMcpServer,
    onToggleMcpTarget,
    openMcpAddPage,
    openaiLogo,
    opencodeLogo,
    setActiveToolView,
    SkillTargetSwitch,
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
          /* @__PURE__ */ jsx("h1", { className: "skills-inline-title", children: "MCP 服务器管理" })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "skills-page-actions", children: [
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "skills-head-action",
              disabled: mcpManageLoading || mcpManageRefreshing,
              onClick: () => void onRefreshMcpManage(),
              title: mcpManageRefreshing ? "MCP 刷新中..." : "刷新 MCP",
              "aria-label": mcpManageRefreshing ? "MCP 刷新中" : "刷新 MCP",
              children: [
                /* @__PURE__ */ jsx(RefreshCw, { className: `skills-head-action-icon ${mcpManageRefreshing ? "icon-spin" : ""}` }),
                mcpManageRefreshing ? "刷新中..." : "刷新"
              ]
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "skills-head-action",
              disabled: mcpManageRefreshing,
              onClick: () => void onImportExistingMcp(),
              children: [
                /* @__PURE__ */ jsx(Download, { className: "skills-head-action-icon" }),
                "导入已有"
              ]
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "skills-head-action",
              disabled: mcpManageRefreshing,
              onClick: () => openMcpAddPage(),
              children: [
                /* @__PURE__ */ jsx(Plus, { className: "skills-head-action-icon" }),
                "新增MCP"
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsx("section", { className: "skills-inline-summary", children: mcpSummaryText })
    ] }),
    mcpManageError ? /* @__PURE__ */ jsx("section", { className: "skills-inline-error", children: mcpManageError }) : null,
    mcpManageLoading ? /* @__PURE__ */ jsx("section", { className: "skills-inline-empty", children: "正在读取 MCP 服务器..." }) : mcpSyncingEmpty ? /* @__PURE__ */ jsxs("section", { className: "skills-inline-empty skills-inline-loading", children: [
      /* @__PURE__ */ jsx("span", { className: "status-spinner", "aria-hidden": true }),
      /* @__PURE__ */ jsx("span", { children: "正在同步 MCP 配置，请稍候..." })
    ] }) : !mcpManage?.servers.length ? /* @__PURE__ */ jsxs("section", { className: "skills-inline-empty mcp-inline-empty", children: [
      /* @__PURE__ */ jsx("span", { className: "mcp-empty-icon-wrap", children: /* @__PURE__ */ jsx(Server, { className: "mcp-empty-icon" }) }),
      /* @__PURE__ */ jsx("span", { className: "mcp-empty-title", children: "暂无服务器" }),
      /* @__PURE__ */ jsx("span", { className: "mcp-empty-text", children: "点击右上角按钮添加第一个 MCP 服务器" })
    ] }) : /* @__PURE__ */ jsx("section", { className: "skills-inline-list", children: mcpManage.servers.map((server) => {
      const busy2 = !!mcpBusyIds[server.id];
      const hasDocLink = !!server.docUrl;
      return /* @__PURE__ */ jsxs("article", { className: "skills-inline-item", children: [
        /* @__PURE__ */ jsxs("div", { className: "skills-inline-main", children: [
          /* @__PURE__ */ jsx("h2", { children: server.name || server.id }),
          /* @__PURE__ */ jsx("p", { children: server.description }),
          /* @__PURE__ */ jsxs("div", { className: "skills-inline-meta", children: [
            /* @__PURE__ */ jsx("span", { className: "skills-inline-pill", children: server.kind ? server.kind.toUpperCase() : "MCP" }),
            /* @__PURE__ */ jsx("span", { className: "skills-inline-pill", children: server.source }),
            hasDocLink ? /* @__PURE__ */ jsxs(
              "button",
              {
                type: "button",
                className: "skills-inline-link-btn",
                onClick: () => onOpenMcpDoc(server),
                title: server.docUrl || server.endpointUrl || "",
                children: [
                  /* @__PURE__ */ jsx(ExternalLink, { className: "skills-inline-link-icon" }),
                  "文档"
                ]
              }
            ) : null
          ] }),
          /* @__PURE__ */ jsx("div", { className: "skills-inline-path", title: server.id, children: server.id })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "skills-inline-targets", children: [
          /* @__PURE__ */ jsx(
            SkillTargetSwitch,
            {
              label: "Claude",
              checked: server.claudeEnabled,
              busy: busy2,
              onClick: () => void onToggleMcpTarget(server, "claude")
            }
          ),
          /* @__PURE__ */ jsx(
            SkillTargetSwitch,
            {
              label: "Codex",
              icon: openaiLogo,
              checked: server.codexEnabled,
              busy: busy2 || !server.codexAvailable,
              onClick: () => void onToggleMcpTarget(server, "codex")
            }
          ),
          /* @__PURE__ */ jsx(
            SkillTargetSwitch,
            {
              label: "Gemini",
              checked: server.geminiEnabled,
              busy: busy2,
              onClick: () => void onToggleMcpTarget(server, "gemini")
            }
          ),
          /* @__PURE__ */ jsx(
            SkillTargetSwitch,
            {
              label: "OpenCode",
              icon: opencodeLogo,
              checked: server.opencodeEnabled,
              busy: busy2 || !server.opencodeAvailable,
              onClick: () => void onToggleMcpTarget(server, "opencode")
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "skill-delete-btn",
              disabled: busy2,
              onClick: () => void onRemoveMcpServer(server),
              title: "删除该 MCP 服务器",
              children: [
                /* @__PURE__ */ jsx(Trash2, { className: "skill-delete-btn-icon" }),
                "删除"
              ]
            }
          )
        ] })
      ] }, server.id);
    }) })
  ] });
}
