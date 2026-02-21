fn candidate_vscode_log_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            let base = PathBuf::from(appdata);
            for product in ["Code", "Code - Insiders", "Cursor", "Windsurf", "Kiro"] {
                let path = base.join(product).join("logs");
                if path.exists() {
                    roots.push(path);
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            for rel in [
                ".config/Code/logs",
                ".config/Code - Insiders/logs",
                ".config/Cursor/logs",
                ".config/Windsurf/logs",
                ".config/Kiro/logs",
            ] {
                let path = home.join(rel);
                if path.exists() {
                    roots.push(path);
                }
            }
        }
    }
    roots
}

fn collect_codex_extension_log_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_codex_extension_log_files(&path, out);
            continue;
        }
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if name != "Codex.log" {
            continue;
        }
        let text = path.to_string_lossy();
        if text.contains("openai.chatgpt") {
            out.push(path);
        }
    }
}

fn find_latest_codex_extension_log_file() -> Option<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    for root in candidate_vscode_log_roots() {
        collect_codex_extension_log_files(&root, &mut files);
    }
    let mut latest: Option<(SystemTime, PathBuf)> = None;
    for file in files {
        let modified = fs::metadata(&file)
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match &latest {
            Some((ts, _)) if modified < *ts => {}
            _ => latest = Some((modified, file)),
        }
    }
    latest.map(|(_, path)| path)
}

fn editor_kind_from_codex_log_path(path: &Path) -> Option<&'static str> {
    let text = path.to_string_lossy().to_lowercase();
    if text.contains("\\windsurf\\logs\\") || text.contains("/windsurf/logs/") {
        return Some("windsurf");
    }
    if text.contains("\\cursor\\logs\\") || text.contains("/cursor/logs/") {
        return Some("cursor");
    }
    if text.contains("\\kiro\\logs\\") || text.contains("/kiro/logs/") {
        return Some("kiro");
    }
    if text.contains("\\code - insiders\\logs\\")
        || text.contains("\\code\\logs\\")
        || text.contains("/code - insiders/logs/")
        || text.contains("/code/logs/")
    {
        return Some("vscode");
    }
    None
}

fn reset_codex_log_tail_state(state: &mut CodexLogTailState, path: PathBuf) {
    let offset = fs::metadata(&path).ok().map(|m| m.len()).unwrap_or(0);
    state.current_file = Some(path);
    state.offset = offset;
}

fn codex_log_line_has_thread_not_found(line: &str) -> bool {
    let lowered = line.to_lowercase();
    if !lowered.contains("thread not found") {
        return false;
    }
    lowered.contains("method=turn/start")
        || lowered.contains("[composer] submit failed")
        || lowered.contains("submit failed")
}

fn codex_log_line_has_rollout_missing(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("no rollout found for thread id")
        || lowered.contains("no rollout found for conversation id")
        || lowered.contains("failed to resume conversation")
        || lowered.contains("failed to resume task")
        || lowered.contains("no-client-found")
}

fn codex_log_line_has_runtime_unavailable(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("codex process is not available")
        || lowered.contains("codex app-server process exited unexpectedly")
        || lowered.contains("process exited unexpectedly")
}

fn codex_log_line_has_turn_metadata_timeout(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("turn_metadata: timed out after 250ms")
        || lowered.contains("timed out after 250ms while building turn metadata header")
}

fn codex_log_line_has_runtime_restart(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("spawning codex app-server") || lowered.contains("initialize received (id={})")
}

fn process_codex_log_line(line: &str, runtime: &mut AutoSwitchRuntime) {
    if codex_log_line_has_thread_not_found(line) {
        runtime.codex_log.thread_not_found_seq =
            runtime.codex_log.thread_not_found_seq.saturating_add(1);
    }
    if codex_log_line_has_rollout_missing(line) {
        runtime.codex_log.rollout_missing_seq =
            runtime.codex_log.rollout_missing_seq.saturating_add(1);
    }
    if codex_log_line_has_runtime_unavailable(line) {
        runtime.codex_log.runtime_unavailable_seq =
            runtime.codex_log.runtime_unavailable_seq.saturating_add(1);
    }
    if codex_log_line_has_turn_metadata_timeout(line) {
        runtime.codex_log.turn_metadata_timeout_seq = runtime
            .codex_log
            .turn_metadata_timeout_seq
            .saturating_add(1);
    }
    if codex_log_line_has_runtime_restart(line) {
        runtime.codex_log.runtime_restart_seq =
            runtime.codex_log.runtime_restart_seq.saturating_add(1);
    }
}

fn sync_codex_log_tail(runtime: &mut AutoSwitchRuntime) -> CmdResult<()> {
    let now_ms = now_ts_ms();
    let should_scan = runtime.codex_log.current_file.is_none()
        || now_ms - runtime.codex_log.last_scan_at_ms >= AUTO_SWITCH_CODEX_LOG_SCAN_INTERVAL_MS;
    if should_scan {
        if let Some(latest_file) = find_latest_codex_extension_log_file() {
            let changed = runtime
                .codex_log
                .current_file
                .as_ref()
                .map(|p| p != &latest_file)
                .unwrap_or(true);
            if changed {
                reset_codex_log_tail_state(&mut runtime.codex_log, latest_file);
                runtime.last_observed_thread_not_found_seq = runtime.codex_log.thread_not_found_seq;
                runtime.last_observed_rollout_missing_seq = runtime.codex_log.rollout_missing_seq;
                runtime.last_observed_runtime_unavailable_seq =
                    runtime.codex_log.runtime_unavailable_seq;
                runtime.last_observed_turn_metadata_timeout_seq =
                    runtime.codex_log.turn_metadata_timeout_seq;
            }
        }
        runtime.codex_log.last_scan_at_ms = now_ms;
    }

    let Some(path) = runtime.codex_log.current_file.clone() else {
        return Ok(());
    };
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(()),
    };
    let file_len = file.metadata().ok().map(|m| m.len()).unwrap_or(0);
    if runtime.codex_log.offset > file_len {
        runtime.codex_log.offset = file_len;
    }
    if file
        .seek(SeekFrom::Start(runtime.codex_log.offset))
        .is_err()
    {
        return Ok(());
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取 Codex 扩展日志失败: {e}"))?;
        if bytes == 0 {
            break;
        }
        let clean = line.trim_end_matches(&['\r', '\n'][..]);
        process_codex_log_line(clean, runtime);
    }
    runtime.codex_log.offset = reader.stream_position().unwrap_or(file_len);
    Ok(())
}

