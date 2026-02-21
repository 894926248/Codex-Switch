fn candidate_vscode_user_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            let base = PathBuf::from(appdata);
            for product in ["Code", "Code - Insiders", "Cursor", "Windsurf", "Kiro"] {
                let root = base.join(product).join("User");
                if root.exists() {
                    push_unique_dir_entry(&mut roots, &mut seen, root);
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            for rel in [
                ".config/Code/User",
                ".config/Code - Insiders/User",
                ".config/Cursor/User",
                ".config/Windsurf/User",
                ".config/Kiro/User",
            ] {
                let root = home.join(rel);
                if root.exists() {
                    push_unique_dir_entry(&mut roots, &mut seen, root);
                }
            }
        }
    }
    roots
}

fn collect_workspace_state_db_files(user_root: &Path) -> Vec<PathBuf> {
    let workspace_root = user_root.join("workspaceStorage");
    let mut dbs: Vec<PathBuf> = Vec::new();
    let Ok(entries) = fs::read_dir(workspace_root) else {
        return dbs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let db = path.join("state.vscdb");
        if db.exists() {
            dbs.push(db);
        }
    }
    dbs
}

fn run_sqlite3_internal(db_path: &Path, sql: &str, json_mode: bool) -> CmdResult<String> {
    if !db_path.exists() {
        return Err(format!("数据库不存在: {}", db_path.display()));
    }
    let mut cmd = command_no_window("sqlite3");
    if json_mode {
        cmd.arg("-json");
    }
    let mut child = cmd
        .arg(db_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("执行 sqlite3 失败 ({}): {err}", db_path.display()))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(sql.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|err| format!("写入 sqlite3 输入失败 ({}): {err}", db_path.display()))?;
    } else {
        return Err(format!(
            "执行 sqlite3 失败 ({}): 无法获取 stdin",
            db_path.display()
        ));
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("等待 sqlite3 结果失败 ({}): {err}", db_path.display()))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit {}", output.status)
    };
    Err(format!(
        "sqlite3 执行失败 ({}): {detail}",
        db_path.display()
    ))
}

fn sqlite_count_internal(db_path: &Path, sql: &str) -> CmdResult<i64> {
    let output = run_sqlite3_internal(db_path, sql, false)?;
    let line = output.lines().next().unwrap_or("0").trim();
    line.parse::<i64>()
        .map_err(|err| format!("解析 sqlite 计数失败 ({}): {err}", db_path.display()))
}

fn load_global_openai_state_json_internal(db_path: &Path) -> CmdResult<Option<Value>> {
    let output = run_sqlite3_internal(
        db_path,
        "SELECT value FROM ItemTable WHERE key='openai.chatgpt' LIMIT 1;",
        true,
    )?;
    if output.trim().is_empty() {
        return Ok(None);
    }
    let rows: Value = serde_json::from_str(&output)
        .map_err(|err| format!("解析 sqlite JSON 结果失败 ({}): {err}", db_path.display()))?;
    let raw = rows
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("value"))
        .and_then(Value::as_str);
    let Some(raw) = raw else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(raw).map_err(|err| {
        format!(
            "解析 openai.chatgpt JSON 失败 ({}): {err}",
            db_path.display()
        )
    })?;
    Ok(Some(parsed))
}

fn save_global_openai_state_json_internal(db_path: &Path, state: &Value) -> CmdResult<()> {
    let serialized = serde_json::to_string(state)
        .map_err(|err| format!("序列化 openai.chatgpt JSON 失败: {err}"))?;
    let escaped = serialized.replace('\'', "''");
    let sql = format!(
        "PRAGMA busy_timeout=1500; UPDATE ItemTable SET value='{escaped}' WHERE key='openai.chatgpt';"
    );
    run_sqlite3_internal(db_path, &sql, false).map(|_| ())
}

fn sanitize_global_openai_state_json_internal(state: &mut Value) -> bool {
    let Some(root) = state.as_object_mut() else {
        return false;
    };
    let mut changed = false;

    let empty_titles = json!({
        "titles": {},
        "order": [],
    });
    if root.get("thread-titles") != Some(&empty_titles) {
        root.insert("thread-titles".to_string(), empty_titles);
        changed = true;
    }

    let sandbox_off = Value::Bool(false);
    if root.get(OPENAI_STATE_WINDOWS_SANDBOX_KEY) != Some(&sandbox_off) {
        root.insert(OPENAI_STATE_WINDOWS_SANDBOX_KEY.to_string(), sandbox_off);
        changed = true;
    }

    changed
}

fn purge_global_openai_thread_indexes_internal(db_path: &Path) -> CmdResult<bool> {
    let Some(mut state) = load_global_openai_state_json_internal(db_path)? else {
        return Ok(false);
    };
    if !sanitize_global_openai_state_json_internal(&mut state) {
        return Ok(false);
    }
    save_global_openai_state_json_internal(db_path, &state)?;
    Ok(true)
}

