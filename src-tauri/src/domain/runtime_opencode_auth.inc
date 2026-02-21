fn extract_opencode_account_id_from_jwt(token: &str) -> Option<String> {
    let decoded = decode_jwt_payload(token)?;
    let root = decoded.as_object()?;
    if let Some(id) = read_non_empty_string(
        root,
        &[
            "chatgpt_account_id",
            "chatgptAccountId",
            "account_id",
            "accountId",
        ],
    ) {
        return Some(id);
    }
    let auth_claim = root
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object)?;
    if let Some(id) = read_non_empty_string(
        auth_claim,
        &[
            "chatgpt_account_id",
            "chatgptAccountId",
            "account_id",
            "accountId",
            "workspace_id",
            "workspaceId",
        ],
    ) {
        return Some(id);
    }
    if let Some(orgs) = auth_claim.get("organizations").and_then(Value::as_array) {
        for org in orgs {
            let Some(org_map) = org.as_object() else {
                continue;
            };
            if let Some(id) = workspace_id_from_org(org_map) {
                return Some(id);
            }
        }
    }
    None
}

fn extract_opencode_account_id(tokens: &OAuthTokenExchangeResponse) -> Option<String> {
    extract_opencode_account_id_from_jwt(&tokens.id_token)
        .or_else(|| extract_opencode_account_id_from_jwt(&tokens.access_token))
}

fn resolve_opencode_expires_ms(tokens: &OAuthTokenExchangeResponse) -> i64 {
    if let Some(exp) =
        decode_jwt_payload(&tokens.access_token).and_then(|v| v.get("exp").and_then(Value::as_i64))
    {
        return exp.saturating_mul(1000);
    }
    let now_ms = Utc::now().timestamp_millis();
    if let Some(expires_in) = tokens.expires_in {
        let delta_ms = (expires_in.min(i64::MAX as u64) as i64).saturating_mul(1000);
        return now_ms.saturating_add(delta_ms);
    }
    now_ms.saturating_add(3600 * 1000)
}

fn build_opencode_openai_entry(tokens: &OAuthTokenExchangeResponse) -> Value {
    let mut entry = json!({
        "type": "oauth",
        "refresh": tokens.refresh_token,
        "access": tokens.access_token,
        "expires": resolve_opencode_expires_ms(tokens),
    });
    if let Some(account_id) = extract_opencode_account_id(tokens) {
        if let Some(map) = entry.as_object_mut() {
            map.insert("accountId".to_string(), Value::String(account_id));
        }
    }
    entry
}

fn write_opencode_openai_snapshot(
    target_dir: &Path,
    tokens: &OAuthTokenExchangeResponse,
) -> CmdResult<()> {
    fs::create_dir_all(target_dir).map_err(|e| format!("创建 OpenCode 快照目录失败: {e}"))?;
    let entry = build_opencode_openai_entry(tokens);
    let text = serde_json::to_string_pretty(&entry)
        .map_err(|e| format!("序列化 OpenCode 快照失败: {e}"))?;
    fs::write(
        target_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME),
        format!("{text}\n"),
    )
    .map_err(|e| format!("写入 OpenCode 快照失败: {e}"))
}

fn parse_codex_tokens_from_auth_file(auth_file: &Path) -> CmdResult<OAuthTokenExchangeResponse> {
    let raw = fs::read_to_string(auth_file)
        .map_err(|e| format!("读取登录态文件失败 {}: {e}", auth_file.display()))?;
    let payload: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("解析登录态文件失败 {}: {e}", auth_file.display()))?;
    let tokens = payload
        .get("tokens")
        .and_then(Value::as_object)
        .ok_or_else(|| "登录态文件缺少 tokens。".to_string())?;
    let id_token = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if id_token.is_empty() || access_token.is_empty() || refresh_token.is_empty() {
        return Err("登录态文件 tokens 字段不完整。".to_string());
    }
    Ok(OAuthTokenExchangeResponse {
        id_token,
        access_token,
        refresh_token,
        expires_in: None,
    })
}

