fn build_codex_command(args: &[&str]) -> CmdResult<Command> {
    let bin = resolve_codex_binary()?;
    #[cfg(target_os = "windows")]
    {
        let ext = bin
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext == "cmd" || ext == "bat" {
            let mut cmd = command_no_window("cmd");
            cmd.arg("/C").arg(&bin).args(args);
            return Ok(cmd);
        }
        if ext == "ps1" {
            let mut cmd = command_no_window("powershell");
            cmd.args(["-NoLogo", "-NoProfile", "-File"])
                .arg(&bin)
                .args(args);
            return Ok(cmd);
        }
        let mut cmd = command_no_window(&bin);
        cmd.args(args);
        return Ok(cmd);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = command_no_window(&bin);
        cmd.args(args);
        Ok(cmd)
    }
}

include!("runtime_backup.inc");

include!("runtime_store_profiles.inc");

fn app_server_request(
    codex_home: &Path,
    requests: &[Value],
    timeout_seconds: u64,
    required_ids: &[i64],
) -> CmdResult<HashMap<i64, Value>> {
    let debug_enabled = app_server_debug_enabled();
    if let Ok(bin) = resolve_codex_binary() {
        app_server_log(
            debug_enabled,
            format!("using codex binary: {}", bin.display()),
        );
    }
    app_server_log(
        debug_enabled,
        format!(
            "spawn codex app-server (CODEX_HOME={}, timeout={}s, requests={})",
            codex_home.display(),
            timeout_seconds,
            requests.len()
        ),
    );
    let mut cmd = build_codex_command(&["app-server"])?;
    let mut child = cmd
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 codex app-server 失败: {e}"))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "app-server stdin 不可用。".to_string())?;
        for req in requests {
            let line = serde_json::to_string(req).map_err(|e| format!("请求序列化失败: {e}"))?;
            let safe_line = redact_app_server_request_for_log(req);
            app_server_log(debug_enabled, format!("stdin >> {safe_line}"));
            stdin
                .write_all(format!("{line}\n").as_bytes())
                .map_err(|e| format!("向 app-server 写入请求失败: {e}"))?;
        }
        stdin
            .flush()
            .map_err(|e| format!("刷新 app-server stdin 失败: {e}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "app-server stdout 不可用。".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "app-server stderr 不可用。".to_string())?;
    let (tx, rx) = mpsc::channel::<String>();
    let stdout_log_enabled = debug_enabled;
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            app_server_log(stdout_log_enabled, format!("stdout << {line}"));
            let _ = tx.send(line);
        }
        app_server_log(stdout_log_enabled, "stdout stream closed");
    });
    let stderr_tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let stderr_tail_worker = Arc::clone(&stderr_tail);
        let stderr_log_enabled = debug_enabled;
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                app_server_log(stderr_log_enabled, format!("stderr << {line}"));
                if let Ok(mut tail) = stderr_tail_worker.lock() {
                    if tail.len() >= 8 {
                        tail.remove(0);
                    }
                    tail.push(line);
                }
            }
            app_server_log(stderr_log_enabled, "stderr stream closed");
        });
    }

    let wanted_ids: HashSet<i64> = requests
        .iter()
        .filter_map(|req| req.get("id").and_then(Value::as_i64))
        .collect();
    let mut required: HashSet<i64> = if required_ids.is_empty() {
        wanted_ids.clone()
    } else {
        required_ids
            .iter()
            .copied()
            .filter(|id| wanted_ids.contains(id))
            .collect()
    };
    if required.is_empty() {
        required = wanted_ids.clone();
    }
    let mut got: HashMap<i64, Value> = HashMap::new();
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    app_server_log(
        debug_enabled,
        format!("waiting responses, required_ids={required:?}"),
    );

    let mut required_done = false;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(line) => {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(msg_id) = msg.get("id").and_then(Value::as_i64) else {
                    continue;
                };
                if !wanted_ids.contains(&msg_id) {
                    continue;
                }
                if let Some(error) = msg.get("error") {
                    if !required.contains(&msg_id) {
                        app_server_log(
                            debug_enabled,
                            format!("optional id={msg_id} returned error: {error}"),
                        );
                        got.insert(msg_id, msg);
                        continue;
                    }
                    app_server_log(
                        debug_enabled,
                        format!("required id={msg_id} returned error: {error}"),
                    );
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("app-server 请求 {msg_id} 返回错误: {error}"));
                }
                app_server_log(debug_enabled, format!("received response id={msg_id}"));
                got.insert(msg_id, msg);
                required_done = required.iter().all(|id| got.contains_key(id));
                if required_done {
                    app_server_log(debug_enabled, "required responses all received");
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                app_server_log(debug_enabled, "stdout channel disconnected");
                break;
            }
        }
    }

    if required_done && got.len() < wanted_ids.len() {
        let grace_deadline = Instant::now() + Duration::from_millis(220);
        while Instant::now() < grace_deadline {
            match rx.recv_timeout(Duration::from_millis(70)) {
                Ok(line) => {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    let Some(msg_id) = msg.get("id").and_then(Value::as_i64) else {
                        continue;
                    };
                    if !wanted_ids.contains(&msg_id) {
                        continue;
                    }
                    got.insert(msg_id, msg);
                    if got.len() >= wanted_ids.len() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    let mut got_ids: Vec<i64> = got.keys().copied().collect();
    got_ids.sort_unstable();
    app_server_log(debug_enabled, format!("finished, got_ids={got_ids:?}"));

    let mut missing_required: Vec<i64> = required
        .into_iter()
        .filter(|id| !got.contains_key(id))
        .collect();
    if !missing_required.is_empty() {
        missing_required.sort_unstable();
        let stderr_note = stderr_tail
            .lock()
            .ok()
            .and_then(|tail| {
                if tail.is_empty() {
                    None
                } else {
                    Some(tail.join(" | "))
                }
            })
            .unwrap_or_default();
        if stderr_note.is_empty() {
            return Err(format!(
                "app-server 响应超时，缺少必需 id: {missing_required:?}"
            ));
        }
        return Err(format!(
            "app-server 响应超时，缺少必需 id: {missing_required:?}；stderr: {stderr_note}"
        ));
    }

    if got.len() != wanted_ids.len() {
        let mut missing_optional: Vec<i64> = wanted_ids
            .into_iter()
            .filter(|id| !got.contains_key(id))
            .collect();
        missing_optional.sort_unstable();
        app_server_log(
            debug_enabled,
            format!(
                "app-server 未返回可选响应 id: {:?} (CODEX_HOME={})",
                missing_optional,
                codex_home.display()
            ),
        );
    }
    Ok(got)
}

fn account_quota_from_app_server_responses(
    codex_home: &Path,
    responses: &HashMap<i64, Value>,
    account_msg_id: i64,
    rate_limits_msg_id: i64,
) -> CmdResult<AccountQuota> {
    let account_result = responses
        .get(&account_msg_id)
        .and_then(|v| v.get("result"))
        .cloned();
    let rate_limits_result = responses
        .get(&rate_limits_msg_id)
        .and_then(|v| v.get("result"))
        .cloned()
        .ok_or_else(|| "未在 app-server 响应中找到额度信息。".to_string())?;

    account_quota_from_rate_limits_result(codex_home, account_result.as_ref(), &rate_limits_result)
}

fn account_quota_from_rate_limits_result(
    codex_home: &Path,
    account_result: Option<&Value>,
    rate_limits_result: &Value,
) -> CmdResult<AccountQuota> {
    let account = account_result
        .and_then(|v| v.get("account"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let email = account
        .get("email")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let plan_type = account
        .get("planType")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let (workspace_name, workspace_id) =
        read_workspace_info_from_auth_file(&codex_home.join(AUTH_FILE_NAME));

    let mut snapshot: Option<Value> = None;
    if let Some(by_limit) = rate_limits_result
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
    {
        if let Some(codex_limits) = by_limit.get("codex").and_then(Value::as_object) {
            snapshot = Some(Value::Object(codex_limits.clone()));
        } else if let Some((_, first)) = by_limit.iter().next() {
            if first.is_object() {
                snapshot = Some(first.clone());
            }
        }
    }
    if snapshot.is_none() {
        if let Some(rate_limits) = rate_limits_result
            .get("rateLimits")
            .and_then(Value::as_object)
        {
            snapshot = Some(Value::Object(rate_limits.clone()));
        }
    }
    let snapshot = snapshot.ok_or_else(|| "未在 app-server 响应中找到额度信息。".to_string())?;
    let snapshot_map = snapshot
        .as_object()
        .ok_or_else(|| "额度快照格式不正确。".to_string())?;

    let primary = window_quota_from_payload(snapshot_map.get("primary"));
    let secondary = window_quota_from_payload(snapshot_map.get("secondary"));
    let windows: Vec<WindowQuota> = [primary, secondary].into_iter().flatten().collect();
    if windows.is_empty() {
        return Err("额度窗口为空。".to_string());
    }

    let five_hour = pick_window(&windows, 300, 30);
    let one_week = pick_window(&windows, 10080, 12 * 60);
    if five_hour.is_none() && one_week.is_none() {
        return Err("未识别到可用额度窗口。".to_string());
    }
    Ok(AccountQuota {
        email,
        workspace_name,
        workspace_id,
        plan_type,
        five_hour,
        one_week,
    })
}

fn fetch_quota_from_codex_home_with_timeout(
    codex_home: &Path,
    refresh_token: bool,
    timeout_seconds: u64,
) -> CmdResult<AccountQuota> {
    let requests = vec![
        json!({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "codex-switch", "version": "1.0.0"}}
        }),
        json!({
            "id": 2,
            "method": "account/read",
            "params": {"refreshToken": refresh_token}
        }),
        json!({
            "id": 3,
            "method": "account/rateLimits/read",
            "params": Value::Null
        }),
    ];

    let responses = app_server_request(codex_home, &requests, timeout_seconds, &[1, 2, 3])?;
    account_quota_from_app_server_responses(codex_home, &responses, 2, 3)
}

fn fetch_quota_from_codex_home(codex_home: &Path, refresh_token: bool) -> CmdResult<AccountQuota> {
    fetch_quota_from_codex_home_with_timeout(
        codex_home,
        refresh_token,
        APP_SERVER_TIMEOUT_DEFAULT_SECONDS,
    )
}

fn app_server_write_line(
    stdin: &mut std::process::ChildStdin,
    req: &Value,
    debug_enabled: bool,
) -> CmdResult<()> {
    let line = serde_json::to_string(req).map_err(|e| format!("请求序列化失败: {e}"))?;
    let safe_line = redact_app_server_request_for_log(req);
    app_server_log(debug_enabled, format!("stdin >> {safe_line}"));
    stdin
        .write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("向 app-server 写入请求失败: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("刷新 app-server stdin 失败: {e}"))
}

fn handle_gpt_rate_limits_payload(
    codex_home: &Path,
    account_result: Option<&Value>,
    rate_limits_result: &Value,
    debug_enabled: bool,
) {
    let quota =
        match account_quota_from_rate_limits_result(codex_home, account_result, rate_limits_result)
        {
            Ok(v) => v,
            Err(err) => {
                app_server_log(
                    debug_enabled,
                    format!("parse rateLimits payload failed: {err}"),
                );
                return;
            }
        };
    let now_ms = now_ts_ms();
    update_current_quota_runtime_cache(&quota, now_ms);
    if let Ok(mut store) = load_store() {
        sync_live_quota_to_store(&mut store, &quota, now_ms, AutoSwitchMode::Gpt, false);
    }
    if let Ok(mut state) = gpt_rate_limit_push_state().lock() {
        state.last_error = None;
    }
}

fn run_gpt_rate_limit_push_worker(codex_home: PathBuf) {
    let debug_enabled = app_server_debug_enabled();
    loop {
        let mut cmd = match build_codex_command(&["app-server"]) {
            Ok(v) => v,
            Err(err) => {
                if let Ok(mut state) = gpt_rate_limit_push_state().lock() {
                    state.last_error = Some(err.clone());
                    state.running = false;
                }
                return;
            }
        };
        let mut child = match cmd
            .env("CODEX_HOME", &codex_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(v) => v,
            Err(err) => {
                if let Ok(mut state) = gpt_rate_limit_push_state().lock() {
                    state.last_error = Some(format!("启动 GPT 实时 app-server 失败: {err}"));
                    state.running = false;
                }
                return;
            }
        };

        let mut stdin = match child.stdin.take() {
            Some(v) => v,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                if let Ok(mut state) = gpt_rate_limit_push_state().lock() {
                    state.last_error = Some("GPT 实时 app-server stdin 不可用。".to_string());
                }
                thread::sleep(Duration::from_millis(
                    GPT_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
                ));
                continue;
            }
        };
        let stdout = match child.stdout.take() {
            Some(v) => v,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                if let Ok(mut state) = gpt_rate_limit_push_state().lock() {
                    state.last_error = Some("GPT 实时 app-server stdout 不可用。".to_string());
                }
                thread::sleep(Duration::from_millis(
                    GPT_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
                ));
                continue;
            }
        };
        let stderr = child.stderr.take();

        if let Some(err_stream) = stderr {
            let stderr_log_enabled = debug_enabled;
            thread::spawn(move || {
                let reader = BufReader::new(err_stream);
                for line in reader.lines().map_while(Result::ok) {
                    app_server_log(stderr_log_enabled, format!("push stderr << {line}"));
                }
            });
        }

        let (tx, rx) = mpsc::channel::<String>();
        let stdout_log_enabled = debug_enabled;
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                app_server_log(stdout_log_enabled, format!("push stdout << {line}"));
                let _ = tx.send(line);
            }
        });

        let init = json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "codex-switch", "version": "1.0.0"},
                "capabilities": {"experimentalApi": true}
            }
        });
        let read_account = json!({
            "id": 2,
            "method": "account/read",
            "params": {"refreshToken": false}
        });
        let read_limits = json!({
            "id": 3,
            "method": "account/rateLimits/read",
            "params": Value::Null
        });
        if app_server_write_line(&mut stdin, &init, debug_enabled).is_err()
            || app_server_write_line(&mut stdin, &read_account, debug_enabled).is_err()
            || app_server_write_line(&mut stdin, &read_limits, debug_enabled).is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            if let Ok(mut state) = gpt_rate_limit_push_state().lock() {
                state.last_error = Some("GPT 实时 push 初始化请求失败。".to_string());
            }
            thread::sleep(Duration::from_millis(
                GPT_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
            ));
            continue;
        }

        let mut next_read_at_ms = now_ts_ms() + GPT_RATE_LIMIT_PUSH_READ_INTERVAL_MS;
        let mut next_req_id: i64 = 1000;
        let mut last_account_result: Option<Value> = None;

        loop {
            let now_ms = now_ts_ms();
            if now_ms >= next_read_at_ms {
                let req = json!({
                    "id": next_req_id,
                    "method": "account/rateLimits/read",
                    "params": Value::Null
                });
                if app_server_write_line(&mut stdin, &req, debug_enabled).is_err() {
                    break;
                }
                next_req_id += 1;
                next_read_at_ms = now_ms + GPT_RATE_LIMIT_PUSH_READ_INTERVAL_MS;
            }

            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                        if id == 2 {
                            last_account_result = msg.get("result").cloned();
                        }
                        if msg.get("result").is_some() && (id == 3 || id >= 1000) {
                            if let Some(result) = msg.get("result") {
                                handle_gpt_rate_limits_payload(
                                    &codex_home,
                                    last_account_result.as_ref(),
                                    result,
                                    debug_enabled,
                                );
                            }
                        }
                        continue;
                    }
                    if msg
                        .get("method")
                        .and_then(Value::as_str)
                        .map(|m| m == "account/rateLimits/updated")
                        .unwrap_or(false)
                    {
                        if let Some(params) = msg.get("params") {
                            handle_gpt_rate_limits_payload(
                                &codex_home,
                                last_account_result.as_ref(),
                                params,
                                debug_enabled,
                            );
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        if let Ok(mut state) = gpt_rate_limit_push_state().lock() {
            state.last_error = Some("GPT 实时 push 连接中断，准备重连。".to_string());
        }
        thread::sleep(Duration::from_millis(
            GPT_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
        ));
    }
}