fn purge_workspace_agent_sessions_cache_internal(db_path: &Path) -> CmdResult<bool> {
    let hit_count = sqlite_count_internal(
        db_path,
        "SELECT count(*) FROM ItemTable WHERE key='agentSessions.model.cache' AND value LIKE '%openai-codex://route/local/%';",
    )?;
    if hit_count <= 0 {
        return Ok(false);
    }
    run_sqlite3_internal(
        db_path,
        "PRAGMA busy_timeout=1500; DELETE FROM ItemTable WHERE key IN ('agentSessions.model.cache','agentSessions.state.cache');",
        false,
    )?;
    Ok(true)
}

fn purge_stale_codex_session_indexes_internal() -> CmdResult<String> {
    let roots = candidate_vscode_user_roots();
    if roots.is_empty() {
        return Err("未找到编辑器 User 目录，无法执行会话索引清理。".to_string());
    }

    let mut global_scanned = 0usize;
    let mut global_cleaned = 0usize;
    let mut workspace_scanned = 0usize;
    let mut workspace_cleaned = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for root in roots {
        let global_db = root.join("globalStorage").join("state.vscdb");
        if global_db.exists() {
            global_scanned = global_scanned.saturating_add(1);
            match purge_global_openai_thread_indexes_internal(&global_db) {
                Ok(changed) => {
                    if changed {
                        global_cleaned = global_cleaned.saturating_add(1);
                    }
                }
                Err(err) => {
                    if errors.len() < AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES {
                        errors.push(err);
                    }
                }
            }
        }

        for db in collect_workspace_state_db_files(&root) {
            workspace_scanned = workspace_scanned.saturating_add(1);
            match purge_workspace_agent_sessions_cache_internal(&db) {
                Ok(changed) => {
                    if changed {
                        workspace_cleaned = workspace_cleaned.saturating_add(1);
                    }
                }
                Err(err) => {
                    if errors.len() < AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES {
                        errors.push(err);
                    }
                }
            }
        }
    }

    let mut summary = if global_cleaned == 0 && workspace_cleaned == 0 {
        format!(
            "未发现需要清理的陈旧索引（全局库 {global_scanned} 个，工作区库 {workspace_scanned} 个）。"
        )
    } else {
        format!(
            "已清理 Codex 会话索引：全局库 {global_cleaned}/{global_scanned}，工作区库 {workspace_cleaned}/{workspace_scanned}。"
        )
    };

    if !errors.is_empty() {
        summary.push_str(&format!(" 部分数据库处理失败: {}", errors.join(" | ")));
    }

    if global_scanned == 0 && workspace_scanned == 0 {
        return Err("未找到可处理的 state.vscdb 文件。".to_string());
    }
    if global_cleaned == 0 && workspace_cleaned == 0 && !errors.is_empty() {
        return Err(summary);
    }
    Ok(summary)
}

fn enforce_windows_sandbox_disabled_internal() -> CmdResult<String> {
    let roots = candidate_vscode_user_roots();
    if roots.is_empty() {
        return Err("未找到编辑器 User 目录，无法校验 Windows 沙箱设置。".to_string());
    }

    let mut scanned = 0usize;
    let mut updated = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for root in roots {
        let global_db = root.join("globalStorage").join("state.vscdb");
        if !global_db.exists() {
            continue;
        }
        scanned = scanned.saturating_add(1);
        match load_global_openai_state_json_internal(&global_db) {
            Ok(Some(mut state)) => {
                let changed = if let Some(obj) = state.as_object_mut() {
                    if obj.get(OPENAI_STATE_WINDOWS_SANDBOX_KEY) != Some(&Value::Bool(false)) {
                        obj.insert(
                            OPENAI_STATE_WINDOWS_SANDBOX_KEY.to_string(),
                            Value::Bool(false),
                        );
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if changed {
                    match save_global_openai_state_json_internal(&global_db, &state) {
                        Ok(()) => {
                            updated = updated.saturating_add(1);
                        }
                        Err(err) => {
                            if errors.len() < AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES {
                                errors.push(err);
                            }
                        }
                    }
                }
            }
            Ok(None) => {}
            Err(err) => {
                if errors.len() < AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES {
                    errors.push(err);
                }
            }
        }
    }

    if scanned == 0 {
        return Err("未找到可处理的全局 state.vscdb。".to_string());
    }

    let mut summary = if updated == 0 {
        format!("Windows 沙箱已是关闭状态（{scanned} 个全局库）。")
    } else {
        format!("已关闭 Windows 沙箱实验开关（{updated}/{scanned} 个全局库）。")
    };
    if !errors.is_empty() {
        summary.push_str(&format!(" 部分数据库处理失败: {}", errors.join(" | ")));
    }
    if updated == 0 && !errors.is_empty() {
        return Err(summary);
    }
    Ok(summary)
}