fn ensure_opencode_snapshot_from_codex_auth(target_dir: &Path) -> CmdResult<()> {
    let tokens = parse_codex_tokens_from_auth_file(&target_dir.join(AUTH_FILE_NAME))?;
    write_opencode_openai_snapshot(target_dir, &tokens)
}

fn read_openai_entry_from_opencode_auth_file(auth_path: &Path) -> Option<Value> {
    let text = fs::read_to_string(auth_path).ok()?;
    let payload = serde_json::from_str::<Value>(&text).ok()?;
    let obj = payload.as_object()?;
    let entry = obj.get(OPENCODE_PROVIDER_ID)?.clone();
    if entry.is_object() {
        Some(entry)
    } else {
        None
    }
}

fn opencode_workspace_id_from_openai_entry(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    for key in ["accountId", "account_id", "workspace_id", "workspaceId"] {
        if let Some(value) = obj.get(key).and_then(Value::as_str) {
            let text = value.trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn opencode_plan_type_from_access_token(token: &str) -> Option<String> {
    let decoded = decode_jwt_payload(token)?;
    let root = decoded.as_object()?;
    let auth_claim = root
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object)?;
    read_non_empty_string(
        auth_claim,
        &["chatgpt_plan_type", "chatgptPlanType", "plan_type"],
    )
}

fn opencode_plan_type_from_openai_entry(entry: &Map<String, Value>) -> Option<String> {
    read_non_empty_string(entry, &["planType", "plan_type"]).or_else(|| {
        read_non_empty_string(entry, &["access", "access_token", "accessToken"])
            .and_then(|token| opencode_plan_type_from_access_token(&token))
    })
}

fn live_opencode_workspace_id_internal() -> Option<String> {
    let auth_path = opencode_auth_file().ok()?;
    let entry = read_openai_entry_from_opencode_auth_file(&auth_path)?;
    opencode_workspace_id_from_openai_entry(&entry)
}

fn write_codex_auth_from_opencode_entry(
    codex_home_dir: &Path,
    openai_entry: &Map<String, Value>,
) -> CmdResult<()> {
    let access = read_non_empty_string(openai_entry, &["access", "access_token", "accessToken"])
        .ok_or_else(|| "OpenCode auth 缺少 access token。".to_string())?;
    let refresh =
        read_non_empty_string(openai_entry, &["refresh", "refresh_token", "refreshToken"])
            .ok_or_else(|| "OpenCode auth 缺少 refresh token。".to_string())?;
    let account_id = read_non_empty_string(
        openai_entry,
        &["accountId", "account_id", "workspace_id", "workspaceId"],
    );

    let mut tokens = Map::new();
    tokens.insert("id_token".to_string(), Value::String(access.clone()));
    tokens.insert("access_token".to_string(), Value::String(access));
    tokens.insert("refresh_token".to_string(), Value::String(refresh));
    if let Some(id) = account_id {
        tokens.insert("account_id".to_string(), Value::String(id));
    }

    let mut root = Map::new();
    root.insert(
        "auth_mode".to_string(),
        Value::String("chatgpt".to_string()),
    );
    root.insert("OPENAI_API_KEY".to_string(), Value::Null);
    root.insert("tokens".to_string(), Value::Object(tokens));
    root.insert(
        "last_refresh".to_string(),
        Value::Number(serde_json::Number::from(Utc::now().timestamp())),
    );

    fs::create_dir_all(codex_home_dir)
        .map_err(|e| format!("创建 OpenCode 配额桥接目录失败: {e}"))?;
    let auth_path = codex_home_dir.join(AUTH_FILE_NAME);
    let text = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("序列化 OpenCode 桥接 auth.json 失败: {e}"))?;
    fs::write(&auth_path, format!("{text}\n")).map_err(|e| {
        format!(
            "写入 OpenCode 桥接 auth.json 失败 {}: {e}",
            auth_path.display()
        )
    })
}

#[derive(Debug, Clone)]
struct OpencodeLiveAuthContext {
    access_token: String,
    workspace_id: String,
    plan_type: Option<String>,
    bridge_home: PathBuf,
}

fn opencode_live_auth_context() -> CmdResult<OpencodeLiveAuthContext> {
    let auth_path = opencode_auth_file()?;
    let entry = read_openai_entry_from_opencode_auth_file(&auth_path)
        .ok_or_else(|| "OpenCode 未登录或缺少 openai 登录态。".to_string())?;
    let openai_entry = entry
        .as_object()
        .cloned()
        .ok_or_else(|| "OpenCode openai 登录态格式无效。".to_string())?;
    let access_token =
        read_non_empty_string(&openai_entry, &["access", "access_token", "accessToken"])
            .ok_or_else(|| "OpenCode auth 缺少 access token。".to_string())?;
    let workspace_id = opencode_workspace_id_from_openai_entry(&entry)
        .or_else(|| extract_opencode_account_id_from_jwt(&access_token))
        .ok_or_else(|| "OpenCode auth 缺少 accountId/workspaceId。".to_string())?;
    let plan_type = opencode_plan_type_from_openai_entry(&openai_entry);
    let bridge_home = opencode_quota_bridge_home()?;
    fs::create_dir_all(&bridge_home).map_err(|e| format!("创建 OpenCode 配额桥接目录失败: {e}"))?;
    Ok(OpencodeLiveAuthContext {
        access_token,
        workspace_id,
        plan_type,
        bridge_home,
    })
}

fn fetch_quota_from_live_opencode_auth_with_timeout(
    timeout_seconds: u64,
) -> CmdResult<AccountQuota> {
    let auth = opencode_live_auth_context()?;
    let access_token = auth.access_token.clone();
    let workspace_id = auth.workspace_id.clone();
    let plan_type = auth.plan_type.clone();

    let _guard = opencode_quota_bridge_lock()
        .lock()
        .map_err(|_| "OpenCode 配额桥接锁获取失败。".to_string())?;
    let bridge_home = auth.bridge_home;

    let requests = vec![
        json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "codex-switch", "version": "1.0.0"},
                "capabilities": {"experimentalApi": true}
            }
        }),
        json!({
            "id": 10,
            "method": "account/login/start",
            "params": {
                "type": "chatgptAuthTokens",
                "accessToken": access_token,
                "chatgptAccountId": workspace_id,
                "chatgptPlanType": plan_type.clone().map(Value::String).unwrap_or(Value::Null)
            }
        }),
        json!({
            "id": 2,
            "method": "account/read",
            "params": {"refreshToken": false}
        }),
        json!({
            "id": 3,
            "method": "account/rateLimits/read",
            "params": Value::Null
        }),
    ];
    let responses = app_server_request(&bridge_home, &requests, timeout_seconds, &[1, 10, 2, 3])?;
    let mut quota = account_quota_from_app_server_responses(&bridge_home, &responses, 2, 3)?;
    if quota
        .workspace_id
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        quota.workspace_id = Some(workspace_id);
    }
    if quota.plan_type.as_deref().unwrap_or("").trim().is_empty() {
        quota.plan_type = plan_type;
    }
    Ok(quota)
}

