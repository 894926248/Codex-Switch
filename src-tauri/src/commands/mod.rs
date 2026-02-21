use super::*;

fn fmt_reset(ts: Option<i64>) -> String {
    let Some(value) = ts else {
        return "-".to_string();
    };
    let Some(dt) = Local.timestamp_opt(value, 0).single() else {
        return "-".to_string();
    };
    dt.format("%m-%d %H:%M").to_string()
}

#[tauri::command]
pub(super) async fn load_dashboard(
    sync_current: Option<bool>,
    _mode: Option<String>,
) -> CmdResult<DashboardData> {
    let sync_current = sync_current.unwrap_or(true);
    let mode = _mode
        .as_deref()
        .map(|value| parse_auto_switch_mode(Some(value)));
    tauri::async_runtime::spawn_blocking(move || {
        load_dashboard_internal_for_mode(sync_current, mode)
    })
    .await
    .map_err(|e| format!("加载看板任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) fn save_current_profile(profile_name: String) -> CmdResult<DashboardData> {
    save_current_profile_internal(&profile_name)
}

#[tauri::command]
pub(super) async fn add_account_by_login(
    app: tauri::AppHandle,
    workspace_alias: Option<String>,
) -> CmdResult<DashboardData> {
    tauri::async_runtime::spawn_blocking(move || {
        add_account_by_login_internal(&app, workspace_alias)
    })
    .await
    .map_err(|e| format!("登录任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) fn apply_profile(name: String, mode: Option<String>) -> CmdResult<DashboardData> {
    apply_profile_internal_for_mode(&name, mode.as_deref())
}

#[tauri::command]
pub(super) fn set_workspace_alias(name: String, alias: Option<String>) -> CmdResult<DashboardData> {
    set_workspace_alias_internal(&name, alias)
}

#[tauri::command]
pub(super) fn set_profile_support(name: String, gpt: bool, opencode: bool) -> CmdResult<DashboardData> {
    set_profile_support_internal(&name, gpt, opencode)
}

#[tauri::command]
pub(super) async fn refresh_profile_quota(
    name: String,
    refresh_token: Option<bool>,
    mode: Option<String>,
) -> CmdResult<DashboardData> {
    let refresh_token = refresh_token.unwrap_or(false);
    let mode = mode
        .as_deref()
        .map(|value| parse_auto_switch_mode(Some(value)));
    tauri::async_runtime::spawn_blocking(move || {
        refresh_profile_quota_internal(&name, refresh_token, mode)
    })
    .await
    .map_err(|e| format!("刷新账号额度任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) async fn refresh_profiles_quota(
    names: Vec<String>,
    refresh_token: Option<bool>,
    mode: Option<String>,
) -> CmdResult<DashboardData> {
    let refresh_token = refresh_token.unwrap_or(false);
    let mode = mode
        .as_deref()
        .map(|value| parse_auto_switch_mode(Some(value)));
    tauri::async_runtime::spawn_blocking(move || {
        refresh_profiles_quota_internal(&names, refresh_token, mode)
    })
    .await
    .map_err(|e| format!("批量刷新账号额度任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) async fn refresh_all_quota(
    refresh_token: Option<bool>,
    mode: Option<String>,
) -> CmdResult<DashboardData> {
    let refresh_token = refresh_token.unwrap_or(false);
    let mode = mode
        .as_deref()
        .map(|value| parse_auto_switch_mode(Some(value)));
    tauri::async_runtime::spawn_blocking(move || refresh_all_quota_internal(refresh_token, mode))
        .await
        .map_err(|e| format!("刷新全部额度任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) async fn keepalive_all() -> CmdResult<DashboardData> {
    tauri::async_runtime::spawn_blocking(keepalive_all_internal)
        .await
        .map_err(|e| format!("保活任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) async fn auto_switch_tick(
    auto_runtime: State<'_, AutoSwitchRuntimeState>,
    mode: Option<String>,
) -> CmdResult<AutoSwitchTickResult> {
    let runtime = auto_runtime.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = runtime
            .lock()
            .map_err(|_| "无感换号状态锁定失败。".to_string())?;
        auto_switch_tick_internal(&mut guard, mode.as_deref())
    })
    .await
    .map_err(|e| format!("无感换号检测任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) async fn thread_recover_tick(
    auto_runtime: State<'_, AutoSwitchRuntimeState>,
    mode: Option<String>,
) -> CmdResult<AutoSwitchTickResult> {
    let runtime = auto_runtime.inner.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = runtime
            .lock()
            .map_err(|_| "无感换号状态锁定失败。".to_string())?;
        thread_recover_tick_internal(&mut guard, mode.as_deref())
    })
    .await
    .map_err(|e| format!("会话恢复检测任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) fn auto_switch_reset(auto_runtime: State<'_, AutoSwitchRuntimeState>) -> CmdResult<String> {
    let mut runtime = auto_runtime
        .inner
        .lock()
        .map_err(|_| "无感换号状态锁定失败。".to_string())?;
    Ok(auto_switch_reset_internal(&mut runtime))
}

#[tauri::command]
pub(super) fn delete_profile(name: String) -> CmdResult<DashboardData> {
    delete_profile_internal(&name)
}

#[tauri::command]
pub(super) fn reorder_profiles(names: Vec<String>) -> CmdResult<DashboardData> {
    reorder_profiles_internal(names)
}

#[tauri::command]
pub(super) async fn reload_vscode_window(app: tauri::AppHandle) -> CmdResult<String> {
    let mut fallback_notes: Vec<String> = Vec::new();

    if has_codex_hook_installed_internal(None) {
        let prefer_signal = has_codex_hook_signal_watch_installed_internal();
        let hook_result = tauri::async_runtime::spawn_blocking(move || {
            trigger_codex_hook_restart_internal(prefer_signal)
        })
        .await
        .map_err(|e| format!("Hook 刷新任务执行失败: {e}"))?;
        match hook_result {
            Ok(msg) => return Ok(format!("已通过 Hook 提速刷新。{msg}")),
            Err(err) => fallback_notes.push(format!("Hook 提速刷新失败：{err}")),
        }
    } else {
        fallback_notes.push("未安装 Hook 提速版".to_string());
    }

    let restart_result = tauri::async_runtime::spawn_blocking(restart_extension_host_internal)
        .await
        .map_err(|e| format!("重启 Extension Host 任务执行失败: {e}"))?;
    match restart_result {
        Ok(msg) => {
            if fallback_notes.is_empty() {
                return Ok(msg);
            }
            return Ok(format!(
                "{}；已回退到重启 Extension Host。{msg}",
                fallback_notes.join("；")
            ));
        }
        Err(err) => fallback_notes.push(format!("重启 Extension Host 失败：{err}")),
    }

    let preferred_kinds = preferred_editor_kinds_internal();
    let command_uris = build_editor_command_uris("workbench.action.reloadWindow", &preferred_kinds);
    let mut opener_errors: Vec<String> = Vec::new();

    for command_uri in &command_uris {
        match app.opener().open_url(command_uri.clone(), None::<String>) {
            Ok(_) => {
                if fallback_notes.is_empty() {
                    return Ok("已请求 VS Code 重载窗口。".to_string());
                }
                return Ok(format!(
                    "{}；已降级为窗口重载。已请求 VS Code 重载窗口。",
                    fallback_notes.join("；")
                ));
            }
            Err(err) => opener_errors.push(format!("{command_uri} -> {err}")),
        }
    }

    let cli_result = tauri::async_runtime::spawn_blocking(trigger_vscode_reload_internal)
        .await
        .map_err(|e| format!("刷新 VS Code 任务执行失败: {e}"))?;
    match cli_result {
        Ok(msg) => {
            if fallback_notes.is_empty() {
                Ok(msg)
            } else {
                Ok(format!(
                    "{}；已降级为窗口重载。{msg}",
                    fallback_notes.join("；")
                ))
            }
        }
        Err(err) => {
            let mut reasons: Vec<String> = Vec::new();
            reasons.extend(fallback_notes);
            if opener_errors.is_empty() {
                reasons.push(err);
            } else {
                reasons.push(format!(
                    "{err}（open_url 失败详情: {}）",
                    opener_errors.join(" | ")
                ));
            }
            Err(reasons.join("；"))
        }
    }
}

#[tauri::command]
pub(super) fn restart_extension_host() -> CmdResult<String> {
    restart_extension_host_internal()
}

#[tauri::command]
pub(super) fn install_codex_hook(editor_target: Option<String>) -> CmdResult<String> {
    install_codex_hook_internal(editor_target.as_deref())
}

#[tauri::command]
pub(super) async fn get_vscode_status(editor_target: Option<String>) -> CmdResult<VsCodeStatusView> {
    tauri::async_runtime::spawn_blocking(move || {
        get_vscode_status_internal(editor_target.as_deref())
    })
    .await
    .map_err(|e| format!("检测 VS Code 状态任务执行失败: {e}"))
}

#[tauri::command]
pub(super) async fn get_opencode_monitor_status() -> CmdResult<OpenCodeMonitorStatusView> {
    tauri::async_runtime::spawn_blocking(get_opencode_monitor_status_internal)
        .await
        .map_err(|e| format!("检测 OpenCode 监听状态任务执行失败: {e}"))
}

#[tauri::command]
pub(super) async fn get_codex_extension_info() -> CmdResult<CodexExtensionInfoView> {
    tauri::async_runtime::spawn_blocking(get_codex_extension_info_internal)
        .await
        .map_err(|e| format!("检测 Codex 扩展版本任务执行失败: {e}"))
}

#[tauri::command]
pub(super) async fn is_codex_hook_installed(editor_target: Option<String>) -> CmdResult<bool> {
    tauri::async_runtime::spawn_blocking(move || {
        has_codex_hook_installed_internal(editor_target.as_deref())
    })
    .await
    .map_err(|e| format!("检测 Hook 注入状态任务执行失败: {e}"))
}

#[tauri::command]
pub(super) fn load_skills_catalog() -> CmdResult<SkillsCatalogView> {
    load_skills_catalog_internal()
}

#[tauri::command]
pub(super) async fn load_skills_discovery(sync_remote: Option<bool>) -> CmdResult<SkillsDiscoveryView> {
    let sync = sync_remote.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || load_skills_discovery_internal(sync))
        .await
        .map_err(|e| format!("加载发现技能任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) async fn load_skill_repos_manage(refresh_count: bool) -> CmdResult<SkillRepoManageView> {
    tauri::async_runtime::spawn_blocking(move || load_skill_repos_manage_internal(refresh_count))
        .await
        .map_err(|e| format!("加载仓库管理任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) fn add_skill_repo(repo_input: String, branch: Option<String>) -> CmdResult<SkillRepoManageView> {
    add_skill_repo_internal(&repo_input, branch.as_deref())
}

#[tauri::command]
pub(super) fn remove_skill_repo(owner: String, name: String) -> CmdResult<SkillRepoManageView> {
    remove_skill_repo_internal(&owner, &name)
}

#[tauri::command]
pub(super) async fn install_discovery_skill(
    repo_owner: String,
    repo_name: String,
    repo_branch: String,
    repo_directory: String,
    local_directory: String,
    readme_url: String,
    name: String,
    description: String,
) -> CmdResult<SkillsCatalogView> {
    tauri::async_runtime::spawn_blocking(move || {
        install_discovery_skill_internal(
            &repo_owner,
            &repo_name,
            &repo_branch,
            &repo_directory,
            &local_directory,
            &readme_url,
            &name,
            &description,
        )
    })
    .await
    .map_err(|e| format!("安装发现技能任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) fn set_skill_targets(
    skill_id: String,
    claude: Option<bool>,
    codex: bool,
    gemini: Option<bool>,
    opencode: bool,
) -> CmdResult<SkillsCatalogView> {
    set_skill_targets_internal(&skill_id, claude, codex, gemini, opencode)
}

#[tauri::command]
pub(super) fn delete_skill(skill_id: String) -> CmdResult<SkillsCatalogView> {
    delete_skill_internal(&skill_id)
}

#[tauri::command]
pub(super) fn load_mcp_manage() -> CmdResult<McpManageView> {
    load_mcp_manage_internal()
}

#[tauri::command]
pub(super) fn import_existing_mcp() -> CmdResult<McpManageView> {
    import_existing_mcp_internal()
}

#[tauri::command]
pub(super) fn set_mcp_targets(
    server_id: String,
    claude: Option<bool>,
    codex: bool,
    gemini: Option<bool>,
    opencode: bool,
) -> CmdResult<McpManageView> {
    set_mcp_targets_internal(&server_id, claude, codex, gemini, opencode)
}

#[tauri::command]
pub(super) fn add_mcp_server(
    server_id: String,
    spec: Value,
    claude: bool,
    codex: bool,
    gemini: bool,
    opencode: bool,
) -> CmdResult<McpManageView> {
    add_mcp_server_internal(&server_id, &spec, claude, codex, gemini, opencode)
}

#[tauri::command]
pub(super) fn remove_mcp_server(server_id: String) -> CmdResult<McpManageView> {
    remove_mcp_server_internal(&server_id)
}

#[tauri::command]
pub(super) fn run_post_switch_action(strategy: String, _editor_target: Option<String>) -> CmdResult<String> {
    run_post_switch_action_internal(&strategy)
}

#[tauri::command]
pub(super) async fn export_data_backup(output_dir: Option<String>) -> CmdResult<BackupExportResult> {
    tauri::async_runtime::spawn_blocking(move || export_data_backup_internal(output_dir.as_deref()))
        .await
        .map_err(|e| format!("导出备份任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) async fn import_data_backup_base64(
    file_name: String,
    archive_base64: String,
) -> CmdResult<BackupImportResult> {
    tauri::async_runtime::spawn_blocking(move || {
        import_data_backup_base64_internal(&file_name, &archive_base64)
    })
    .await
    .map_err(|e| format!("导入备份任务执行失败: {e}"))?
}

#[tauri::command]
pub(super) fn format_reset_time(ts: Option<i64>) -> String {
    fmt_reset(ts)
}

#[tauri::command]
pub(super) fn open_external_url(app: tauri::AppHandle, url: String) -> CmdResult<bool> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("URL 不能为空。".to_string());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("仅支持 http/https 链接。".to_string());
    }
    app.opener()
        .open_url(trimmed.to_string(), None::<String>)
        .map_err(|err| format!("打开链接失败: {err}"))?;
    Ok(true)
}

pub(super) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
