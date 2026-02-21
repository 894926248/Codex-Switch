import { jsx, jsxs } from "react/jsx-runtime";
import { ArrowLeft, ChevronDown, ChevronUp, Plus, Wrench } from "lucide-react";

export function renderMcpAddView(props) {
  const {
    applyMcpPreset,
    closeMcpAddPage,
    mcpBusyIds,
    mcpFormClaudeEnabled,
    mcpFormCodexEnabled,
    mcpFormConfig,
    mcpFormDescription,
    mcpFormDocs,
    mcpFormError,
    mcpFormGeminiEnabled,
    mcpFormHomepage,
    mcpFormId,
    mcpFormName,
    mcpFormOpencodeEnabled,
    mcpFormTags,
    mcpSelectedPreset,
    mcpShowMetadata,
    MCP_CONFIG_PLACEHOLDER,
    MCP_PRESET_OPTIONS,
    onFormatMcpConfig,
    onSubmitMcpAdd,
    openaiLogo,
    opencodeLogo,
    setMcpFormClaudeEnabled,
    setMcpFormCodexEnabled,
    setMcpFormConfig,
    setMcpFormDescription,
    setMcpFormDocs,
    setMcpFormGeminiEnabled,
    setMcpFormHomepage,
    setMcpFormId,
    setMcpFormName,
    setMcpFormOpencodeEnabled,
    setMcpFormTags,
    setMcpShowMetadata,
    setStatusText,
  } = props;

  return /* @__PURE__ */ jsxs("main", { className: "tools-pane-wrap tools-pane-wrap-sticky-head mcp-create-view", children: [
    /* @__PURE__ */ jsx("div", { className: "tools-pane-sticky-head", children: /* @__PURE__ */ jsx("section", { className: "skills-page-header", children: /* @__PURE__ */ jsxs("div", { className: "skills-page-left", children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          className: "skills-back-btn",
          onClick: () => closeMcpAddPage(),
          title: "返回 MCP 管理",
          "aria-label": "返回 MCP 管理",
          children: /* @__PURE__ */ jsx(ArrowLeft, { className: "skills-back-icon" })
        }
      ),
      /* @__PURE__ */ jsx("h1", { className: "skills-inline-title", children: "新增 MCP" })
    ] }) }) }),
    /* @__PURE__ */ jsxs("section", { className: "skill-repo-form-panel mcp-create-card", children: [
      /* @__PURE__ */ jsx("h2", { children: "选择 MCP 类型" }),
      /* @__PURE__ */ jsxs("div", { className: "mcp-type-chip-row", children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: `mcp-type-chip ${mcpSelectedPreset === "custom" ? "active" : ""}`,
            onClick: () => applyMcpPreset("custom"),
            children: "自定义"
          }
        ),
        MCP_PRESET_OPTIONS.map((preset) => /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: `mcp-type-chip ${mcpSelectedPreset === preset.id ? "active" : ""}`,
            onClick: () => applyMcpPreset(preset.id),
            children: preset.id
          },
          preset.id
        ))
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "skill-repo-form-label", children: [
        /* @__PURE__ */ jsxs("span", { children: [
          "MCP 标题（唯一）",
          /* @__PURE__ */ jsx("em", { className: "mcp-required-mark", children: "*" })
        ] }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: mcpFormId,
            onChange: (event) => setMcpFormId(event.target.value),
            placeholder: "my-mcp-server"
          }
        )
      ] }),
      /* @__PURE__ */ jsxs("label", { className: "skill-repo-form-label", children: [
        /* @__PURE__ */ jsx("span", { children: "显示名称" }),
        /* @__PURE__ */ jsx(
          "input",
          {
            type: "text",
            value: mcpFormName,
            onChange: (event) => setMcpFormName(event.target.value),
            placeholder: "例如 @modelcontextprotocol/server-time"
          }
        )
      ] }),
      /* @__PURE__ */ jsx("div", { className: "mcp-create-subtitle", children: "启用到应用" }),
      /* @__PURE__ */ jsxs("div", { className: "mcp-form-targets", children: [
        /* @__PURE__ */ jsxs("label", { className: "mcp-form-target", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "checkbox",
              checked: mcpFormClaudeEnabled,
              onChange: (event) => setMcpFormClaudeEnabled(event.target.checked)
            }
          ),
          /* @__PURE__ */ jsx("span", { children: "Claude" })
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "mcp-form-target", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "checkbox",
              checked: mcpFormCodexEnabled,
              onChange: (event) => setMcpFormCodexEnabled(event.target.checked)
            }
          ),
          /* @__PURE__ */ jsx("img", { src: openaiLogo, alt: "", "aria-hidden": true, className: "skill-target-icon" }),
          /* @__PURE__ */ jsx("span", { children: "Codex" })
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "mcp-form-target", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "checkbox",
              checked: mcpFormGeminiEnabled,
              onChange: (event) => setMcpFormGeminiEnabled(event.target.checked)
            }
          ),
          /* @__PURE__ */ jsx("span", { children: "Gemini" })
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "mcp-form-target", children: [
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "checkbox",
              checked: mcpFormOpencodeEnabled,
              onChange: (event) => setMcpFormOpencodeEnabled(event.target.checked)
            }
          ),
          /* @__PURE__ */ jsx("img", { src: opencodeLogo, alt: "", "aria-hidden": true, className: "skill-target-icon" }),
          /* @__PURE__ */ jsx("span", { children: "OpenCode" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          className: "mcp-metadata-toggle",
          onClick: () => setMcpShowMetadata((prev) => !prev),
          children: [
            mcpShowMetadata ? /* @__PURE__ */ jsx(ChevronUp, { className: "mcp-metadata-icon" }) : /* @__PURE__ */ jsx(ChevronDown, { className: "mcp-metadata-icon" }),
            "附加信息"
          ]
        }
      ),
      mcpShowMetadata ? /* @__PURE__ */ jsxs("div", { className: "mcp-metadata-fields", children: [
        /* @__PURE__ */ jsxs("label", { className: "skill-repo-form-label", children: [
          /* @__PURE__ */ jsx("span", { children: "描述" }),
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "text",
              value: mcpFormDescription,
              onChange: (event) => setMcpFormDescription(event.target.value),
              placeholder: "可选的描述信息"
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "skill-repo-form-label", children: [
          /* @__PURE__ */ jsx("span", { children: "标签（逗号分隔）" }),
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "text",
              value: mcpFormTags,
              onChange: (event) => setMcpFormTags(event.target.value),
              placeholder: "stdio, time, utility"
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "skill-repo-form-label", children: [
          /* @__PURE__ */ jsx("span", { children: "主页链接" }),
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "text",
              value: mcpFormHomepage,
              onChange: (event) => setMcpFormHomepage(event.target.value),
              placeholder: "https://example.com"
            }
          )
        ] }),
        /* @__PURE__ */ jsxs("label", { className: "skill-repo-form-label", children: [
          /* @__PURE__ */ jsx("span", { children: "文档链接" }),
          /* @__PURE__ */ jsx(
            "input",
            {
              type: "text",
              value: mcpFormDocs,
              onChange: (event) => setMcpFormDocs(event.target.value),
              placeholder: "https://example.com/docs"
            }
          )
        ] })
      ] }) : null,
      mcpFormError ? /* @__PURE__ */ jsx("div", { className: "mcp-form-error", children: mcpFormError }) : null
    ] }),
    /* @__PURE__ */ jsxs("section", { className: "skill-repo-form-panel mcp-create-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "mcp-json-header", children: [
        /* @__PURE__ */ jsx("h2", { children: "完整的 JSON 配置" }),
        /* @__PURE__ */ jsxs("div", { className: "mcp-json-actions", children: [
          /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              className: "mcp-json-guide-btn",
              onClick: () => setStatusText("当前已使用表单自动生成 JSON 配置。"),
              children: "配置向导"
            }
          ),
          /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              className: "skill-repo-add-btn mcp-inline-add-btn",
              disabled: !!mcpBusyIds.__add__,
              onClick: () => void onSubmitMcpAdd(),
              children: [
                /* @__PURE__ */ jsx(Plus, { className: "skill-repo-add-icon" }),
                mcpBusyIds.__add__ ? "添加中..." : "添加"
              ]
            }
          )
        ] })
      ] }),
      /* @__PURE__ */ jsx(
        "textarea",
        {
          className: "mcp-json-editor",
          value: mcpFormConfig,
          onChange: (event) => setMcpFormConfig(event.target.value),
          spellCheck: false,
          rows: 6,
          placeholder: MCP_CONFIG_PLACEHOLDER
        }
      ),
      /* @__PURE__ */ jsxs("button", { type: "button", className: "mcp-json-format-btn", onClick: onFormatMcpConfig, children: [
        /* @__PURE__ */ jsx(Wrench, { className: "mcp-json-format-icon" }),
        "格式化"
      ] })
    ] })
  ] });
}