fn auto_switch_signature(runtime: &AutoSwitchRuntime) -> AutoSwitchSignature {
    AutoSwitchSignature {
        event_seq: runtime.session.event_seq,
        user_seq: runtime.session.user_seq,
        open_turn_count: runtime.session.open_turns.len(),
    }
}

fn active_profile_quota_from_store(
    store: &StoreData,
    active_profile_name: Option<&str>,
) -> (Option<i64>, Option<i64>) {
    let Some(active_name) = active_profile_name else {
        return (None, None);
    };
    let Some(record) = store.profiles.get(active_name).and_then(Value::as_object) else {
        return (None, None);
    };
    let (five, _, week, _) = quota_fields_from_record(record);
    (five, week)
}

fn session_quota_is_fresh_for_trigger(runtime: &AutoSwitchRuntime, now_ms: i64) -> bool {
    let Some(updated_at) = runtime.session.quota.updated_at_ms else {
        return false;
    };
    if runtime.last_switch_applied_at_ms > 0 && updated_at < runtime.last_switch_applied_at_ms {
        return false;
    }
    now_ms - updated_at <= AUTO_SWITCH_SESSION_QUOTA_MAX_AGE_MS
}

fn current_quota_for_trigger(
    runtime: &AutoSwitchRuntime,
    store: &StoreData,
    now_ms: i64,
    active_profile_name: Option<&str>,
) -> (Option<i64>, Option<i64>) {
    let session_five = runtime.session.quota.five_hour_remaining_percent;
    let session_week = runtime.session.quota.one_week_remaining_percent;
    let (store_five, store_week) = active_profile_quota_from_store(store, active_profile_name);
    if session_quota_is_fresh_for_trigger(runtime, now_ms) {
        (session_five.or(store_five), session_week.or(store_week))
    } else {
        (store_five.or(session_five), store_week.or(session_week))
    }
}

fn update_session_quota_snapshot_from_account(
    runtime: &mut AutoSwitchRuntime,
    quota: &AccountQuota,
    now_ms: i64,
) {
    runtime.session.quota.five_hour_remaining_percent =
        quota.five_hour.as_ref().and_then(|v| v.remaining_percent);
    runtime.session.quota.one_week_remaining_percent =
        quota.one_week.as_ref().and_then(|v| v.remaining_percent);
    runtime.session.quota.five_hour_resets_at = quota.five_hour.as_ref().and_then(|v| v.resets_at);
    runtime.session.quota.one_week_resets_at = quota.one_week.as_ref().and_then(|v| v.resets_at);
    runtime.session.quota.updated_at_ms = Some(now_ms);
}

fn fetch_live_quota_for_trigger(
    mode: AutoSwitchMode,
    store: &StoreData,
) -> CmdResult<AccountQuota> {
    match mode {
        AutoSwitchMode::Gpt => {
            let live_result = codex_home().and_then(|home| {
                fetch_quota_from_codex_home_with_timeout(
                    &home,
                    false,
                    AUTO_SWITCH_LIVE_QUOTA_TIMEOUT_SECONDS,
                )
            });
            match live_result {
                Ok(quota) => Ok(quota),
                Err(live_err) => quota_from_rollout_snapshot(store)
                    .or_else(|| quota_from_active_profile_record(store))
                    .ok_or_else(|| {
                        format!("实时额度查询失败: {live_err}；且未读取到 GPT 本地会话额度快照。")
                    }),
            }
        }
        AutoSwitchMode::OpenCode => {
            fetch_quota_from_live_opencode_auth_with_timeout(AUTO_SWITCH_LIVE_QUOTA_TIMEOUT_SECONDS)
        }
    }
}

fn maybe_sync_live_quota_for_trigger(
    runtime: &mut AutoSwitchRuntime,
    mode: AutoSwitchMode,
    store: &StoreData,
    now_ms: i64,
    force: bool,
) {
    if !force
        && runtime.last_live_quota_sync_at_ms > 0
        && now_ms - runtime.last_live_quota_sync_at_ms < AUTO_SWITCH_LIVE_QUOTA_SYNC_INTERVAL_MS
    {
        return;
    }
    if !force {
        let recent_error = if matches!(mode, AutoSwitchMode::Gpt) {
            current_quota_runtime_error_is_hot(now_ms, AUTO_SWITCH_LIVE_QUOTA_ERROR_COOLDOWN_MS)
        } else {
            opencode_quota_runtime_error_is_hot(now_ms, AUTO_SWITCH_LIVE_QUOTA_ERROR_COOLDOWN_MS)
        };
        if recent_error {
            return;
        }
    }
    runtime.last_live_quota_sync_at_ms = now_ms;

    match fetch_live_quota_for_trigger(mode, store) {
        Ok(quota) => {
            let refreshed_at = now_ts_ms();
            update_session_quota_snapshot_from_account(runtime, &quota, refreshed_at);
            if matches!(mode, AutoSwitchMode::Gpt) {
                update_current_quota_runtime_cache(&quota, refreshed_at);
            } else {
                update_opencode_quota_runtime_cache(&quota, refreshed_at);
            }
        }
        Err(err) => {
            if matches!(mode, AutoSwitchMode::Gpt) {
                mark_current_quota_runtime_error(&err, now_ms);
            } else {
                mark_opencode_quota_runtime_error(&err, now_ms);
            }
        }
    }
}

