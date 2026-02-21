import { useCallback } from "react";
import { confirm, invoke } from "../../../adapters/tauri";
import { MCP_PRESET_OPTIONS } from "../../../constants";
import { recomputeMcpManage } from "../../../utils";

export function useMcpPanelActions(ctx) {
  const {
    mcpFormConfig,
    mcpFormId,
    mcpFormClaudeEnabled,
    mcpFormCodexEnabled,
    mcpFormGeminiEnabled,
    mcpFormOpencodeEnabled,
    setActiveToolView,
    setMcpBusyIds,
    setMcpFormClaudeEnabled,
    setMcpFormCodexEnabled,
    setMcpFormConfig,
    setMcpFormDescription,
    setMcpFormDocs,
    setMcpFormError,
    setMcpFormGeminiEnabled,
    setMcpFormHomepage,
    setMcpFormId,
    setMcpFormName,
    setMcpFormOpencodeEnabled,
    setMcpFormTags,
    setMcpManage,
    setMcpManageError,
    setMcpManageRefreshing,
    setMcpSelectedPreset,
    setMcpShowMetadata,
    setStatusText,
    loadMcpManage,
  } = ctx;

  const resetMcpAddForm = useCallback(() => {
    setMcpFormId("");
    setMcpFormName("");
    setMcpFormDescription("");
    setMcpFormTags("");
    setMcpFormHomepage("");
    setMcpFormDocs("");
    setMcpFormConfig("");
    setMcpSelectedPreset("custom");
    setMcpShowMetadata(false);
    setMcpFormClaudeEnabled(true);
    setMcpFormGeminiEnabled(true);
    setMcpFormCodexEnabled(true);
    setMcpFormOpencodeEnabled(true);
    setMcpFormError(null);
  }, [
    setMcpFormId,
    setMcpFormName,
    setMcpFormDescription,
    setMcpFormTags,
    setMcpFormHomepage,
    setMcpFormDocs,
    setMcpFormConfig,
    setMcpSelectedPreset,
    setMcpShowMetadata,
    setMcpFormClaudeEnabled,
    setMcpFormGeminiEnabled,
    setMcpFormCodexEnabled,
    setMcpFormOpencodeEnabled,
    setMcpFormError,
  ]);

  const openMcpAddPage = useCallback(() => {
    resetMcpAddForm();
    setActiveToolView("mcpAdd");
  }, [resetMcpAddForm, setActiveToolView]);

  const closeMcpAddPage = useCallback(() => {
    setActiveToolView("mcp");
    setMcpFormError(null);
  }, [setActiveToolView, setMcpFormError]);

  const applyMcpPreset = useCallback((presetId) => {
    if (presetId === "custom") {
      setMcpSelectedPreset("custom");
      setMcpFormId("");
      setMcpFormName("");
      setMcpFormDescription("");
      setMcpFormTags("");
      setMcpFormHomepage("");
      setMcpFormDocs("");
      setMcpFormConfig("");
      setMcpFormError(null);
      return;
    }
    const preset = MCP_PRESET_OPTIONS.find((item) => item.id === presetId);
    if (!preset) {
      return;
    }
    setMcpSelectedPreset(preset.id);
    setMcpFormId(preset.id);
    setMcpFormName(preset.name);
    setMcpFormDescription(preset.description);
    setMcpFormTags(preset.tags.join(", "));
    setMcpFormHomepage(preset.homepage);
    setMcpFormDocs(preset.docs);
    setMcpFormConfig(JSON.stringify(preset.spec, null, 2));
    setMcpFormError(null);
  }, [
    setMcpSelectedPreset,
    setMcpFormId,
    setMcpFormName,
    setMcpFormDescription,
    setMcpFormTags,
    setMcpFormHomepage,
    setMcpFormDocs,
    setMcpFormConfig,
    setMcpFormError,
  ]);

  const onSubmitMcpAdd = useCallback(async () => {
    const id = mcpFormId.trim();
    if (!id) {
      setMcpFormError("MCP 标题不能为空。");
      return;
    }
    if (!mcpFormCodexEnabled && !mcpFormOpencodeEnabled) {
      setMcpFormError("至少启用 Codex 或 OpenCode 其中之一。");
      return;
    }
    if (!mcpFormConfig.trim()) {
      setMcpFormError("请填写 JSON 配置。");
      return;
    }

    let spec;
    try {
      const parsed = JSON.parse(mcpFormConfig);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setMcpFormError("JSON 配置必须是对象。");
        return;
      }
      spec = parsed;
    } catch {
      setMcpFormError("JSON 配置格式无效。");
      return;
    }

    const type = String(spec.type ?? "stdio").trim().toLowerCase();
    if (type === "stdio") {
      const command = String(spec.command ?? "").trim();
      if (!command) {
        setMcpFormError("stdio 类型的 MCP 服务器缺少 command 字段。");
        return;
      }
    } else if (type === "http" || type === "sse") {
      const url = String(spec.url ?? "").trim();
      if (!url) {
        setMcpFormError(`${type} 类型的 MCP 服务器缺少 url 字段。`);
        return;
      }
    } else {
      setMcpFormError(`不支持的 MCP 服务器类型: ${type}`);
      return;
    }

    const busyKey = "__add__";
    setMcpBusyIds((prev) => ({ ...prev, [busyKey]: true }));
    try {
      const data = await invoke("add_mcp_server", {
        serverId: id,
        spec,
        claude: mcpFormClaudeEnabled,
        codex: mcpFormCodexEnabled,
        gemini: mcpFormGeminiEnabled,
        opencode: mcpFormOpencodeEnabled,
      });
      setMcpManage(recomputeMcpManage(data));
      setMcpManageError(null);
      resetMcpAddForm();
      setActiveToolView("mcp");
      setStatusText(`已添加 MCP: ${id}`);
    } catch (err) {
      setMcpFormError(`添加 MCP 失败: ${String(err)}`);
    } finally {
      setMcpBusyIds((prev) => {
        const next = { ...prev };
        delete next[busyKey];
        return next;
      });
    }
  }, [
    mcpFormId,
    mcpFormConfig,
    mcpFormClaudeEnabled,
    mcpFormCodexEnabled,
    mcpFormGeminiEnabled,
    mcpFormOpencodeEnabled,
    setMcpFormError,
    setMcpBusyIds,
    setMcpManage,
    setMcpManageError,
    resetMcpAddForm,
    setActiveToolView,
    setStatusText,
  ]);

  const onFormatMcpConfig = useCallback(() => {
    const text = mcpFormConfig.trim();
    if (!text) {
      setMcpFormError("请先填写 JSON 配置。");
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setMcpFormError("JSON 配置必须是对象。");
        return;
      }
      setMcpFormConfig(JSON.stringify(parsed, null, 2));
      setMcpFormError(null);
    } catch {
      setMcpFormError("JSON 配置格式无效，无法格式化。");
    }
  }, [mcpFormConfig, setMcpFormConfig, setMcpFormError]);

  const onToggleMcpTarget = useCallback(async (server, target) => {
    const nextClaude = target === "claude" ? !server.claudeEnabled : server.claudeEnabled;
    const nextCodex = target === "codex" ? !server.codexEnabled : server.codexEnabled;
    const nextGemini = target === "gemini" ? !server.geminiEnabled : server.geminiEnabled;
    const nextOpenCode = target === "opencode" ? !server.opencodeEnabled : server.opencodeEnabled;
    setMcpBusyIds((prev) => ({ ...prev, [server.id]: true }));
    setMcpManage((prev) => {
      if (!prev) {
        return prev;
      }
      const optimistic = {
        ...prev,
        servers: prev.servers.map((item) =>
          item.id === server.id
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
      return recomputeMcpManage(optimistic);
    });
    try {
      const data = await invoke("set_mcp_targets", {
        serverId: server.id,
        claude: nextClaude,
        codex: nextCodex,
        gemini: nextGemini,
        opencode: nextOpenCode,
      });
      setMcpManage(recomputeMcpManage(data));
      setMcpManageError(null);
    } catch (err) {
      setMcpManageError(`更新 MCP 开关失败: ${String(err)}`);
      await loadMcpManage(false);
    } finally {
      setMcpBusyIds((prev) => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
    }
  }, [setMcpBusyIds, setMcpManage, setMcpManageError, loadMcpManage]);

  const onRemoveMcpServer = useCallback(async (server) => {
    const approved = await confirm(`确定删除 MCP 服务器 "${server.name || server.id}" 吗？\n将从 Codex / OpenCode 配置中移除。`, {
      title: "删除 MCP 服务器",
      kind: "warning",
      okLabel: "删除",
      cancelLabel: "取消",
    });
    if (!approved) {
      return;
    }
    setMcpBusyIds((prev) => ({ ...prev, [server.id]: true }));
    try {
      const data = await invoke("remove_mcp_server", { serverId: server.id });
      setMcpManage(recomputeMcpManage(data));
      setMcpManageError(null);
      setStatusText(`已删除 MCP: ${server.name || server.id}`);
    } catch (err) {
      setMcpManageError(`删除 MCP 失败: ${String(err)}`);
    } finally {
      setMcpBusyIds((prev) => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
    }
  }, [setMcpBusyIds, setMcpManage, setMcpManageError, setStatusText]);

  const onOpenMcpDoc = useCallback(
    (server) => {
      const targetUrl = (server.docUrl || "").trim();
      if (!targetUrl) {
        setStatusText(`MCP ${server.name || server.id} 未配置可访问文档链接。`);
        return;
      }
      void (async () => {
        try {
          await invoke("open_external_url", { url: targetUrl });
          setStatusText(`已打开 MCP 文档: ${server.name || server.id}`);
        } catch (err) {
          setStatusText(`打开 MCP 文档失败: ${String(err)}`);
        }
      })();
    },
    [setStatusText]
  );

  const onImportExistingMcp = useCallback(async () => {
    setMcpManageRefreshing(true);
    try {
      const data = await invoke("import_existing_mcp");
      setMcpManage(recomputeMcpManage(data));
      setMcpManageError(null);
      setStatusText(`已导入已有 MCP 配置（${data.total} 个）`);
    } catch (err) {
      setMcpManageError(`导入 MCP 失败: ${String(err)}`);
    } finally {
      setMcpManageRefreshing(false);
    }
  }, [setMcpManageRefreshing, setMcpManage, setMcpManageError, setStatusText]);

  return {
    applyMcpPreset,
    closeMcpAddPage,
    onFormatMcpConfig,
    onImportExistingMcp,
    onOpenMcpDoc,
    onRemoveMcpServer,
    onSubmitMcpAdd,
    onToggleMcpTarget,
    openMcpAddPage,
  };
}