fn fetch_quota_from_live_opencode_auth() -> CmdResult<AccountQuota> {
    fetch_quota_from_live_opencode_auth_with_timeout(APP_SERVER_TIMEOUT_DEFAULT_SECONDS)
}

fn sync_opencode_snapshot_from_live_auth_best_effort(target_dir: &Path) {
    let snapshot_path = target_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME);
    let auth_path = match opencode_auth_file() {
        Ok(v) => v,
        Err(_) => return,
    };
    let Some(entry) = read_openai_entry_from_opencode_auth_file(&auth_path) else {
        if snapshot_path.exists() {
            let _ = fs::remove_file(snapshot_path);
        }
        return;
    };
    if let Ok(text) = serde_json::to_string_pretty(&entry) {
        let _ = fs::write(snapshot_path, format!("{text}\n"));
    }
}

fn apply_opencode_snapshot_to_live_auth(source_dir: &Path, backup_dir: &Path) -> CmdResult<()> {
    let snapshot_path = source_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME);
    if !snapshot_path.exists() {
        ensure_opencode_snapshot_from_codex_auth(source_dir).map_err(|e| {
            format!(
                "账号快照缺少 OpenCode 登录态快照，且自动补齐失败（{}）: {e}",
                snapshot_path.display()
            )
        })?;
    }
    if !snapshot_path.exists() {
        return Err(format!(
            "账号快照缺少 OpenCode 登录态快照，无法在 OpenCode 模式切号：{}",
            snapshot_path.display()
        ));
    }
    let snapshot_text = fs::read_to_string(&snapshot_path)
        .map_err(|e| format!("读取 OpenCode 快照失败 {}: {e}", snapshot_path.display()))?;
    let snapshot_value = serde_json::from_str::<Value>(&snapshot_text)
        .map_err(|e| format!("解析 OpenCode 快照失败 {}: {e}", snapshot_path.display()))?;
    if !snapshot_value.is_object() {
        return Err("OpenCode 快照格式错误：必须为对象。".to_string());
    }

    let auth_path = opencode_auth_file()?;
    if let Some(parent) = auth_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 OpenCode 数据目录失败: {e}"))?;
    }
    if auth_path.exists() {
        let _ = fs::copy(&auth_path, backup_dir.join(OPENCODE_AUTH_BACKUP_FILE_NAME));
    }

    let mut root = fs::read_to_string(&auth_path)
        .ok()
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    root.insert(OPENCODE_PROVIDER_ID.to_string(), snapshot_value);

    let text = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("序列化 OpenCode auth.json 失败: {e}"))?;
    fs::write(&auth_path, format!("{text}\n"))
        .map_err(|e| format!("写入 OpenCode auth.json 失败 {}: {e}", auth_path.display()))
}