fn ensure_gpt_rate_limit_push_worker(codex_home: &Path) {
    let Ok(mut state) = gpt_rate_limit_push_state().lock() else {
        return;
    };
    if state.running {
        return;
    }
    state.running = true;
    state.codex_home = Some(codex_home.to_path_buf());
    state.last_error = None;
    let home = codex_home.to_path_buf();
    thread::spawn(move || {
        run_gpt_rate_limit_push_worker(home);
    });
}

fn handle_opencode_rate_limits_payload(
    codex_home: &Path,
    fallback_workspace_id: &str,
    fallback_plan_type: Option<&str>,
    account_result: Option<&Value>,
    rate_limits_result: &Value,
    debug_enabled: bool,
) {
    let mut quota =
        match account_quota_from_rate_limits_result(codex_home, account_result, rate_limits_result)
        {
            Ok(v) => v,
            Err(err) => {
                app_server_log(
                    debug_enabled,
                    format!("parse OpenCode rateLimits payload failed: {err}"),
                );
                return;
            }
        };
    if quota
        .workspace_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
        && !fallback_workspace_id.trim().is_empty()
    {
        quota.workspace_id = Some(fallback_workspace_id.to_string());
    }
    if quota.plan_type.as_deref().unwrap_or("").trim().is_empty() {
        quota.plan_type = fallback_plan_type.map(ToString::to_string);
    }
    let now_ms = now_ts_ms();
    update_opencode_quota_runtime_cache(&quota, now_ms);
    if let Ok(mut store) = load_store() {
        sync_live_quota_to_store(&mut store, &quota, now_ms, AutoSwitchMode::OpenCode, false);
    }
    if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
        state.last_error = None;
    }
}

