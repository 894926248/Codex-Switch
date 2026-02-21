import { jsx, jsxs } from "react/jsx-runtime";

export function renderBlockingOverlay({ blockingMessage }) {
  if (!blockingMessage) {
    return null;
  }
  return /* @__PURE__ */ jsx("div", { className: "blocking-overlay", role: "alertdialog", "aria-busy": "true", "aria-live": "polite", children: /* @__PURE__ */ jsxs("div", { className: "blocking-dialog", children: [
    /* @__PURE__ */ jsx("span", { className: "blocking-spinner", "aria-hidden": true }),
    /* @__PURE__ */ jsx("div", { className: "blocking-title", children: blockingMessage }),
    /* @__PURE__ */ jsx("div", { className: "blocking-tip", children: "请等待当前流程完成，期间主窗口已锁定。" }),
  ] }) });
}

export function renderClosePromptDialog({
  closePromptOpen,
  closePromptRemember,
  handleClosePromptAction,
  setClosePromptOpen,
  setClosePromptRemember,
}) {
  if (!closePromptOpen) {
    return null;
  }
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: "close-choice-overlay",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "关闭窗口方式",
      onClick: () => {
        setClosePromptOpen(false);
        setClosePromptRemember(false);
      },
      children: /* @__PURE__ */ jsxs("section", { className: "close-choice-dialog", onClick: (event) => event.stopPropagation(), children: [
        /* @__PURE__ */ jsxs("header", { className: "close-choice-header", children: [
          /* @__PURE__ */ jsx("div", { className: "close-choice-title", children: "关闭窗口" }),
          /* @__PURE__ */ jsx(
            "button",
            {
              className: "header-icon close-choice-close",
              type: "button",
              title: "关闭",
              "aria-label": "关闭",
              onClick: () => {
                setClosePromptOpen(false);
                setClosePromptRemember(false);
              },
              children: "✕",
            }
          ),
        ] }),
        /* @__PURE__ */ jsx("div", { className: "close-choice-desc", children: "点击右上角关闭按钮（X）时，请选择默认行为：" }),
        /* @__PURE__ */ jsxs("label", { className: "close-choice-remember", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "checkbox",
              checked: closePromptRemember,
              onChange: (event) => setClosePromptRemember(event.target.checked),
            }
          ),
          /* @__PURE__ */ jsx("span", { children: "记住我的选择，下次不再询问（可在设置中心修改）" }),
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "close-choice-actions", children: [
          /* @__PURE__ */ jsx("button", { className: "settings-btn primary", type: "button", onClick: () => void handleClosePromptAction("background"), children: "隐藏到系统托盘" }),
          /* @__PURE__ */ jsx("button", { className: "settings-btn", type: "button", onClick: () => void handleClosePromptAction("exit"), children: "直接退出" }),
        ] }),
      ] }),
    }
  );
}