fn copy_current_account_snapshot(target_dir: &Path) -> CmdResult<()> {
    let codex_home = codex_home()?;
    let auth_src = codex_home.join(AUTH_FILE_NAME);
    if !auth_src.exists() {
        return Err(format!("未找到 {}，请先登录 Codex。", auth_src.display()));
    }

    fs::create_dir_all(target_dir).map_err(|e| format!("创建目标目录失败: {e}"))?;
    fs::copy(&auth_src, target_dir.join(AUTH_FILE_NAME))
        .map_err(|e| format!("复制 auth.json 失败: {e}"))?;

    let cap_sid_src = codex_home.join(CAP_SID_FILE_NAME);
    if cap_sid_src.exists() {
        fs::copy(&cap_sid_src, target_dir.join(CAP_SID_FILE_NAME))
            .map_err(|e| format!("复制 cap_sid 失败: {e}"))?;
    }

    let config_src = codex_home.join(CONFIG_FILE_NAME);
    if config_src.exists() {
        fs::copy(&config_src, target_dir.join(CONFIG_FILE_NAME))
            .map_err(|e| format!("复制 config.toml 失败: {e}"))?;
    }
    sync_opencode_snapshot_from_live_auth_best_effort(target_dir);
    Ok(())
}

fn build_profile_record(
    profile_name: &str,
    snapshot_dir: &Path,
    quota: &AccountQuota,
    existing_record: Option<&Map<String, Value>>,
) -> Value {
    let workspace_alias = existing_record
        .and_then(|r| r.get("workspace_alias"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let support = existing_record
        .map(|r| profile_support_from_value(r.get("support")))
        .unwrap_or_else(default_profile_support);

    json!({
        "name": profile_name,
        "snapshot_dir": snapshot_dir.to_string_lossy().to_string(),
        "email": quota.email,
        "workspace_name": quota.workspace_name,
        "workspace_id": quota.workspace_id,
        "workspace_alias": workspace_alias,
        "support": profile_support_json(support),
        "plan_type": quota.plan_type,
        "quota": {
            "five_hour": quota.five_hour,
            "one_week": quota.one_week
        },
        "last_checked_at": now_iso(),
        "last_error": Value::Null,
        "updated_at": now_iso()
    })
}

fn apply_profile_snapshot(source_dir: &Path) -> CmdResult<String> {
    let auth_src = source_dir.join(AUTH_FILE_NAME);
    if !auth_src.exists() {
        return Err(format!(
            "账号快照缺少 {}: {}",
            AUTH_FILE_NAME,
            source_dir.display()
        ));
    }

    let codex_home = codex_home()?;
    fs::create_dir_all(&codex_home).map_err(|e| format!("创建 CODEX_HOME 失败: {e}"))?;

    let backup_dir =
        backups_dir()?.join(format!("backup_{}", Local::now().format("%Y%m%d_%H%M%S")));
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let auth_dst = codex_home.join(AUTH_FILE_NAME);
    if auth_dst.exists() {
        let _ = fs::copy(&auth_dst, backup_dir.join(AUTH_FILE_NAME));
    }
    fs::copy(&auth_src, &auth_dst).map_err(|e| format!("应用 auth.json 失败: {e}"))?;

    let cap_sid_src = source_dir.join(CAP_SID_FILE_NAME);
    let cap_sid_dst = codex_home.join(CAP_SID_FILE_NAME);
    if cap_sid_dst.exists() {
        let _ = fs::copy(&cap_sid_dst, backup_dir.join(CAP_SID_FILE_NAME));
    }
    if cap_sid_src.exists() {
        fs::copy(&cap_sid_src, &cap_sid_dst).map_err(|e| format!("应用 cap_sid 失败: {e}"))?;
    }

    apply_opencode_snapshot_to_live_auth(source_dir, &backup_dir)?;

    Ok(backup_dir
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("backup")
        .to_string())
}

fn apply_profile_snapshot_codex_only(source_dir: &Path) -> CmdResult<String> {
    let auth_src = source_dir.join(AUTH_FILE_NAME);
    if !auth_src.exists() {
        return Err(format!(
            "账号快照缺少 {}: {}",
            AUTH_FILE_NAME,
            source_dir.display()
        ));
    }

    let codex_home = codex_home()?;
    fs::create_dir_all(&codex_home).map_err(|e| format!("创建 CODEX_HOME 失败: {e}"))?;

    let backup_dir =
        backups_dir()?.join(format!("backup_{}", Local::now().format("%Y%m%d_%H%M%S")));
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let auth_dst = codex_home.join(AUTH_FILE_NAME);
    if auth_dst.exists() {
        let _ = fs::copy(&auth_dst, backup_dir.join(AUTH_FILE_NAME));
    }
    fs::copy(&auth_src, &auth_dst).map_err(|e| format!("应用 auth.json 失败: {e}"))?;

    let cap_sid_src = source_dir.join(CAP_SID_FILE_NAME);
    let cap_sid_dst = codex_home.join(CAP_SID_FILE_NAME);
    if cap_sid_dst.exists() {
        let _ = fs::copy(&cap_sid_dst, backup_dir.join(CAP_SID_FILE_NAME));
    }
    if cap_sid_src.exists() {
        fs::copy(&cap_sid_src, &cap_sid_dst).map_err(|e| format!("应用 cap_sid 失败: {e}"))?;
    }

    Ok(backup_dir
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("backup")
        .to_string())
}

fn apply_profile_snapshot_opencode_only(source_dir: &Path) -> CmdResult<String> {
    let backup_dir =
        backups_dir()?.join(format!("backup_{}", Local::now().format("%Y%m%d_%H%M%S")));
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    apply_opencode_snapshot_to_live_auth(source_dir, &backup_dir)?;
    Ok(backup_dir
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("backup")
        .to_string())
}

