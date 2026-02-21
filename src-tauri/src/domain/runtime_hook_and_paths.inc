fn parse_auto_switch_mode(mode: Option<&str>) -> AutoSwitchMode {
    match mode.unwrap_or("gpt").trim().to_lowercase().as_str() {
        "opencode" => AutoSwitchMode::OpenCode,
        _ => AutoSwitchMode::Gpt,
    }
}

fn ensure_auto_switch_mode(runtime: &mut AutoSwitchRuntime, mode: AutoSwitchMode) {
    if runtime.monitor_mode == Some(mode) {
        return;
    }
    *runtime = AutoSwitchRuntime::default();
    runtime.monitor_mode = Some(mode);
}

fn now_iso() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn app_server_debug_enabled() -> bool {
    match env::var(APP_SERVER_DEBUG_ENV) {
        Ok(value) => {
            let lowered = value.trim().to_lowercase();
            !matches!(lowered.as_str(), "0" | "false" | "off" | "no")
        }
        Err(_) => false,
    }
}

fn app_server_log(enabled: bool, message: impl AsRef<str>) {
    let text = message.as_ref();
    if enabled {
        eprintln!("[codex-switch][app-server] {text}");
    }
    if let Some(app) = APP_RUNTIME_HANDLE.get() {
        let payload = json!({
            "message": text,
            "ts": now_iso(),
        });
        let _ = app.emit("codex-switch://app-server-log", payload);
    }
}

fn redact_app_server_request_for_log(req: &Value) -> String {
    let mut sanitized = req.clone();
    if let Some(method) = sanitized.get("method").and_then(Value::as_str) {
        if method == "account/login/start" {
            if let Some(params) = sanitized.get_mut("params").and_then(Value::as_object_mut) {
                if params.get("type").and_then(Value::as_str) == Some("chatgptAuthTokens") {
                    if params.contains_key("accessToken") {
                        params.insert(
                            "accessToken".to_string(),
                            Value::String("<redacted>".to_string()),
                        );
                    }
                }
            }
        }
    }
    serde_json::to_string(&sanitized).unwrap_or_else(|_| "<invalid-json>".to_string())
}

fn dedupe_push_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf) {
    let key = path.to_string_lossy().to_lowercase();
    if key.is_empty() || seen.contains(&key) {
        return;
    }
    seen.insert(key);
    paths.push(path);
}

fn candidate_codex_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(bin) = env::var_os("CODEX_BIN") {
        dedupe_push_path(&mut paths, &mut seen, PathBuf::from(bin));
    }

    let env_path = env::var_os("PATH").unwrap_or_default();
    for dir in env::split_paths(&env_path) {
        for name in ["codex.exe", "codex.cmd", "codex.bat", "codex.ps1", "codex"] {
            dedupe_push_path(&mut paths, &mut seen, dir.join(name));
        }
    }

    if let Ok(home) = home_dir() {
        let appdata_npm = home.join("AppData").join("Roaming").join("npm");
        for name in ["codex.exe", "codex.cmd", "codex.ps1", "codex.bat", "codex"] {
            dedupe_push_path(&mut paths, &mut seen, appdata_npm.join(name));
        }

        for ext_base in [
            home.join(".vscode").join("extensions"),
            home.join(".cursor").join("extensions"),
            home.join(".windsurf").join("extensions"),
            home.join(".kiro").join("extensions"),
        ] {
            if !ext_base.exists() {
                continue;
            }
            if let Ok(entries) = fs::read_dir(ext_base) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    if !(file_name.starts_with("openai.chatgpt-") || file_name == "openai.chatgpt")
                    {
                        continue;
                    }
                    dedupe_push_path(
                        &mut paths,
                        &mut seen,
                        path.join("bin").join("windows-x86_64").join("codex.exe"),
                    );
                }
            }
        }
    }

    paths
}