export function renderSettingsDialog(props) {
  const {
    codexExtInfo,
    hookInstalled,
    hookVersionSnapshot,
    onExportDataBackup,
    onImportDataBackupClick,
    onInjectHookOneClick,
    onInstallCodexHook,
    onRunPostSwitchStrategy,
    postSwitchStrategy,
    refreshHookStatus,
    refreshVsCodeStatus,
    settingsEditorTarget,
    settingsOpen,
    settingsTargetName,
    settingsTargetShortName,
    setPostSwitchStrategy,
    setSettingsEditorTarget,
    setSettingsOpen,
    setWindowCloseAction,
    SUPPORTED_EDITORS,
    uiBusy,
    vscodeStatus,
    windowCloseAction,
  } = props;

  if (!settingsOpen) {
    return null;
  }

  return /* @__PURE__ */ jsx("div", { className: "settings-overlay", role: "dialog", "aria-modal": "true", "aria-label": "Codex 设置中心", onClick: () => setSettingsOpen(false), children: /* @__PURE__ */ jsxs("section", { className: "settings-panel", onClick: (e) => e.stopPropagation(), children: [
    /* @__PURE__ */ jsxs("header", { className: "settings-header", children: [
      /* @__PURE__ */ jsx("div", { className: "settings-title", children: "Codex 设置中心" }),
      /* @__PURE__ */ jsx("button", { className: "header-icon", type: "button", onClick: () => setSettingsOpen(false), title: "关闭设置", children: "✕" }),
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "settings-body", children: [
      /* @__PURE__ */ jsxs("section", { className: "settings-group", children: [
        /* @__PURE__ */ jsx("div", { className: "settings-group-title", children: "支持列表" }),
        /* @__PURE__ */ jsx("div", { className: "supported-editor-switches", role: "tablist", "aria-label": "支持编辑器切换", children: SUPPORTED_EDITORS.map((editor) => /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": settingsEditorTarget === editor.id,
            className: `supported-editor-switch ${settingsEditorTarget === editor.id ? "active" : ""}`,
            onClick: () => setSettingsEditorTarget(editor.id),
            children: [
              /* @__PURE__ */ jsx("img", { className: "supported-editor-icon", src: editor.icon, alt: "", "aria-hidden": true }),
              /* @__PURE__ */ jsx("span", { className: "supported-editor-name", children: editor.name }),
            ],
          },
          editor.id
        )) }),
        /* @__PURE__ */ jsxs("div", { className: "supported-editor-desc", children: [
          "当前配置目标：",
          settingsTargetName,
          "。下方策略和手动操作只针对当前选中的编辑器。",
        ] }),
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "settings-group", children: [
        /* @__PURE__ */ jsxs("div", { className: "settings-group-title", children: [settingsTargetName, " 切号后动作策略"] }),
        /* @__PURE__ */ jsxs("label", { className: `strategy-item ${postSwitchStrategy === "restart_extension_host" ? "active" : ""}`, children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "radio",
              name: "postSwitchStrategy",
              value: "restart_extension_host",
              checked: postSwitchStrategy === "restart_extension_host",
              onChange: () => setPostSwitchStrategy("restart_extension_host"),
              disabled: uiBusy,
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "strategy-main", children: [
            /* @__PURE__ */ jsx("div", { className: "strategy-title", children: "方案1：重启 Extension Host（更稳）" }),
            /* @__PURE__ */ jsxs("div", { className: "strategy-desc", children: [
              "面向 ",
              settingsTargetName,
              "：不重载整个窗口，仅重启扩展宿主。作为兜底策略最稳。",
            ] }),
          ] }),
        ] }),
        /* @__PURE__ */ jsxs("label", { className: `strategy-item ${postSwitchStrategy === "hook" ? "active" : ""}`, children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "radio",
              name: "postSwitchStrategy",
              value: "hook",
              checked: postSwitchStrategy === "hook",
              onChange: () => setPostSwitchStrategy("hook"),
              disabled: uiBusy || hookInstalled !== true,
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "strategy-main", children: [
            /* @__PURE__ */ jsx("div", { className: "strategy-title", children: "方案2：Hook 提速版（方案1语义）" }),
            /* @__PURE__ */ jsxs("div", { className: "strategy-desc", children: [
              "面向 ",
              settingsTargetName,
              "：通过 Hook 触发 Extension Host 重启，保留方案1的会话兼容性，并减少切后等待时间。",
            ] }),
          ] }),
        ] }),
        /* @__PURE__ */ jsxs("div", { className: `runtime-alert ${vscodeStatus?.running && hookInstalled !== false ? "ok" : "warn"}`, children: [
          /* @__PURE__ */ jsxs("div", { className: "runtime-alert-text", children: [
            /* @__PURE__ */ jsxs("div", { className: "runtime-status-line", children: [
              /* @__PURE__ */ jsxs("span", { className: "runtime-status-label", children: [settingsTargetName, " 状态:"] }),
              /* @__PURE__ */ jsx(
                "span",
                {
                  className: `runtime-status-badge ${vscodeStatus === null ? "unknown" : vscodeStatus.running ? "ok" : "warn"}`,
                  children: vscodeStatus === null ? "未检测" : vscodeStatus.running ? `运行中（进程 ${vscodeStatus.processCount}）` : "未启动",
                }
              ),
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "runtime-status-line", children: [
              /* @__PURE__ */ jsx("span", { className: "runtime-status-label", children: "Codex Hook 状态:" }),
              /* @__PURE__ */ jsx(
                "span",
                {
                  className: `runtime-status-badge ${hookInstalled === null ? "unknown" : hookInstalled ? "ok" : "warn"}`,
                  children: hookInstalled === null ? "未检测" : hookInstalled ? "已注入" : "未注入（方案2提速版暂不可用）",
                }
              ),
            ] }),
            vscodeStatus?.running === false ? /* @__PURE__ */ jsxs("div", { className: "runtime-alert-tip", children: [
              settingsTargetName,
              " 未运行，无法注入 Hook。请先启动 ",
              settingsTargetShortName,
              "。",
            ] }) : null,
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "runtime-alert-actions", children: [
            /* @__PURE__ */ jsxs("button", { className: "settings-btn", type: "button", disabled: uiBusy, onClick: () => void refreshVsCodeStatus(false), children: ["检测 ", settingsTargetName] }),
            /* @__PURE__ */ jsx("button", { className: "settings-btn", type: "button", disabled: uiBusy, onClick: () => void refreshHookStatus(false), children: "检测 Codex Hook" }),
            hookInstalled === false ? /* @__PURE__ */ jsx(
              "button",
              {
                className: "settings-btn primary",
                type: "button",
                disabled: uiBusy || vscodeStatus?.running === false,
                onClick: () => void onInjectHookOneClick(),
                title: vscodeStatus?.running === false ? `${settingsTargetName} 未运行，无法注入` : "一键注入并启用方案2提速版",
                children: "一键注入并启用方案2提速版",
              }
            ) : null,
          ] }),
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "strategy-desc", children: [
          "扩展版本: ",
          codexExtInfo?.currentVersion || "-",
          " | Hook 记录版本: ",
          hookVersionSnapshot || "-",
        ] }),
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "settings-group", children: [
        /* @__PURE__ */ jsx("div", { className: "settings-group-title", children: "手动操作" }),
        /* @__PURE__ */ jsxs("div", { className: "settings-actions", children: [
          /* @__PURE__ */ jsx(
            "button",
            {
              className: "settings-btn",
              type: "button",
              disabled: uiBusy || vscodeStatus?.running === false,
              onClick: () => void onInstallCodexHook(),
              title: vscodeStatus?.running === false ? `${settingsTargetName} 未运行，无法注入` : `首次安装后请点一次；后续仅在 ${settingsTargetName} 扩展更新或 Hook 未注入/版本过旧时再点`,
              children: "安装/更新方案2 Hook 提速版",
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              className: "settings-btn",
              type: "button",
              disabled: uiBusy || vscodeStatus?.running === false,
              onClick: () => void onRunPostSwitchStrategy(postSwitchStrategy),
              children: "测试当前策略",
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              className: "settings-btn",
              type: "button",
              disabled: uiBusy || vscodeStatus?.running === false,
              onClick: () => void onRunPostSwitchStrategy("restart_extension_host"),
              children: "手动执行方案1",
            }
          ),
          /* @__PURE__ */ jsx(
            "button",
            {
              className: "settings-btn",
              type: "button",
              disabled: uiBusy || vscodeStatus?.running === false || hookInstalled !== true,
              onClick: () => void onRunPostSwitchStrategy("hook"),
              children: "手动执行方案2",
            }
          ),
          /* @__PURE__ */ jsx("button", { className: "settings-btn", type: "button", disabled: uiBusy, onClick: () => void onExportDataBackup(), children: "导出备份" }),
          /* @__PURE__ */ jsx("button", { className: "settings-btn", type: "button", disabled: uiBusy, onClick: onImportDataBackupClick, children: "导入恢复" }),
        ] }),
        /* @__PURE__ */ jsx("div", { className: "strategy-desc", children: "提示：首次安装后请点一次“安装/更新方案2 Hook 提速版”；之后仅在 Codex 扩展版本更新，或 Hook 状态显示“未注入/版本过旧”时再点一次。" }),
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "settings-group", children: [
        /* @__PURE__ */ jsx("div", { className: "settings-group-title", children: "窗口关闭行为" }),
        /* @__PURE__ */ jsxs("label", { className: `strategy-item ${windowCloseAction === "ask" ? "active" : ""}`, children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "radio",
              name: "windowCloseAction",
              value: "ask",
              checked: windowCloseAction === "ask",
              onChange: () => setWindowCloseAction("ask"),
              disabled: uiBusy,
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "strategy-main", children: [
            /* @__PURE__ */ jsx("div", { className: "strategy-title", children: "每次询问" }),
            /* @__PURE__ */ jsx("div", { className: "strategy-desc", children: "点右上角 X 时，弹窗选择“退出程序”或“隐藏到系统托盘”。" }),
          ] }),
        ] }),
        /* @__PURE__ */ jsxs("label", { className: `strategy-item ${windowCloseAction === "background" ? "active" : ""}`, children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "radio",
              name: "windowCloseAction",
              value: "background",
              checked: windowCloseAction === "background",
              onChange: () => setWindowCloseAction("background"),
              disabled: uiBusy,
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "strategy-main", children: [
            /* @__PURE__ */ jsx("div", { className: "strategy-title", children: "直接隐藏到系统托盘" }),
            /* @__PURE__ */ jsx("div", { className: "strategy-desc", children: "点 X 不退出程序，仅隐藏窗口并驻留托盘。" }),
          ] }),
        ] }),
        /* @__PURE__ */ jsxs("label", { className: `strategy-item ${windowCloseAction === "exit" ? "active" : ""}`, children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "radio",
              name: "windowCloseAction",
              value: "exit",
              checked: windowCloseAction === "exit",
              onChange: () => setWindowCloseAction("exit"),
              disabled: uiBusy,
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "strategy-main", children: [
            /* @__PURE__ */ jsx("div", { className: "strategy-title", children: "直接退出程序" }),
            /* @__PURE__ */ jsx("div", { className: "strategy-desc", children: "点 X 不再询问，立即关闭 Codex Switch。" }),
          ] }),
        ] }),
      ] }),
    ] }),
  ] }) });
}