fn active_profile_name_for_mode(
    store: &StoreData,
    mode: AutoSwitchMode,
    now_ms: i64,
) -> Option<String> {
    match mode {
        AutoSwitchMode::Gpt => store.active_profile.clone(),
        AutoSwitchMode::OpenCode => {
            let live_workspace_id = live_opencode_workspace_id_internal();
            let cached_quota = cached_opencode_quota_snapshot(now_ms).map(|(quota, _)| quota);
            let identity_workspace_id = live_workspace_id.clone().or_else(|| {
                cached_quota
                    .as_ref()
                    .and_then(|quota| quota.workspace_id.clone())
            });
            let identity_email = cached_quota
                .as_ref()
                .and_then(|quota| normalize_identity_value(quota.email.as_deref()));

            if let Some(matched) = find_profile_name_by_identity_prefer_existing(
                store,
                identity_workspace_id.as_deref(),
                identity_email.as_deref(),
            ) {
                return Some(matched);
            }

            find_profile_name_by_identity_prefer_existing(store, live_workspace_id.as_deref(), None)
        }
    }
}

fn opencode_live_auth_workspace_id() -> Option<String> {
    let auth_path = opencode_auth_file().ok()?;
    let entry = read_openai_entry_from_opencode_auth_file(&auth_path)?;
    opencode_workspace_id_from_openai_entry(&entry)
}

fn opencode_live_auth_entry() -> Option<Value> {
    let auth_path = opencode_auth_file().ok()?;
    read_openai_entry_from_opencode_auth_file(&auth_path)
}

fn opencode_snapshot_entry_from_record(name: &str, record: &Map<String, Value>) -> Option<Value> {
    let snapshot_dir = record_snapshot_dir(name, record).ok()?;
    let snapshot_path = snapshot_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME);
    if snapshot_path.exists() {
        let text = fs::read_to_string(&snapshot_path).ok()?;
        let value = serde_json::from_str::<Value>(&text).ok()?;
        if value.is_object() {
            return Some(value);
        }
    }
    None
}

fn opencode_live_matches_target_profile(store: &StoreData, target_profile: &str) -> bool {
    // Fast path: check the auth file identity directly (no API call).
    // After apply_opencode_snapshot_to_live_auth, the file already contains the
    // target account's credentials, so we just need to read workspace_id from it
    // and map it back to a profile name.
    let live_workspace_id = match opencode_live_auth_workspace_id() {
        Some(v) => v,
        None => return false,
    };

    // Read workspace_id from target profile record for direct comparison.
    if let Some(record) = store
        .profiles
        .get(target_profile)
        .and_then(Value::as_object)
    {
        if let Some(target_wid) = read_workspace_id_from_record_or_auth(target_profile, record) {
            if live_workspace_id.eq_ignore_ascii_case(target_wid.trim()) {
                return true;
            }
        }
    }

    // Fallback: identity-based reverse lookup.
    let matched = find_profile_name_by_identity_prefer_existing(
        store,
        Some(live_workspace_id.as_str()),
        None,
    );
    matched
        .map(|name| name.eq_ignore_ascii_case(target_profile))
        .unwrap_or(false)
}

fn soft_trigger_hit(five_hour: Option<i64>, one_week: Option<i64>) -> bool {
    five_hour
        .map(|v| v <= SOFT_TRIGGER_FIVE_HOUR_THRESHOLD)
        .unwrap_or(false)
        || one_week
            .map(|v| v <= SOFT_TRIGGER_ONE_WEEK_THRESHOLD)
            .unwrap_or(false)
}

fn candidate_quota_ok(five_hour: Option<i64>, one_week: Option<i64>) -> bool {
    five_hour
        .map(|v| v > CANDIDATE_MIN_FIVE_HOUR)
        .unwrap_or(false)
        && one_week
            .map(|v| v > CANDIDATE_MIN_ONE_WEEK)
            .unwrap_or(false)
}

fn profile_candidate_ready(store: &StoreData, name: &str) -> bool {
    let Some(record) = store.profiles.get(name).and_then(Value::as_object) else {
        return false;
    };
    let Ok(snapshot_dir) = record_snapshot_dir(name, record) else {
        return false;
    };
    if profile_validity(record, &snapshot_dir) != "正常" {
        return false;
    }
    let (five, _, week, _) = quota_fields_from_record(record);
    candidate_quota_ok(five, week)
}

fn profile_supports_mode(record: &Map<String, Value>, mode: AutoSwitchMode) -> bool {
    let support = profile_support_from_value(record.get("support"));
    match mode {
        AutoSwitchMode::Gpt => support.gpt,
        AutoSwitchMode::OpenCode => support.opencode,
    }
}

fn sync_session_tail_for_mode(
    runtime: &mut AutoSwitchRuntime,
    mode: AutoSwitchMode,
) -> CmdResult<()> {
    match mode {
        AutoSwitchMode::Gpt => sync_session_tail(runtime),
        AutoSwitchMode::OpenCode => sync_opencode_log_tail(runtime),
    }
}