fn resolve_codex_binary() -> CmdResult<PathBuf> {
    if let Some(bin) = env::var_os("CODEX_BIN") {
        let path = PathBuf::from(bin);
        if path.exists() {
            let ext = path
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if ext == "ps1" {
                let mut alternatives: Vec<PathBuf> = Vec::new();
                alternatives.push(path.with_extension("cmd"));
                alternatives.push(path.with_extension("exe"));
                alternatives.push(path.with_extension("bat"));
                if let Some(parent) = path.parent() {
                    alternatives.push(parent.join("codex.cmd"));
                    alternatives.push(parent.join("codex.exe"));
                }
                for alt in alternatives {
                    if alt.exists() {
                        return Ok(alt);
                    }
                }
            }
            return Ok(path);
        }
    }

    let candidates = candidate_codex_paths();
    let score_path = |path: &Path| -> i32 {
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mut score = match ext.as_str() {
            "exe" => 0,
            "cmd" => 1,
            "bat" => 2,
            "" => 3,
            "ps1" => 8,
            _ => 4,
        };
        let lower = path.to_string_lossy().to_ascii_lowercase();
        if lower.contains("\\appdata\\roaming\\npm\\") {
            score -= 2;
        }
        if lower.contains("\\.vscode\\extensions\\openai.chatgpt-")
            || lower.contains("\\.cursor\\extensions\\openai.chatgpt-")
            || lower.contains("\\.windsurf\\extensions\\openai.chatgpt-")
            || lower.contains("\\.kiro\\extensions\\openai.chatgpt-")
            || lower.contains("\\.kiro\\extensions\\openai.chatgpt\\")
        {
            score += 8;
        }
        if lower.contains("\\windowsapps\\") {
            score += 10;
        }
        score
    };

    let mut best: Option<(i32, usize, PathBuf)> = None;
    for (idx, candidate) in candidates.iter().enumerate() {
        if !candidate.exists() {
            continue;
        }
        let score = score_path(candidate);
        match &best {
            Some((best_score, best_idx, _)) if (*best_score, *best_idx) <= (score, idx) => {}
            _ => best = Some((score, idx, candidate.clone())),
        }
    }
    if let Some((_, _, path)) = best {
        return Ok(path);
    }
    let preview: Vec<String> = candidates
        .iter()
        .take(6)
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    Err(format!(
        "未找到 codex 可执行文件。可尝试设置环境变量 CODEX_BIN 指向 codex.exe。已尝试: {}",
        preview.join(" | ")
    ))
}

fn candidate_chatgpt_extension_js_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let Ok(home) = home_dir() else {
        return paths;
    };
    let ext_roots = [
        home.join(".vscode").join("extensions"),
        home.join(".vscode-insiders").join("extensions"),
        home.join(".cursor").join("extensions"),
        home.join(".windsurf").join("extensions"),
        home.join(".kiro").join("extensions"),
    ];

    for ext_root in ext_roots {
        if !ext_root.exists() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&ext_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !(file_name.starts_with("openai.chatgpt-") || file_name == "openai.chatgpt") {
                continue;
            }
            let js_path = entry.path().join("out").join("extension.js");
            if !js_path.exists() {
                continue;
            }
            dedupe_push_path(&mut paths, &mut seen, js_path);
        }
    }

    paths
}

fn extract_chatgpt_extension_version(dir_name: &str) -> Option<String> {
    let prefix = "openai.chatgpt-";
    if !dir_name.starts_with(prefix) {
        return None;
    }
    let rest = &dir_name[prefix.len()..];
    let mut version = String::new();
    for ch in rest.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            version.push(ch);
            continue;
        }
        if ch == '-' {
            break;
        }
        break;
    }
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn compare_semver_like(a: &str, b: &str) -> CmpOrdering {
    let pa: Vec<u64> = a
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    let pb: Vec<u64> = b
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    let max_len = pa.len().max(pb.len());
    for idx in 0..max_len {
        let av = *pa.get(idx).unwrap_or(&0);
        let bv = *pb.get(idx).unwrap_or(&0);
        match av.cmp(&bv) {
            CmpOrdering::Equal => continue,
            ord => return ord,
        }
    }
    CmpOrdering::Equal
}