export function renderStatusBar({ hookListenerBadge, opencodeListenerBadge, quotaQuerying, statusText, uiBusy }) {
  return /* @__PURE__ */ jsxs("footer", { className: "status-bar", children: [
    /* @__PURE__ */ jsxs("span", { className: "status-listener-group", children: [
      /* @__PURE__ */ jsxs("span", { className: "status-listener", children: [
        /* @__PURE__ */ jsx("span", { className: "status-listener-label", children: "GPT:" }),
        /* @__PURE__ */ jsx("span", { className: `runtime-status-badge ${hookListenerBadge.level}`, children: hookListenerBadge.text }),
      ] }),
      /* @__PURE__ */ jsxs("span", { className: "status-listener", children: [
        /* @__PURE__ */ jsx("span", { className: "status-listener-label", children: "OpenCode:" }),
        /* @__PURE__ */ jsx("span", { className: `runtime-status-badge ${opencodeListenerBadge.level}`, children: opencodeListenerBadge.text }),
      ] }),
    ] }),
    /* @__PURE__ */ jsx("span", { className: "status-main", children: quotaQuerying ? /* @__PURE__ */ jsxs("span", { className: "status-inline", children: [
      /* @__PURE__ */ jsx("span", { className: "status-spinner", "aria-hidden": true }),
      /* @__PURE__ */ jsx("span", { children: "配额查询中..." }),
    ] }) : uiBusy ? `处理中... ${statusText}` : statusText }),
  ] });
}