fn run_switch_guard(
    runtime: &mut AutoSwitchRuntime,
    mode: AutoSwitchMode,
) -> CmdResult<Option<AutoSwitchSignature>> {
    let first = auto_switch_signature(runtime);
    if first.open_turn_count > 0 {
        return Ok(None);
    }
    thread::sleep(Duration::from_millis(AUTO_SWITCH_GUARD_WAIT_MS));
    sync_session_tail_for_mode(runtime, mode)?;
    let second = auto_switch_signature(runtime);
    if second != first || second.open_turn_count > 0 {
        return Ok(None);
    }
    thread::sleep(Duration::from_millis(AUTO_SWITCH_GUARD_WAIT_MS));
    sync_session_tail_for_mode(runtime, mode)?;
    let third = auto_switch_signature(runtime);
    if third != second || third.open_turn_count > 0 {
        return Ok(None);
    }
    Ok(Some(third))
}

fn fill_pending_reason(result: &mut AutoSwitchTickResult, runtime: &AutoSwitchRuntime) {
    result.pending_reason = runtime.pending_reason.map(|r| r.as_str().to_string());
}

fn record_stale_recover_hit(
    runtime: &mut AutoSwitchRuntime,
    reason: StaleRecoverReason,
    now_ms: i64,
) -> u32 {
    let same_reason = runtime.last_stale_recover_reason == Some(reason);
    let within_window = runtime.last_stale_recover_at_ms > 0
        && now_ms - runtime.last_stale_recover_at_ms <= AUTO_SWITCH_STALE_RECOVER_WINDOW_MS;
    if same_reason && within_window {
        runtime.stale_recover_repeat_count = runtime.stale_recover_repeat_count.saturating_add(1);
    } else {
        runtime.stale_recover_repeat_count = 1;
    }
    runtime.last_stale_recover_reason = Some(reason);
    runtime.last_stale_recover_at_ms = now_ms;
    runtime.stale_recover_repeat_count
}

fn mark_state_purge_escalated(runtime: &mut AutoSwitchRuntime, now_ms: i64) {
    runtime.state_index_purge_cooldown_until_ms =
        now_ms + AUTO_SWITCH_STATE_INDEX_PURGE_COOLDOWN_MS;
    runtime.last_stale_recover_reason = None;
    runtime.last_stale_recover_at_ms = now_ms;
    runtime.stale_recover_repeat_count = 0;
}

fn recover_runtime_without_new_chat_internal(
    reason: &str,
    allow_extension_host_fallback: bool,
    request_new_chat_reset: bool,
) -> AutoSwitchTickResult {
    let prefer_restart_signal = has_codex_hook_signal_watch_installed_internal();
    let mut notes: Vec<String> = Vec::new();
    let mut recovered = false;

    match enforce_windows_sandbox_disabled_internal() {
        Ok(msg) => notes.push(msg),
        Err(err) => notes.push(format!("Windows 沙箱设置校验失败：{err}")),
    }

    if prefer_restart_signal || has_codex_hook_watch_installed_internal() {
        match trigger_codex_hook_restart_internal(prefer_restart_signal) {
            Ok(msg) => {
                recovered = true;
                notes.push(msg);
            }
            Err(err) => notes.push(format!("运行时重连失败：{err}")),
        }
    } else {
        notes.push("未检测到 Hook 提速监听。".to_string());
    }

    if !recovered && allow_extension_host_fallback {
        match restart_extension_host_internal() {
            Ok(msg) => {
                recovered = true;
                notes.push(format!("已自动降级为方案1。{msg}"));
            }
            Err(err) => notes.push(format!("方案1兜底失败：{err}")),
        }
    } else if !recovered {
        notes.push("为避免打断当前界面，未自动执行方案1兜底。".to_string());
    }

    if request_new_chat_reset {
        if recovered {
            match invoke_vscode_command_uri_internal(
                "chatgpt.newChat",
                "已请求在当前窗口重置为新会话。",
            ) {
                Ok(msg) => notes.push(msg),
                Err(uri_err) => {
                    notes.push(format!("命令重置失败，尝试 Hook 信号。{uri_err}"));
                    match trigger_chatgpt_new_chat_reset_internal(true, false) {
                        Ok(msg) => notes.push(msg),
                        Err(err) => notes.push(format!("同窗口新会话重置未成功：{err}")),
                    }
                }
            }
        } else {
            notes.push("运行时尚未恢复，跳过同窗口新会话重置。".to_string());
        }
    }

    let detail = notes.join(" ");
    let mut result = AutoSwitchTickResult::new("thread_recovering");
    if recovered {
        let mode_text = if request_new_chat_reset {
            "并请求同窗口重置到新会话"
        } else {
            "（不自动新建对话）"
        };
        result.action = "thread_recovered".to_string();
        result.message = Some(format!(
            "检测到{reason}，已自动重连 Codex 运行时{mode_text}。{detail}"
        ));
    } else {
        result.action = "thread_recover_failed".to_string();
        result.message = Some(format!("检测到{reason}，自动重连失败。{detail}"));
    }
    result
}

fn recover_runtime_with_state_purge_internal(
    runtime: &mut AutoSwitchRuntime,
    reason: StaleRecoverReason,
    request_new_chat_reset: bool,
) -> AutoSwitchTickResult {
    let now_ms = now_ts_ms();
    let purge_note = match purge_stale_codex_session_indexes_internal() {
        Ok(msg) => format!("已执行会话索引清理。{msg}"),
        Err(err) => format!("会话索引清理失败：{err}"),
    };
    mark_state_purge_escalated(runtime, now_ms);

    let mut result =
        recover_runtime_without_new_chat_internal(reason.message(), false, request_new_chat_reset);
    if let Some(text) = result.message.as_mut() {
        text.push(' ');
        text.push_str(&purge_note);
    } else {
        result.message = Some(purge_note);
    }
    result
}