fn collect_chatgpt_extension_versions_internal() -> Vec<String> {
    let mut set: HashSet<String> = HashSet::new();
    for path in candidate_chatgpt_extension_js_paths() {
        let Some(ext_dir) = path.parent().and_then(Path::parent) else {
            continue;
        };
        let Some(dir_name) = ext_dir.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if let Some(version) = extract_chatgpt_extension_version(dir_name) {
            set.insert(version);
        }
    }
    let mut versions: Vec<String> = set.into_iter().collect();
    versions.sort_by(|a, b| compare_semver_like(b, a));
    versions
}

fn get_codex_extension_info_internal() -> CodexExtensionInfoView {
    let all_versions = collect_chatgpt_extension_versions_internal();
    let current_version = all_versions.first().cloned();
    CodexExtensionInfoView {
        current_version,
        all_versions,
    }
}

fn hook_has_auth_watch(content: &str) -> bool {
    content.contains(CODEX_SWITCH_HOOK_WATCH_MARKER)
        || content.contains(CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL)
        || content.contains(CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT)
}

fn hook_has_signal_watch(content: &str) -> bool {
    content.contains(CODEX_SWITCH_HOOK_SIGNAL_MARKER)
        || content.contains(CODEX_SWITCH_HOOK_KIRO_SIGNAL_MARKER)
        || content.contains(CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL)
        || content.contains(CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT)
}

fn hook_has_newchat_watch(content: &str) -> bool {
    content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT)
}

fn hook_has_legacy_newchat_watch(content: &str) -> bool {
    content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V8)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V8)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V7)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V7)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V6)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V6)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V5)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V5)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V4)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V4)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V3)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V3)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V2)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V2)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_LEGACY)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_LEGACY)
}

fn replace_all_legacy_newchat_watch_fragments(content: &str) -> String {
    content
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V8,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V7,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V6,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V5,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V4,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V3,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V2,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_LEGACY,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
}

fn append_newchat_watch_fragment(content: &str) -> Option<String> {
    for fragment in [
        CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT,
        CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT,
    ] {
        if content.contains(fragment) {
            return Some(content.replacen(
                fragment,
                &format!("{fragment},{}", CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT),
                1,
            ));
        }
    }
    None
}

fn build_codex_hook_fragment_v4() -> String {
    format!(
        "{},{},{},{}",
        CODEX_SWITCH_HOOK_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT
    )
}

fn build_codex_hook_inject_v4() -> String {
    let hook_fragment = build_codex_hook_fragment_v4();
    if let Some(prefix) = CODEX_SWITCH_HOOK_ANCHOR.strip_suffix("))") {
        format!("{prefix},{hook_fragment}))")
    } else {
        CODEX_SWITCH_HOOK_ANCHOR.replacen("))", &format!(",{hook_fragment}))"), 1)
    }
}

fn hook_backup_path_for(extension_js: &Path) -> PathBuf {
    let file_name = extension_js
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("extension.js");
    extension_js.with_file_name(format!("{file_name}{CODEX_SWITCH_HOOK_BACKUP_SUFFIX}"))
}

fn is_kiro_extension_path(path: &Path) -> bool {
    let lower = path.to_string_lossy().to_ascii_lowercase();
    lower.contains("\\.kiro\\extensions\\openai.chatgpt")
        || lower.contains("/.kiro/extensions/openai.chatgpt")
}

fn normalize_editor_target(target: Option<&str>) -> &'static str {
    match target
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("kiro") => "kiro",
        _ => "vscode",
    }
}

fn path_matches_editor_target(path: &Path, target: Option<&str>) -> bool {
    let editor = normalize_editor_target(target);
    if editor == "kiro" {
        is_kiro_extension_path(path)
    } else {
        !is_kiro_extension_path(path)
    }
}

fn has_codex_hook_installed_internal(target: Option<&str>) -> bool {
    let paths = candidate_chatgpt_extension_js_paths();
    for path in paths {
        if !path_matches_editor_target(&path, target) {
            continue;
        }
        if let Ok(content) = fs::read_to_string(&path) {
            if is_kiro_extension_path(&path) && hook_has_signal_watch(&content) {
                return true;
            }
            if content.contains(CODEX_SWITCH_HOOK_COMMAND_ID)
                && content.contains(CODEX_SWITCH_HOOK_ACCEL_MARKER)
                && hook_has_auth_watch(&content)
                && hook_has_signal_watch(&content)
                && hook_has_newchat_watch(&content)
            {
                return true;
            }
        }
    }
    false
}

