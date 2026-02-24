import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Book, Wrench } from "lucide-react";

export function renderDashboardHeader(props) {
  const {
    activeAppMode,
    activeToolView,
    autoKeepalive,
    autoRefreshOnStartup,
    autoSeamlessSwitch,
    onAddByLogin,
    onKeepaliveNow,
    onRefreshAllQuota,
    onReloadVsCode,
    quotaQuerying,
    setActiveToolView,
    setAutoKeepalive,
    setAutoRefreshOnStartup,
    setAutoSeamlessSwitch,
    setSettingsOpen,
    switchAppMode,
    uiBusy,
    vscodeStatus,
    McpIcon,
    openaiLogo,
    opencodeLogo,
    vscodeLogo,
  } = props;

  if (activeToolView !== "dashboard") {
    return null;
  }

  return /* @__PURE__ */ jsxs("header", { className: "top-bar", children: [
    /* @__PURE__ */ jsxs("div", { className: "top-left", children: [
      /* @__PURE__ */ jsx("img", { className: "brand-logo", src: openaiLogo, alt: "", "aria-hidden": true }),
      /* @__PURE__ */ jsx("div", { className: "brand", children: "Codex Switch" }),
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "header-icon",
          disabled: uiBusy,
          onClick: () => void onRefreshAllQuota(true),
          title: quotaQuerying ? "配额查询中..." : "刷新全部额度",
          "aria-label": quotaQuerying ? "配额查询中" : "刷新全部额度",
          children: /* @__PURE__ */ jsx("span", { className: quotaQuerying ? "icon-spin" : void 0, "aria-hidden": true, children: "↻" })
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "header-icon",
          disabled: uiBusy,
          onClick: () => void onKeepaliveNow(),
          title: "手动保活（刷新全部账号 Token）",
          "aria-label": "手动保活",
          children: /* @__PURE__ */ jsx("span", { "aria-hidden": true, children: "🔑" })
        }
      )
    ] }),
    /* @__PURE__ */ jsx("div", { className: "top-center", children: /* @__PURE__ */ jsxs("div", { className: "app-switcher", role: "tablist", "aria-label": "应用切换", children: [
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": activeAppMode === "gpt",
          className: `app-switch-btn ${activeAppMode === "gpt" ? "active" : ""}`,
          onClick: () => switchAppMode("gpt"),
          disabled: uiBusy,
          children: [
            /* @__PURE__ */ jsx("img", { className: "app-switch-icon", src: vscodeLogo, alt: "", "aria-hidden": true }),
            /* @__PURE__ */ jsx("span", { children: "VSCode" })
          ]
        }
      ),
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": activeAppMode === "opencode",
          className: `app-switch-btn ${activeAppMode === "opencode" ? "active" : ""}`,
          onClick: () => switchAppMode("opencode"),
          disabled: uiBusy,
          children: [
            /* @__PURE__ */ jsx("img", { className: "app-switch-icon", src: opencodeLogo, alt: "", "aria-hidden": true }),
            /* @__PURE__ */ jsx("span", { children: "OpenCode" })
          ]
        }
      )
    ] }) }),
    /* @__PURE__ */ jsxs("div", { className: "top-right", children: [
      /* @__PURE__ */ jsxs(
        "label",
        {
          className: "keepalive-switch startup-refresh-switch",
          title: autoRefreshOnStartup ? "启动时自动刷新配额已开启" : "启动时自动刷新配额已关闭",
          children: [
            /* @__PURE__ */ jsx("span", { className: `startup-refresh-icon ${autoRefreshOnStartup ? "active" : ""}`, "aria-hidden": true, children: "↻" }),
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "checkbox",
                checked: autoRefreshOnStartup,
                onChange: (e) => setAutoRefreshOnStartup(e.target.checked),
                disabled: uiBusy,
                "aria-label": "启动自动刷新全部配额"
              }
            ),
            /* @__PURE__ */ jsx("span", { className: "switch-track", children: /* @__PURE__ */ jsx("span", { className: "switch-knob" }) })
          ]
        }
      ),
      /* @__PURE__ */ jsxs(
        "label",
        {
          className: "keepalive-switch seamless-switch",
          title: autoSeamlessSwitch ? "无感换号已开启（实时监控）" : "无感换号已关闭",
          children: [
            /* @__PURE__ */ jsx("span", { className: `seamless-icon ${autoSeamlessSwitch ? "active" : ""}`, "aria-hidden": true, children: /* @__PURE__ */ jsxs(
              "svg",
              {
                className: "seamless-icon-glyph",
                viewBox: "0 0 24 24",
                fill: "none",
                xmlns: "http://www.w3.org/2000/svg",
                children: [
                  /* @__PURE__ */ jsx("path", { d: "M16 3H21V8" }),
                  /* @__PURE__ */ jsx("path", { d: "M4 20L21 3" }),
                  /* @__PURE__ */ jsx("path", { d: "M21 16V21H16" }),
                  /* @__PURE__ */ jsx("path", { d: "M15 15L21 21" }),
                  /* @__PURE__ */ jsx("path", { d: "M4 4L9 9" })
                ]
              }
            ) }),
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "checkbox",
                checked: autoSeamlessSwitch,
                onChange: (e) => setAutoSeamlessSwitch(e.target.checked),
                disabled: uiBusy,
                "aria-label": "自动无感换号"
              }
            ),
            /* @__PURE__ */ jsx("span", { className: "switch-track", children: /* @__PURE__ */ jsx("span", { className: "switch-knob" }) })
          ]
        }
      ),
      /* @__PURE__ */ jsxs(
        "label",
        {
          className: "keepalive-switch",
          title: autoKeepalive ? "自动保活已开启（48h + 错峰）" : "自动保活已关闭",
          children: [
            /* @__PURE__ */ jsxs("span", { className: `keepalive-icon ${autoKeepalive ? "active" : ""}`, "aria-hidden": true, children: [
              /* @__PURE__ */ jsx("span", { className: "dot" }),
              /* @__PURE__ */ jsx("span", { className: "ring ring-1" }),
              /* @__PURE__ */ jsx("span", { className: "ring ring-2" })
            ] }),
            /* @__PURE__ */ jsx(
              "input",
              {
                type: "checkbox",
                checked: autoKeepalive,
                onChange: (e) => setAutoKeepalive(e.target.checked),
                disabled: uiBusy,
                "aria-label": "自动保活(48h)"
              }
            ),
            /* @__PURE__ */ jsx("span", { className: "switch-track", children: /* @__PURE__ */ jsx("span", { className: "switch-knob" }) })
          ]
        }
      ),
      /* @__PURE__ */ jsxs("div", { className: "top-tool-group", role: "group", "aria-label": "工具面板切换", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "top-tool-btn",
            onClick: () => setActiveToolView("skills"),
            title: "Skills 管理",
            "aria-label": "Skills 管理",
            children: /* @__PURE__ */ jsx(Wrench, { className: "tool-icon-lucide" })
          }
        ),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "top-tool-btn",
            onClick: () => setActiveToolView("prompts"),
            title: "Prompts 面板",
            "aria-label": "Prompts 面板",
            children: /* @__PURE__ */ jsx(Book, { className: "tool-icon-lucide" })
          }
        ),
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: "top-tool-btn",
            onClick: () => setActiveToolView("mcp"),
            title: "MCP 服务器管理",
            "aria-label": "MCP 服务器管理",
            children: /* @__PURE__ */ jsx(McpIcon, { className: "tool-icon-lucide", size: 16 })
          }
        )
      ] }),
      /* @__PURE__ */ jsx("button", { className: "header-icon", disabled: uiBusy, onClick: () => setSettingsOpen(true), title: "设置中心", children: "⚙" }),
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "header-icon",
          disabled: uiBusy || vscodeStatus?.running === false,
          onClick: () => void onReloadVsCode(),
          title: vscodeStatus?.running === false ? "未检测到 VS Code 运行" : "刷新 VS Code",
          children: "◫"
        }
      ),
      /* @__PURE__ */ jsx(
        "button",
        {
          className: "add-btn",
          disabled: uiBusy,
          onClick: () => void onAddByLogin(),
          title: "添加账号",
          "aria-label": "添加账号"
        }
      )
    ] })
  ] });
}