fn maybe_recover_stale_thread_from_log(
    runtime: &mut AutoSwitchRuntime,
) -> CmdResult<Option<AutoSwitchTickResult>> {
    sync_codex_log_tail(runtime)?;
    let now_ms = now_ts_ms();
    let reason = if runtime.codex_log.rollout_missing_seq
        > runtime.last_observed_rollout_missing_seq
    {
        runtime.last_observed_rollout_missing_seq = runtime.codex_log.rollout_missing_seq;
        Some(StaleRecoverReason::RolloutMissing)
    } else if runtime.codex_log.thread_not_found_seq > runtime.last_observed_thread_not_found_seq {
        runtime.last_observed_thread_not_found_seq = runtime.codex_log.thread_not_found_seq;
        Some(StaleRecoverReason::ThreadNotFound)
    } else if runtime.codex_log.runtime_unavailable_seq
        > runtime.last_observed_runtime_unavailable_seq
    {
        runtime.last_observed_runtime_unavailable_seq = runtime.codex_log.runtime_unavailable_seq;
        Some(StaleRecoverReason::RuntimeUnavailable)
    } else if runtime.codex_log.turn_metadata_timeout_seq
        > runtime.last_observed_turn_metadata_timeout_seq
    {
        runtime.last_observed_turn_metadata_timeout_seq =
            runtime.codex_log.turn_metadata_timeout_seq;
        Some(StaleRecoverReason::TurnMetadataTimeout)
    } else {
        None
    };
    let Some(reason) = reason else {
        return Ok(None);
    };

    if reason == StaleRecoverReason::TurnMetadataTimeout {
        // This warning is noisy and frequently self-heals; auto-restarting here
        // caused aggressive restart loops.
        return Ok(None);
    }

    if reason == StaleRecoverReason::RuntimeUnavailable
        && runtime.last_runtime_unavailable_recover_restart_seq
            == Some(runtime.codex_log.runtime_restart_seq)
    {
        // Only attempt one automatic recovery for the same runtime generation.
        return Ok(None);
    }

    let has_new_user_message = runtime.session.user_seq > runtime.last_thread_recover_user_seq;
    let _ = record_stale_recover_hit(runtime, reason, now_ms);

    // Stop background restart loops: only recover after a fresh user message.
    if !has_new_user_message {
        return Ok(None);
    }

    if now_ms < runtime.thread_recover_cooldown_until_ms {
        return Ok(None);
    }

    let mut request_new_chat_reset = matches!(
        reason,
        StaleRecoverReason::RolloutMissing | StaleRecoverReason::ThreadNotFound
    );
    if request_new_chat_reset {
        if !has_codex_hook_newchat_watch_installed_internal() {
            request_new_chat_reset = false;
        } else {
            let in_cooldown = runtime.last_new_chat_reset_at_ms > 0
                && now_ms - runtime.last_new_chat_reset_at_ms
                    < AUTO_SWITCH_NEW_CHAT_RESET_COOLDOWN_MS;
            let same_user_seq = runtime.last_new_chat_reset_user_seq == runtime.session.user_seq;
            if in_cooldown || same_user_seq {
                request_new_chat_reset = false;
            }
        }
    }

    if reason == StaleRecoverReason::RuntimeUnavailable {
        runtime.last_runtime_unavailable_recover_restart_seq =
            Some(runtime.codex_log.runtime_restart_seq);
    }
    if request_new_chat_reset {
        runtime.last_new_chat_reset_at_ms = now_ms;
        runtime.last_new_chat_reset_user_seq = runtime.session.user_seq;
    }
    runtime.last_thread_recover_user_seq = runtime.session.user_seq;
    runtime.thread_recover_cooldown_until_ms = now_ms
        + if matches!(
            reason,
            StaleRecoverReason::RolloutMissing
                | StaleRecoverReason::ThreadNotFound
                | StaleRecoverReason::RuntimeUnavailable
        ) {
            AUTO_SWITCH_THREAD_RECOVER_HARD_COOLDOWN_MS
        } else {
            AUTO_SWITCH_THREAD_RECOVER_COOLDOWN_MS
        };

    Ok(Some(recover_runtime_without_new_chat_internal(
        reason.message(),
        false,
        request_new_chat_reset,
    )))
}

fn maybe_recover_stale_thread_from_opencode_log(
    runtime: &mut AutoSwitchRuntime,
) -> CmdResult<Option<AutoSwitchTickResult>> {
    sync_opencode_log_tail(runtime)?;
    if runtime.opencode_log.session_error_seq <= runtime.last_observed_opencode_session_error_seq {
        return Ok(None);
    }
    runtime.last_observed_opencode_session_error_seq = runtime.opencode_log.session_error_seq;

    let has_new_user_message = runtime.session.user_seq > runtime.last_thread_recover_user_seq;
    if !has_new_user_message {
        return Ok(None);
    }

    let now_ms = now_ts_ms();
    if now_ms < runtime.thread_recover_cooldown_until_ms {
        return Ok(None);
    }
    runtime.last_thread_recover_user_seq = runtime.session.user_seq;
    runtime.thread_recover_cooldown_until_ms = now_ms + AUTO_SWITCH_THREAD_RECOVER_COOLDOWN_MS;

    let detail = runtime
        .session
        .last_hard_trigger_reason
        .clone()
        .unwrap_or_else(|| "session.error".to_string());
    let mut result = AutoSwitchTickResult::new("thread_recover_failed");
    result.message = Some(format!(
        "检测到 OpenCode 会话异常（{detail}）。当前仅做检测提示，暂未自动重连运行时。"
    ));
    Ok(Some(result))
}