fn run_opencode_rate_limit_push_worker() {
    let debug_enabled = app_server_debug_enabled();
    loop {
        let auth = match opencode_live_auth_context() {
            Ok(v) => v,
            Err(err) => {
                let now_ms = now_ts_ms();
                mark_opencode_quota_runtime_error(&err, now_ms);
                if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
                    state.last_error = Some(err);
                }
                thread::sleep(Duration::from_millis(
                    OPENCODE_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
                ));
                continue;
            }
        };
        let bridge_home = auth.bridge_home.clone();
        let access_token = auth.access_token.clone();
        let workspace_id = auth.workspace_id.clone();
        let plan_type = auth.plan_type.clone();

        let mut cmd = match build_codex_command(&["app-server"]) {
            Ok(v) => v,
            Err(err) => {
                let message = err.clone();
                let now_ms = now_ts_ms();
                mark_opencode_quota_runtime_error(&message, now_ms);
                if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
                    state.last_error = Some(message);
                }
                thread::sleep(Duration::from_millis(
                    OPENCODE_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
                ));
                continue;
            }
        };

        let mut child = match cmd
            .env("CODEX_HOME", &bridge_home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(v) => v,
            Err(err) => {
                let message = format!("启动 OpenCode 实时 app-server 失败: {err}");
                let now_ms = now_ts_ms();
                mark_opencode_quota_runtime_error(&message, now_ms);
                if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
                    state.last_error = Some(message);
                }
                thread::sleep(Duration::from_millis(
                    OPENCODE_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
                ));
                continue;
            }
        };

        let mut stdin = match child.stdin.take() {
            Some(v) => v,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                let message = "OpenCode 实时 app-server stdin 不可用。".to_string();
                let now_ms = now_ts_ms();
                mark_opencode_quota_runtime_error(&message, now_ms);
                if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
                    state.last_error = Some(message);
                }
                thread::sleep(Duration::from_millis(
                    OPENCODE_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
                ));
                continue;
            }
        };
        let stdout = match child.stdout.take() {
            Some(v) => v,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                let message = "OpenCode 实时 app-server stdout 不可用。".to_string();
                let now_ms = now_ts_ms();
                mark_opencode_quota_runtime_error(&message, now_ms);
                if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
                    state.last_error = Some(message);
                }
                thread::sleep(Duration::from_millis(
                    OPENCODE_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
                ));
                continue;
            }
        };
        let stderr = child.stderr.take();

        if let Some(err_stream) = stderr {
            let stderr_log_enabled = debug_enabled;
            thread::spawn(move || {
                let reader = BufReader::new(err_stream);
                for line in reader.lines().map_while(Result::ok) {
                    app_server_log(
                        stderr_log_enabled,
                        format!("opencode push stderr << {line}"),
                    );
                }
            });
        }

        let (tx, rx) = mpsc::channel::<String>();
        let stdout_log_enabled = debug_enabled;
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                app_server_log(
                    stdout_log_enabled,
                    format!("opencode push stdout << {line}"),
                );
                let _ = tx.send(line);
            }
        });

        let init = json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "codex-switch", "version": "1.0.0"},
                "capabilities": {"experimentalApi": true}
            }
        });
        let login = json!({
            "id": 10,
            "method": "account/login/start",
            "params": {
                "type": "chatgptAuthTokens",
                "accessToken": access_token,
                "chatgptAccountId": workspace_id,
                "chatgptPlanType": plan_type.clone().map(Value::String).unwrap_or(Value::Null)
            }
        });
        let read_account = json!({
            "id": 2,
            "method": "account/read",
            "params": {"refreshToken": false}
        });
        let read_limits = json!({
            "id": 3,
            "method": "account/rateLimits/read",
            "params": Value::Null
        });
        if app_server_write_line(&mut stdin, &init, debug_enabled).is_err()
            || app_server_write_line(&mut stdin, &login, debug_enabled).is_err()
            || app_server_write_line(&mut stdin, &read_account, debug_enabled).is_err()
            || app_server_write_line(&mut stdin, &read_limits, debug_enabled).is_err()
        {
            let _ = child.kill();
            let _ = child.wait();
            let message = "OpenCode 实时 push 初始化请求失败。".to_string();
            let now_ms = now_ts_ms();
            mark_opencode_quota_runtime_error(&message, now_ms);
            if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
                state.last_error = Some(message);
            }
            thread::sleep(Duration::from_millis(
                OPENCODE_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
            ));
            continue;
        }

        let mut next_read_at_ms = now_ts_ms() + OPENCODE_RATE_LIMIT_PUSH_READ_INTERVAL_MS;
        let mut next_req_id: i64 = 2000;
        let mut last_account_result: Option<Value> = None;
        let fallback_workspace_id = workspace_id.clone();
        let fallback_plan_type = plan_type.clone();

        loop {
            let now_ms = now_ts_ms();
            if now_ms >= next_read_at_ms {
                let req = json!({
                    "id": next_req_id,
                    "method": "account/rateLimits/read",
                    "params": Value::Null
                });
                if app_server_write_line(&mut stdin, &req, debug_enabled).is_err() {
                    break;
                }
                next_req_id += 1;
                next_read_at_ms = now_ms + OPENCODE_RATE_LIMIT_PUSH_READ_INTERVAL_MS;
            }

            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(line) => {
                    let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                        if id == 2 {
                            last_account_result = msg.get("result").cloned();
                        }
                        if let Some(err) = msg.get("error") {
                            let message = format!("OpenCode 实时 push 请求 {id} 返回错误: {err}");
                            let now_ms = now_ts_ms();
                            mark_opencode_quota_runtime_error(&message, now_ms);
                            if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
                                state.last_error = Some(message);
                            }
                        }
                        if msg.get("result").is_some() && (id == 3 || id >= 2000) {
                            if let Some(result) = msg.get("result") {
                                handle_opencode_rate_limits_payload(
                                    &bridge_home,
                                    &fallback_workspace_id,
                                    fallback_plan_type.as_deref(),
                                    last_account_result.as_ref(),
                                    result,
                                    debug_enabled,
                                );
                            }
                        }
                        continue;
                    }
                    if msg
                        .get("method")
                        .and_then(Value::as_str)
                        .map(|m| m == "account/rateLimits/updated")
                        .unwrap_or(false)
                    {
                        if let Some(params) = msg.get("params") {
                            handle_opencode_rate_limits_payload(
                                &bridge_home,
                                &fallback_workspace_id,
                                fallback_plan_type.as_deref(),
                                last_account_result.as_ref(),
                                params,
                                debug_enabled,
                            );
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        let message = "OpenCode 实时 push 连接中断，准备重连。".to_string();
        let now_ms = now_ts_ms();
        mark_opencode_quota_runtime_error(&message, now_ms);
        if let Ok(mut state) = opencode_rate_limit_push_state().lock() {
            state.last_error = Some(message);
        }
        thread::sleep(Duration::from_millis(
            OPENCODE_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS as u64,
        ));
    }
}

fn ensure_opencode_rate_limit_push_worker() {
    let Ok(mut state) = opencode_rate_limit_push_state().lock() else {
        return;
    };
    if state.running {
        return;
    }
    state.running = true;
    state.last_error = None;
    thread::spawn(move || {
        run_opencode_rate_limit_push_worker();
    });
}

include!("runtime_opencode_auth.inc");

include!("runtime_auth_login.inc");