export function renderDashboardMain(props) {
  const {
    activeAppMode,
    activeToolView,
    currentLine,
    dashboard,
    displayCurrentErrorText,
    filteredProfiles,
    initialLoading,
    liveQueryProfileName,
    liveQuotaMergeTargetName,
    modeActiveProfileName,
    modeCurrent,
    onApplySelected,
    onDeleteSelected,
    onDragEnd,
    onRefreshSelectedQuota,
    onSetAlias,
    profileIds,
    quotaQuerying,
    refreshingProfileNameSet,
    selected,
    sensors,
    setSelected,
    SortableProfileCard,
    uiBusy,
  } = props;

  if (activeToolView !== "dashboard") {
    return null;
  }

  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("section", { className: "summary", children: currentLine }),
    quotaQuerying ? /* @__PURE__ */ jsxs("section", { className: "quota-querying", "aria-live": "polite", children: [
      /* @__PURE__ */ jsx("span", { className: "status-spinner", "aria-hidden": true }),
      /* @__PURE__ */ jsx("span", { children: "配额查询中..." })
    ] }) : null,
    !initialLoading && displayCurrentErrorText ? /* @__PURE__ */ jsxs("div", { className: "error-banner", children: [
      "当前账号读取失败: ",
      displayCurrentErrorText
    ] }) : null,
    /* @__PURE__ */ jsx("main", { className: "cards-wrap", children: initialLoading ? /* @__PURE__ */ jsxs("div", { className: "loading-panel", children: [
      /* @__PURE__ */ jsx("span", { className: "loading-spinner", "aria-hidden": true }),
      /* @__PURE__ */ jsx("span", { className: "loading-text", children: "账号加载中..." })
    ] }) : filteredProfiles.length ? /* @__PURE__ */ jsx(
      DndContext,
      {
        sensors,
        collisionDetection: closestCenter,
        onDragEnd: (event) => void onDragEnd(event),
        children: /* @__PURE__ */ jsx(SortableContext, { items: profileIds, strategy: verticalListSortingStrategy, children: /* @__PURE__ */ jsx("div", { className: "cards-list", children: filteredProfiles.map((p, idx) => {
          const liveSyncedProfile = p.name === liveQuotaMergeTargetName && modeCurrent ? {
            ...p,
            fiveHourRemainingPercent: modeCurrent.fiveHourRemainingPercent,
            fiveHourResetsAt: modeCurrent.fiveHourResetsAt,
            oneWeekRemainingPercent: modeCurrent.oneWeekRemainingPercent,
            oneWeekResetsAt: modeCurrent.oneWeekResetsAt
          } : p;
          return /* @__PURE__ */ jsx(
            SortableProfileCard,
            {
              profile: liveSyncedProfile,
              index: idx,
              selected: selected === p.name,
              isModeActive: modeActiveProfileName === p.name,
              busy: uiBusy,
              showLiveQuerying: p.name === liveQueryProfileName,
              isQuotaRefreshing: quotaQuerying && refreshingProfileNameSet.has(p.name),
              liveQueryError: p.name === liveQueryProfileName && (!dashboard?.currentErrorMode || dashboard.currentErrorMode === activeAppMode) ? dashboard?.currentError ?? null : null,
              onSelect: setSelected,
              onRefreshQuota: (name) => void onRefreshSelectedQuota(name, true),
              onApply: (name) => void onApplySelected(name),
              onSetAlias: (name) => void onSetAlias(name),
              onDelete: (name) => void onDeleteSelected(name)
            },
            p.name
          );
        }) }) })
      }
    ) : /* @__PURE__ */ jsxs("div", { className: "empty", children: [
      "当前",
      activeAppMode === "gpt" ? "GPT" : "OpenCode",
      "分组暂无账号。点击右上角 + 添加账号（内嵌登录）。"
    ] }) })
  ] });
}