fn has_codex_hook_watch_installed_internal() -> bool {
    let paths = candidate_chatgpt_extension_js_paths();
    for path in paths {
        if let Ok(content) = fs::read_to_string(&path) {
            if hook_has_auth_watch(&content) || hook_has_signal_watch(&content) {
                return true;
            }
        }
    }
    false
}

fn has_codex_hook_signal_watch_installed_internal() -> bool {
    let paths = candidate_chatgpt_extension_js_paths();
    for path in paths {
        if let Ok(content) = fs::read_to_string(&path) {
            if hook_has_signal_watch(&content) {
                return true;
            }
        }
    }
    false
}

fn has_codex_hook_newchat_watch_installed_internal() -> bool {
    let paths = candidate_chatgpt_extension_js_paths();
    for path in paths {
        if let Ok(content) = fs::read_to_string(&path) {
            if hook_has_newchat_watch(&content) {
                return true;
            }
        }
    }
    false
}

fn install_codex_hook_internal(target: Option<&str>) -> CmdResult<String> {
    let paths: Vec<PathBuf> = candidate_chatgpt_extension_js_paths()
        .into_iter()
        .filter(|path| path_matches_editor_target(path, target))
        .collect();
    if paths.is_empty() {
        return Err("未找到 openai.chatgpt 扩展文件，请先安装官方 Codex 扩展。".to_string());
    }

    let mut patched: Vec<String> = Vec::new();
    let mut already: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    let hook_fragment_v4 = build_codex_hook_fragment_v4();
    let hook_inject_v4 = build_codex_hook_inject_v4();

    for path in paths {
        let display = path.to_string_lossy().to_string();
        let content = match fs::read_to_string(&path) {
            Ok(v) => v,
            Err(err) => {
                failed.push(format!("{display}: 读取失败 {err}"));
                continue;
            }
        };

        let replaced = if hook_has_legacy_newchat_watch(&content) {
            let mut normalized = replace_all_legacy_newchat_watch_fragments(&content);
            if !hook_has_newchat_watch(&normalized) {
                if let Some(updated) = append_newchat_watch_fragment(&normalized) {
                    normalized = updated;
                } else {
                    failed.push(format!(
                        "{display}: 检测到旧版新对话 Hook，但未命中可升级片段，请先恢复扩展后重试"
                    ));
                    continue;
                }
            }
            normalized
        } else if content.contains(CODEX_SWITCH_HOOK_COMMAND_ID)
            && content.contains(CODEX_SWITCH_HOOK_ACCEL_MARKER)
            && hook_has_auth_watch(&content)
            && hook_has_signal_watch(&content)
            && hook_has_newchat_watch(&content)
        {
            let has_accel_auth_watch =
                content.contains(CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL);
            let has_accel_signal_watch =
                content.contains(CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL);
            let mut refreshed = content
                .replace(
                    CODEX_SWITCH_HOOK_FRAGMENT_ACCEL_V1,
                    CODEX_SWITCH_HOOK_FRAGMENT_ACCEL,
                )
                .replace(
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL_V1,
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
                )
                .replace(
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL_V2,
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
                )
                .replace(
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL_V1,
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
                )
                .replace(
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL_V2,
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
                )
                .replace(
                    "setInterval(()=>{Le()},1200);",
                    "setInterval(()=>{Le()},500);",
                )
                .replace(
                    "setInterval(()=>{Le()},700);",
                    "setInterval(()=>{Le()},300);",
                );
            refreshed = if has_accel_auth_watch {
                refreshed.replace(
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT,
                    CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
                )
            } else {
                refreshed.replace(
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT,
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
                )
            };
            refreshed = if has_accel_signal_watch {
                refreshed.replace(
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT,
                    CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
                )
            } else {
                refreshed.replace(
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT,
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
                )
            };
            if refreshed == content {
                already.push(display);
                continue;
            }
            refreshed
        } else if content.contains(&hook_fragment_v4) {
            already.push(display);
            continue;
        } else if content.contains(CODEX_SWITCH_HOOK_COMMAND_ID)
            && hook_has_auth_watch(&content)
            && hook_has_signal_watch(&content)
            && !hook_has_newchat_watch(&content)
        {
            if let Some(updated) = append_newchat_watch_fragment(&content) {
                updated
            } else {
                failed.push(format!(
                    "{display}: 检测到旧版 Hook（缺少新对话监听），但未命中可升级片段，请先恢复扩展后重试"
                ));
                continue;
            }
        } else if content.contains(CODEX_SWITCH_HOOK_FRAGMENT_V3) {
            content.replacen(CODEX_SWITCH_HOOK_FRAGMENT_V3, &hook_fragment_v4, 1)
        } else if content.contains(CODEX_SWITCH_HOOK_FRAGMENT_V2) {
            content.replacen(CODEX_SWITCH_HOOK_FRAGMENT_V2, &hook_fragment_v4, 1)
        } else if content.contains(CODEX_SWITCH_HOOK_FRAGMENT_V1) {
            content.replacen(CODEX_SWITCH_HOOK_FRAGMENT_V1, &hook_fragment_v4, 1)
        } else if content.contains(CODEX_SWITCH_HOOK_COMMAND_ID) {
            // A non-standard old patch exists; ask user to reinstall cleanly.
            failed.push(format!(
                "{display}: 检测到旧版/自定义 Hook 片段，无法自动升级，请先恢复扩展后重试"
            ));
            continue;
        } else {
            if content.contains(CODEX_SWITCH_HOOK_ANCHOR) {
                content.replacen(CODEX_SWITCH_HOOK_ANCHOR, &hook_inject_v4, 1)
            } else if is_kiro_extension_path(&path) {
                if content.contains(CODEX_SWITCH_HOOK_KIRO_SIGNAL_MARKER)
                    || content.contains(CODEX_SWITCH_HOOK_KIRO_SIGNAL_WATCH_FRAGMENT)
                {
                    already.push(display);
                    continue;
                }
                format!(
                    "{content}\n;{}\n",
                    CODEX_SWITCH_HOOK_KIRO_SIGNAL_WATCH_FRAGMENT
                )
            } else {
                failed.push(format!("{display}: 未匹配到 Hook 注入锚点"));
                continue;
            }
        };

        if replaced == content {
            failed.push(format!("{display}: Hook 注入失败（内容未变化）"));
            continue;
        }

        let backup_path = hook_backup_path_for(&path);
        if !backup_path.exists() {
            if let Err(err) = fs::write(&backup_path, &content) {
                failed.push(format!(
                    "{display}: 创建备份失败 {} -> {err}",
                    backup_path.display()
                ));
                continue;
            }
        }

        if let Err(err) = fs::write(&path, replaced) {
            failed.push(format!("{display}: 写入失败 {err}"));
            continue;
        }
        patched.push(display);
    }

    let mut summary_parts: Vec<String> = Vec::new();
    if !patched.is_empty() {
        summary_parts.push(format!("已安装 Hook {} 处", patched.len()));
    }
    if !already.is_empty() {
        summary_parts.push(format!("已存在 Hook {} 处", already.len()));
    }
    if !failed.is_empty() {
        summary_parts.push(format!("失败 {} 处", failed.len()));
    }
    if summary_parts.is_empty() {
        summary_parts.push("未做任何变更".to_string());
    }

    let mut summary = summary_parts.join("，");
    if !patched.is_empty() {
        summary.push_str(
            "。首次安装后请执行一次“方案2：Hook 提速版”或“方案1：重启 Extension Host”以加载 Hook（含账号变更监听）。",
        );
    }
    if !failed.is_empty() {
        summary.push_str("。失败详情: ");
        summary.push_str(&failed.join(" | "));
    }
    Ok(summary)
}