fn auto_switch_tick_internal(
    runtime: &mut AutoSwitchRuntime,
    mode: Option<&str>,
) -> CmdResult<AutoSwitchTickResult> {
    let mode = parse_auto_switch_mode(mode);
    ensure_auto_switch_mode(runtime, mode);
    sync_session_tail_for_mode(runtime, mode)?;
    let mut now_ms = now_ts_ms();

    if runtime.session.hard_trigger_seq > runtime.last_observed_hard_trigger_seq {
        runtime.last_observed_hard_trigger_seq = runtime.session.hard_trigger_seq;
        runtime.pending_reason = Some(TriggerReason::Hard);
    }

    let store_for_trigger = load_store()?;
    let active_profile_name = active_profile_name_for_mode(&store_for_trigger, mode, now_ms);
    let (current_five, current_week) = current_quota_for_trigger(
        runtime,
        &store_for_trigger,
        now_ms,
        active_profile_name.as_deref(),
    );
    let soft_hit = soft_trigger_hit(current_five, current_week);
    match runtime.pending_reason {
        Some(TriggerReason::Hard) => {}
        Some(TriggerReason::Soft) if !soft_hit => runtime.pending_reason = None,
        None if soft_hit => runtime.pending_reason = Some(TriggerReason::Soft),
        _ => {}
    }
    if runtime.pending_reason.is_some() {
        maybe_sync_live_quota_for_trigger(runtime, mode, &store_for_trigger, now_ms, false);
        now_ms = now_ts_ms();
        let active_profile_name = active_profile_name_for_mode(&store_for_trigger, mode, now_ms);
        let (live_five, live_week) = current_quota_for_trigger(
            runtime,
            &store_for_trigger,
            now_ms,
            active_profile_name.as_deref(),
        );
        let live_soft_hit = soft_trigger_hit(live_five, live_week);
        match runtime.pending_reason {
            Some(TriggerReason::Hard) => {}
            Some(TriggerReason::Soft) if !live_soft_hit => runtime.pending_reason = None,
            None if live_soft_hit => runtime.pending_reason = Some(TriggerReason::Soft),
            _ => {}
        }
    }

    if runtime.pending_reason.is_none() {
        return Ok(AutoSwitchTickResult::new("idle"));
    }

    if runtime.pending_reason == Some(TriggerReason::Soft) && runtime.last_switch_applied_at_ms > 0
    {
        let settle_until =
            runtime.last_switch_applied_at_ms + AUTO_SWITCH_POST_SWITCH_SOFT_COOLDOWN_MS;
        if now_ms < settle_until {
            runtime.switch_cooldown_until_ms = runtime.switch_cooldown_until_ms.max(settle_until);
        }
    }

    if now_ms < runtime.switch_cooldown_until_ms {
        let mut result = AutoSwitchTickResult::new("cooldown");
        result.message = Some("无感换号冷却中。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }
    if now_ms < runtime.no_candidate_until_ms {
        let mut result = AutoSwitchTickResult::new("no_candidate_cooldown");
        result.message = Some("暂未找到可切换账号，等待下次探测。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }

    if !runtime.session.open_turns.is_empty() {
        let mut result = AutoSwitchTickResult::new("wait_turn_end");
        result.message = Some("检测到当前对话仍在进行，等待结束后切号。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }

    let Some(stable_sig) = run_switch_guard(runtime, mode)? else {
        now_ms = now_ts_ms();
        runtime.switch_cooldown_until_ms = now_ms + AUTO_SWITCH_SWITCH_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("guard_cancelled");
        result.message = Some("检测到新消息或新回合，已取消本次无感换号。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    };

    let mut store = load_store()?;
    let names = list_profile_names(&store);
    let active = active_profile_name_for_mode(&store, mode, now_ms);
    let live_workspace_id = if matches!(mode, AutoSwitchMode::OpenCode) {
        opencode_live_auth_workspace_id().and_then(|v| normalize_identity_value(Some(v.as_str())))
    } else {
        None
    };
    let live_auth_entry = if matches!(mode, AutoSwitchMode::OpenCode) {
        opencode_live_auth_entry()
    } else {
        None
    };
    let active_identity = active.as_ref().and_then(|name| {
        let record = store.profiles.get(name).and_then(Value::as_object)?;
        let workspace_id = normalize_identity_value(
            read_workspace_id_from_record_or_auth(name, record).as_deref(),
        );
        let email = read_email_from_record(record);
        Some((workspace_id, email))
    });
    let mut picked: Option<String> = None;
    let mut checked = 0usize;
    let require_fresh_candidate_quota = runtime.pending_reason != Some(TriggerReason::Hard);
    let now_sec = now_ms / 1000;
    let mut candidate_names: Vec<String> = Vec::new();
    for name in names {
        if active.as_deref() == Some(name.as_str()) {
            continue;
        }
        let Some(record) = store.profiles.get(&name).and_then(Value::as_object) else {
            continue;
        };
        if !profile_supports_mode(record, mode) {
            continue;
        }
        if matches!(mode, AutoSwitchMode::OpenCode) {
            let candidate_workspace_id = normalize_identity_value(
                read_workspace_id_from_record_or_auth(&name, record).as_deref(),
            );
            if let (Some(live_entry), Some(snapshot_entry)) = (
                live_auth_entry.as_ref(),
                opencode_snapshot_entry_from_record(&name, record).as_ref(),
            ) {
                if snapshot_entry == live_entry {
                    continue;
                }
            }
            if let Some((active_workspace_id, active_email)) = &active_identity {
                let candidate_email = read_email_from_record(record);
                let same_workspace = active_workspace_id
                    .as_deref()
                    .zip(candidate_workspace_id.as_deref())
                    .map(|(left, right)| left == right)
                    .unwrap_or(false);
                let same_email = active_email
                    .as_deref()
                    .zip(candidate_email.as_deref())
                    .map(|(left, right)| left == right)
                    .unwrap_or(false);
                if same_workspace && active_email.is_some() && same_email {
                    continue;
                }
            }
            if let Some(live_wid) = live_workspace_id.as_deref() {
                if candidate_workspace_id.as_deref() == Some(live_wid)
                    && record.get("email").and_then(Value::as_str).is_none()
                {
                    continue;
                }
            }
        }
        candidate_names.push(name);
    }

    let parallelism = AUTO_SWITCH_CANDIDATE_REFRESH_PARALLELISM.max(1);
    for chunk in candidate_names.chunks(parallelism) {
        let mut outcomes: HashMap<String, (bool, bool, Map<String, Value>)> = HashMap::new();
        let mut workers = Vec::new();
        for name in chunk {
            checked += 1;
            let Some(record) = store.profiles.get(name).and_then(Value::as_object).cloned() else {
                continue;
            };
            let should_refresh = !require_fresh_candidate_quota
                || should_refresh_candidate_for_soft_trigger(&record, now_sec);
            if !should_refresh {
                outcomes.insert(name.clone(), (false, false, record));
                continue;
            }
            let candidate_name = name.clone();
            workers.push(thread::spawn(move || {
                let (first_record, first_ok) = refresh_profile_record_quota_with_timeout(
                    &candidate_name,
                    record,
                    false,
                    AUTO_SWITCH_CANDIDATE_REFRESH_TIMEOUT_SECONDS,
                );
                if first_ok {
                    return (candidate_name, true, true, first_record);
                }
                let (second_record, second_ok) = refresh_profile_record_quota_with_timeout(
                    &candidate_name,
                    first_record,
                    true,
                    AUTO_SWITCH_CANDIDATE_REFRESH_TIMEOUT_SECONDS,
                );
                (candidate_name, true, second_ok, second_record)
            }));
        }
        for worker in workers {
            if let Ok((name, attempted, refreshed, record)) = worker.join() {
                outcomes.insert(name, (attempted, refreshed, record));
            }
        }
        for name in chunk {
            let Some((attempted, refreshed, record)) = outcomes.remove(name) else {
                continue;
            };
            store.profiles.insert(name.clone(), Value::Object(record));
            if require_fresh_candidate_quota && attempted && !refreshed {
                continue;
            }
            if profile_candidate_ready(&store, name) {
                picked = Some(name.clone());
                break;
            }
        }
        if picked.is_some() {
            break;
        }
    }
    save_store(&store)?;

    let Some(target_profile) = picked else {
        now_ms = now_ts_ms();
        runtime.no_candidate_until_ms = now_ms + AUTO_SWITCH_NO_CANDIDATE_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("no_candidate");
        result.message = Some(format!("已探测 {checked} 个账号，暂无满足条件的候选账号。"));
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    };

    sync_session_tail_for_mode(runtime, mode)?;
    let latest_sig = auto_switch_signature(runtime);
    if latest_sig != stable_sig || latest_sig.open_turn_count > 0 {
        now_ms = now_ts_ms();
        runtime.switch_cooldown_until_ms = now_ms + AUTO_SWITCH_SWITCH_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("guard_cancelled");
        result.message = Some("切号前检测到会话状态变化，已取消本次切号。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }

    now_ms = now_ts_ms();
    maybe_sync_live_quota_for_trigger(runtime, mode, &store, now_ms, true);
    now_ms = now_ts_ms();
    let active_profile_name = active_profile_name_for_mode(&store, mode, now_ms);
    let (latest_five, latest_week) =
        current_quota_for_trigger(runtime, &store, now_ms, active_profile_name.as_deref());
    if runtime.pending_reason == Some(TriggerReason::Soft)
        && !soft_trigger_hit(latest_five, latest_week)
    {
        runtime.pending_reason = None;
        runtime.switch_cooldown_until_ms = now_ms + AUTO_SWITCH_SWITCH_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("recheck_cancelled");
        result.message = Some("切号前复检发现额度已恢复，已取消本次无感换号。".to_string());
        return Ok(result);
    }

    let target_refreshed = refresh_one_profile_quota_with_timeout(
        &mut store,
        &target_profile,
        false,
        AUTO_SWITCH_CANDIDATE_REFRESH_TIMEOUT_SECONDS,
    ) || refresh_one_profile_quota_with_timeout(
        &mut store,
        &target_profile,
        true,
        AUTO_SWITCH_CANDIDATE_REFRESH_TIMEOUT_SECONDS,
    );
    let target_ready = profile_candidate_ready(&store, &target_profile);
    save_store(&store)?;
    if require_fresh_candidate_quota && !target_refreshed {
        now_ms = now_ts_ms();
        runtime.no_candidate_until_ms = now_ms + AUTO_SWITCH_NO_CANDIDATE_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("candidate_recheck_failed");
        result.message =
            Some("候选账号复检未通过（实时配额刷新失败），已取消本次切号。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }
    if !target_ready {
        now_ms = now_ts_ms();
        runtime.no_candidate_until_ms = now_ms + AUTO_SWITCH_NO_CANDIDATE_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("candidate_recheck_failed");
        result.message = Some(if target_refreshed {
            "候选账号复检未通过（可能额度已变更或登录态失效），已取消本次切号。".to_string()
        } else {
            "候选账号复检未通过（实时配额刷新失败，且缓存额度不满足条件），已取消本次切号。"
                .to_string()
        });
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }

    let reason = runtime.pending_reason.unwrap_or(TriggerReason::Soft);
    let dashboard = match mode {
        AutoSwitchMode::Gpt => apply_profile_internal_for_mode(&target_profile, Some("gpt"))?,
        AutoSwitchMode::OpenCode => {
            let dashboard = apply_profile_internal_for_mode(&target_profile, Some("opencode"))?;
            let latest_store = load_store()?;
            if !opencode_live_matches_target_profile(&latest_store, &target_profile) {
                // Retry once after a short delay.
                thread::sleep(Duration::from_millis(200));
                let _ = apply_profile_internal_for_mode(&target_profile, Some("opencode"));
                let retry_store = load_store()?;
                if !opencode_live_matches_target_profile(&retry_store, &target_profile) {
                    runtime.no_candidate_until_ms =
                        now_ts_ms() + AUTO_SWITCH_NO_CANDIDATE_COOLDOWN_MS;
                    let mut result = AutoSwitchTickResult::new("switch_verify_failed");
                    result.message = Some(
                        "自动切号后校验未通过：OpenCode auth 文件未切到目标账号。".to_string(),
                    );
                    fill_pending_reason(&mut result, runtime);
                    return Ok(result);
                }
            }
            // Invalidate stale OpenCode quota cache so next poll picks up fresh identity.
            update_opencode_quota_runtime_cache(
                &AccountQuota {
                    email: None,
                    workspace_name: None,
                    workspace_id: None,
                    plan_type: None,
                    five_hour: None,
                    one_week: None,
                },
                0,
            );
            dashboard
        }
    };
    now_ms = now_ts_ms();
    runtime.last_switch_applied_at_ms = now_ms;
    runtime.session.quota = SessionQuotaSnapshot::default();
    runtime.pending_reason = None;
    runtime.switch_cooldown_until_ms = now_ms + AUTO_SWITCH_SWITCH_COOLDOWN_MS;
    runtime.no_candidate_until_ms = 0;

    let mut result = AutoSwitchTickResult::new("switched");
    result.message = Some(format!(
        "{}触发无感换号（{}模式），已切换到账号: {}",
        if reason == TriggerReason::Hard {
            "硬触发"
        } else {
            "低额度"
        },
        if matches!(mode, AutoSwitchMode::Gpt) {
            "GPT"
        } else {
            "OpenCode"
        },
        target_profile
    ));
    result.switched_to = Some(target_profile);
    result.pending_reason = Some(reason.as_str().to_string());
    result.dashboard = Some(dashboard);
    Ok(result)
}

fn thread_recover_tick_internal(
    runtime: &mut AutoSwitchRuntime,
    mode: Option<&str>,
) -> CmdResult<AutoSwitchTickResult> {
    let mode = parse_auto_switch_mode(mode);
    ensure_auto_switch_mode(runtime, mode);
    match mode {
        AutoSwitchMode::Gpt => {
            if let Some(result) = maybe_recover_stale_thread_from_log(runtime)? {
                return Ok(result);
            }
        }
        AutoSwitchMode::OpenCode => {
            if let Some(result) = maybe_recover_stale_thread_from_opencode_log(runtime)? {
                return Ok(result);
            }
        }
    }
    Ok(AutoSwitchTickResult::new("thread_monitor_idle"))
}

fn auto_switch_reset_internal(runtime: &mut AutoSwitchRuntime) -> String {
    *runtime = AutoSwitchRuntime::default();
    "无感换号状态已重置。".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AutoSwitchRuntimeState::default())
        .setup(|app| {
            let _ = APP_RUNTIME_HANDLE.set(app.handle().clone());
            if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
                let show_item =
                    MenuItem::with_id(app, TRAY_MENU_SHOW_ID, "显示主窗口", true, None::<&str>);
                let exit_item =
                    MenuItem::with_id(app, TRAY_MENU_EXIT_ID, "退出程序", true, None::<&str>);
                if let (Ok(show_item), Ok(exit_item)) = (show_item, exit_item) {
                    if let Ok(menu) = Menu::with_items(app, &[&show_item, &exit_item]) {
                        let _ = tray.set_menu(Some(menu));
                    }
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW_ID => commands::show_main_window(app),
            TRAY_MENU_EXIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|app, event| {
            if event.id().as_ref() != TRAY_ICON_ID {
                return;
            }
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => commands::show_main_window(app),
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => commands::show_main_window(app),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_dashboard,
            commands::save_current_profile,
            commands::add_account_by_login,
            commands::apply_profile,
            commands::set_workspace_alias,
            commands::set_profile_support,
            commands::refresh_profile_quota,
            commands::refresh_profiles_quota,
            commands::refresh_all_quota,
            commands::keepalive_all,
            commands::auto_switch_tick,
            commands::thread_recover_tick,
            commands::auto_switch_reset,
            commands::delete_profile,
            commands::reorder_profiles,
            commands::reload_vscode_window,
            commands::restart_extension_host,
            commands::install_codex_hook,
            commands::get_vscode_status,
            commands::get_opencode_monitor_status,
            commands::get_codex_extension_info,
            commands::is_codex_hook_installed,
            commands::load_skills_catalog,
            commands::load_skills_discovery,
            commands::load_skill_repos_manage,
            commands::add_skill_repo,
            commands::remove_skill_repo,
            commands::install_discovery_skill,
            commands::set_skill_targets,
            commands::delete_skill,
            commands::load_mcp_manage,
            commands::import_existing_mcp,
            commands::set_mcp_targets,
            commands::add_mcp_server,
            commands::remove_mcp_server,
            commands::run_post_switch_action,
            commands::export_data_backup,
            commands::import_data_backup_base64,
            commands::format_reset_time,
            commands::open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
