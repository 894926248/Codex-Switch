fn load_store() -> CmdResult<StoreData> {
    ensure_dirs()?;
    let path = profiles_file()?;
    if !path.exists() {
        return Ok(StoreData::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 profiles.json 失败: {e}"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut data: StoreData =
        serde_json::from_str(&text).map_err(|e| format!("解析 profiles.json 失败: {e}"))?;
    if data.profiles.is_empty() {
        data.profiles = BTreeMap::new();
    }
    normalize_profile_order(&mut data);
    normalize_profile_support_in_store(&mut data);
    if dedupe_profiles_by_identity(&mut data) {
        save_store(&data)?;
    }
    Ok(data)
}

fn save_store(store: &StoreData) -> CmdResult<()> {
    ensure_dirs()?;
    let path = profiles_file()?;
    let mut normalized = store.clone();
    normalize_profile_order(&mut normalized);
    normalize_profile_support_in_store(&mut normalized);
    let text = serde_json::to_string_pretty(&normalized)
        .map_err(|e| format!("序列化 profiles.json 失败: {e}"))?;
    fs::write(path, format!("{text}\n")).map_err(|e| format!("写入 profiles.json 失败: {e}"))
}

fn list_profile_names(store: &StoreData) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for name in &store.profile_order {
        if store.profiles.contains_key(name) && seen.insert(name.clone()) {
            names.push(name.clone());
        }
    }

    let mut remaining: Vec<String> = store
        .profiles
        .keys()
        .filter(|name| !seen.contains(*name))
        .cloned()
        .collect();
    remaining.sort_by_key(|s| s.to_lowercase());
    names.extend(remaining);
    names
}

fn normalize_profile_order(store: &mut StoreData) {
    let mut normalized: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for name in &store.profile_order {
        if store.profiles.contains_key(name) && seen.insert(name.clone()) {
            normalized.push(name.clone());
        }
    }

    let mut missing: Vec<String> = store
        .profiles
        .keys()
        .filter(|name| !seen.contains(*name))
        .cloned()
        .collect();
    missing.sort_by_key(|s| s.to_lowercase());
    normalized.extend(missing);

    store.profile_order = normalized;
}

fn default_profile_support() -> ProfileSupportView {
    ProfileSupportView {
        gpt: true,
        opencode: false,
    }
}

fn profile_support_from_value(raw: Option<&Value>) -> ProfileSupportView {
    let mut support = default_profile_support();
    match raw {
        Some(Value::Object(map)) => {
            if let Some(v) = map.get(PROFILE_SUPPORT_GPT_KEY).and_then(Value::as_bool) {
                support.gpt = v;
            }
            if let Some(v) = map
                .get(PROFILE_SUPPORT_OPENCODE_KEY)
                .and_then(Value::as_bool)
            {
                support.opencode = v;
            }
        }
        Some(Value::String(v)) => {
            let token = v.trim().to_ascii_lowercase();
            match token.as_str() {
                "gpt" | "codex" | "chatgpt" => {
                    support.gpt = true;
                    support.opencode = false;
                }
                "opencode" => {
                    support.gpt = false;
                    support.opencode = true;
                }
                "both" | "all" | "gpt+opencode" | "gpt/opencode" => {
                    support.gpt = true;
                    support.opencode = true;
                }
                _ => {}
            }
        }
        Some(Value::Array(values)) => {
            let mut has_gpt = false;
            let mut has_opencode = false;
            for item in values {
                let Some(text) = item.as_str() else {
                    continue;
                };
                let token = text.trim().to_ascii_lowercase();
                if token.is_empty() {
                    continue;
                }
                if matches!(token.as_str(), "gpt" | "codex" | "chatgpt") {
                    has_gpt = true;
                }
                if token == "opencode" {
                    has_opencode = true;
                }
            }
            if has_gpt || has_opencode {
                support.gpt = has_gpt;
                support.opencode = has_opencode;
            }
        }
        _ => {}
    }
    support
}

fn profile_support_json(support: ProfileSupportView) -> Value {
    json!({
        PROFILE_SUPPORT_GPT_KEY: support.gpt,
        PROFILE_SUPPORT_OPENCODE_KEY: support.opencode
    })
}

fn normalize_profile_support_in_record(record: &mut Map<String, Value>) {
    let support = profile_support_from_value(record.get("support"));
    record.insert("support".to_string(), profile_support_json(support));
}

fn normalize_profile_support_in_store(store: &mut StoreData) {
    for record_value in store.profiles.values_mut() {
        let Some(record) = record_value.as_object_mut() else {
            continue;
        };
        normalize_profile_support_in_record(record);
    }
}

fn profile_snapshot_dir(profile_name: &str) -> CmdResult<PathBuf> {
    Ok(profiles_dir()?.join(profile_name))
}

fn sanitize_profile_name(raw: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut cleaned = String::new();
    for ch in raw.chars() {
        if invalid.contains(&ch) {
            cleaned.push('_');
        } else {
            cleaned.push(ch);
        }
    }
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        "current-account".to_string()
    } else {
        trimmed
    }
}

fn next_auto_profile_name(store: &StoreData, base_name: Option<&str>) -> String {
    let base = sanitize_profile_name(base_name.unwrap_or("current-account"));
    let names: HashSet<String> = list_profile_names(store).into_iter().collect();
    if !names.contains(&base) {
        return base;
    }
    let mut index = 2;
    loop {
        let candidate = format!("{base}-{index}");
        if !names.contains(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn normalize_identity_value(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn read_email_from_record(record: &Map<String, Value>) -> Option<String> {
    normalize_identity_value(record.get("email").and_then(Value::as_str))
}

fn read_workspace_id_from_record_or_auth(
    name: &str,
    record: &Map<String, Value>,
) -> Option<String> {
    if let Some(wid) = record.get("workspace_id").and_then(Value::as_str) {
        let value = wid.trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    let snapshot_dir = record_snapshot_dir(name, record).ok()?;
    let (_, wid) = read_workspace_info_from_auth_file(&snapshot_dir.join(AUTH_FILE_NAME));
    wid
}

fn find_profile_candidates_by_identity(
    store: &StoreData,
    workspace_id: Option<&str>,
    email: Option<&str>,
) -> Vec<String> {
    let target_workspace = normalize_identity_value(workspace_id);
    let target_email = normalize_identity_value(email);
    if target_workspace.is_none() && target_email.is_none() {
        return Vec::new();
    }

    let mut exact_matches: Vec<String> = Vec::new();
    let mut workspace_only_with_missing_email_matches: Vec<String> = Vec::new();
    let mut workspace_matches: Vec<String> = Vec::new();
    let mut email_matches: Vec<String> = Vec::new();

    for name in list_profile_names(store) {
        let record = match store.profiles.get(&name).and_then(Value::as_object) {
            Some(v) => v,
            None => continue,
        };

        let rec_workspace = normalize_identity_value(
            read_workspace_id_from_record_or_auth(&name, record).as_deref(),
        );
        let rec_email = read_email_from_record(record);

        if let (Some(target_w), Some(target_e)) =
            (target_workspace.as_deref(), target_email.as_deref())
        {
            if rec_workspace.as_deref() == Some(target_w) && rec_email.as_deref() == Some(target_e)
            {
                exact_matches.push(name);
                continue;
            }
            // Backward compatibility: allow matching legacy records without stored email,
            // but never overwrite another email under the same workspace.
            if rec_workspace.as_deref() == Some(target_w) && rec_email.is_none() {
                workspace_only_with_missing_email_matches.push(name);
            }
            continue;
        }

        if let Some(target_w) = target_workspace.as_deref() {
            if rec_workspace.as_deref() == Some(target_w) {
                workspace_matches.push(name);
            }
            continue;
        }

        if let Some(target_e) = target_email.as_deref() {
            if rec_email.as_deref() == Some(target_e) {
                email_matches.push(name);
            }
        }
    }

    if target_workspace.is_some() && target_email.is_some() {
        if !exact_matches.is_empty() {
            return exact_matches;
        }
        if !workspace_only_with_missing_email_matches.is_empty() {
            return workspace_only_with_missing_email_matches;
        }
        return Vec::new();
    }

    if target_workspace.is_some() {
        return workspace_matches;
    }

    email_matches
}

fn find_profile_name_by_identity(
    store: &StoreData,
    workspace_id: Option<&str>,
    email: Option<&str>,
) -> Option<String> {
    let matches = find_profile_candidates_by_identity(store, workspace_id, email);
    if matches.len() == 1 {
        return matches.into_iter().next();
    }
    None
}

fn find_profile_name_by_identity_prefer_existing(
    store: &StoreData,
    workspace_id: Option<&str>,
    email: Option<&str>,
) -> Option<String> {
    let candidates = find_profile_candidates_by_identity(store, workspace_id, email);
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return candidates.into_iter().next();
    }

    if let Some(active) = store.active_profile.as_deref() {
        if candidates.iter().any(|name| name == active) {
            return Some(active.to_string());
        }
    }

    let has_alias = |name: &str| -> bool {
        store
            .profiles
            .get(name)
            .and_then(Value::as_object)
            .and_then(|record| record.get("workspace_alias").and_then(Value::as_str))
            .map(str::trim)
            .map(|text| !text.is_empty())
            .unwrap_or(false)
    };
    let sort_stamp = |name: &str| -> String {
        store
            .profiles
            .get(name)
            .and_then(Value::as_object)
            .and_then(|record| {
                record
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .or_else(|| record.get("last_checked_at").and_then(Value::as_str))
            })
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };

    let mut best = candidates[0].clone();
    for name in candidates.iter().skip(1) {
        let best_alias = has_alias(&best);
        let name_alias = has_alias(name);
        if name_alias && !best_alias {
            best = name.clone();
            continue;
        }
        if best_alias == name_alias && sort_stamp(name) > sort_stamp(&best) {
            best = name.clone();
        }
    }
    Some(best)
}

fn profile_identity_key(name: &str, record: &Map<String, Value>) -> Option<String> {
    let workspace =
        normalize_identity_value(read_workspace_id_from_record_or_auth(name, record).as_deref())?;
    let email = read_email_from_record(record)?;
    Some(format!("{workspace}|{email}"))
}

fn dedupe_profiles_by_identity(store: &mut StoreData) -> bool {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for name in list_profile_names(store) {
        let Some(record) = store.profiles.get(&name).and_then(Value::as_object) else {
            continue;
        };
        let Some(key) = profile_identity_key(&name, record) else {
            continue;
        };
        groups.entry(key).or_default().push(name);
    }

    let mut changed = false;
    for names in groups.values() {
        if names.len() <= 1 {
            continue;
        }

        let Some(record) = store.profiles.get(&names[0]).and_then(Value::as_object) else {
            continue;
        };
        let workspace_id = read_workspace_id_from_record_or_auth(&names[0], record);
        let email = read_email_from_record(record);
        let keep = find_profile_name_by_identity_prefer_existing(
            store,
            workspace_id.as_deref(),
            email.as_deref(),
        )
        .unwrap_or_else(|| names[0].clone());

        for name in names {
            if name == &keep {
                continue;
            }
            let removed = store.profiles.remove(name);
            if let Some(record_value) = removed {
                if let Some(record_obj) = record_value.as_object() {
                    if let Ok(snapshot_dir) = record_snapshot_dir(name, record_obj) {
                        safe_remove_dir(&snapshot_dir);
                    }
                }
                store.profile_order.retain(|item| item != name);
                if store.active_profile.as_deref() == Some(name.as_str()) {
                    store.active_profile = Some(keep.clone());
                }
                changed = true;
            }
        }
    }

    if changed {
        normalize_profile_order(store);
    }
    changed
}

fn find_workspace_alias_by_identity(
    store: &StoreData,
    workspace_id: Option<&str>,
    email: Option<&str>,
) -> Option<String> {
    let name = find_profile_name_by_identity(store, workspace_id, email)?;
    let record = store.profiles.get(&name).and_then(Value::as_object)?;
    let alias = record
        .get("workspace_alias")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if alias.is_empty() {
        None
    } else {
        Some(alias)
    }
}

fn format_workspace_display(
    workspace_name: Option<&str>,
    _workspace_id: Option<&str>,
    workspace_alias: Option<&str>,
) -> String {
    let alias = workspace_alias.map(str::trim).filter(|s| !s.is_empty());
    let name = workspace_name.map(str::trim).filter(|s| !s.is_empty());
    alias.or(name).unwrap_or("未命名空间").to_string()
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let payload = parts[1];
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok().or_else(|| {
        let mut padded = payload.to_string();
        while padded.len() % 4 != 0 {
            padded.push('=');
        }
        URL_SAFE.decode(padded).ok()
    })?;
    serde_json::from_slice::<Value>(&decoded).ok()
}

fn read_non_empty_string(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = map.get(*key).and_then(Value::as_str) {
            let v = value.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn workspace_id_from_org(org_map: &Map<String, Value>) -> Option<String> {
    read_non_empty_string(
        org_map,
        &[
            "id",
            "org_id",
            "organization_id",
            "account_id",
            "chatgpt_account_id",
            "workspace_id",
            "workspaceId",
        ],
    )
}

fn pick_workspace_name_from_auth_claim(
    auth_claim: &Map<String, Value>,
    preferred_workspace_id: Option<&str>,
    allow_fallback: bool,
) -> Option<String> {
    if let Some(orgs) = auth_claim.get("organizations").and_then(Value::as_array) {
        if let Some(target) = preferred_workspace_id.map(|v| v.trim().to_lowercase()) {
            for org in orgs {
                let Some(org_map) = org.as_object() else {
                    continue;
                };
                let Some(org_id) = workspace_id_from_org(org_map) else {
                    continue;
                };
                if org_id.trim().to_lowercase() != target {
                    continue;
                }
                if let Some(title) = org_map.get("title").and_then(Value::as_str) {
                    let t = title.trim().to_string();
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
        }

        if allow_fallback {
            for org in orgs {
                let Some(org_map) = org.as_object() else {
                    continue;
                };
                let is_default = org_map
                    .get("is_default")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !is_default {
                    continue;
                }
                if let Some(title) = org_map.get("title").and_then(Value::as_str) {
                    let t = title.trim().to_string();
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
            for org in orgs {
                let Some(org_map) = org.as_object() else {
                    continue;
                };
                if let Some(title) = org_map.get("title").and_then(Value::as_str) {
                    let t = title.trim().to_string();
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
        }
    }

    if allow_fallback {
        return read_non_empty_string(
            auth_claim,
            &[
                "workspace_name",
                "chatgpt_workspace_name",
                "organization_name",
                "org_name",
            ],
        );
    }
    None
}

fn pick_workspace_id_from_auth_claim(auth_claim: &Map<String, Value>) -> Option<String> {
    for key in [
        "chatgpt_account_id",
        "chatgptAccountId",
        "workspace_id",
        "workspaceId",
    ] {
        if let Some(value) = auth_claim.get(key).and_then(Value::as_str) {
            let v = value.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn read_workspace_info_from_auth_file(auth_file: &Path) -> (Option<String>, Option<String>) {
    if !auth_file.exists() {
        return (None, None);
    }
    let payload: Value = match fs::read_to_string(auth_file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        Some(v) => v,
        None => return (None, None),
    };
    let Some(tokens) = payload.get("tokens").and_then(Value::as_object) else {
        return (None, None);
    };

    let mut workspace_name_exact: Option<String> = None;
    let mut workspace_name_fallback: Option<String> = None;
    let mut workspace_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    for key in ["id_token", "access_token"] {
        let Some(token) = tokens.get(key).and_then(Value::as_str) else {
            continue;
        };
        let Some(decoded) = decode_jwt_payload(token) else {
            continue;
        };
        let Some(auth_claim) = decoded
            .get("https://api.openai.com/auth")
            .and_then(Value::as_object)
        else {
            continue;
        };
        if workspace_id.is_none() {
            workspace_id = pick_workspace_id_from_auth_claim(auth_claim);
        }
        if workspace_name_fallback.is_none() {
            workspace_name_fallback = pick_workspace_name_from_auth_claim(auth_claim, None, true);
        }
        if workspace_name_exact.is_none() {
            workspace_name_exact =
                pick_workspace_name_from_auth_claim(auth_claim, workspace_id.as_deref(), false);
        }
        if workspace_name_exact.is_some() && workspace_id.is_some() {
            break;
        }
    }
    if workspace_id.as_deref().unwrap_or("").trim().is_empty() {
        (
            workspace_name_exact.or(workspace_name_fallback),
            workspace_id,
        )
    } else {
        // When workspace id is known, avoid falling back to an unrelated org title.
        (workspace_name_exact, workspace_id)
    }
}

fn read_auth_token_health(auth_file: &Path) -> TokenHealth {
    if !auth_file.exists() {
        return TokenHealth {
            exists: false,
            has_refresh: false,
            access_exp: None,
        };
    }
    let payload: Value = match fs::read_to_string(auth_file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        Some(v) => v,
        None => {
            return TokenHealth {
                exists: false,
                has_refresh: false,
                access_exp: None,
            }
        }
    };
    let Some(tokens) = payload.get("tokens").and_then(Value::as_object) else {
        return TokenHealth {
            exists: true,
            has_refresh: false,
            access_exp: None,
        };
    };

    let has_refresh = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    let access_exp = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .and_then(decode_jwt_payload)
        .and_then(|v| v.get("exp").and_then(Value::as_i64));

    TokenHealth {
        exists: true,
        has_refresh,
        access_exp,
    }
}

fn is_auth_error(error_text: Option<&str>) -> bool {
    let lowered = error_text.unwrap_or("").to_lowercase();
    if lowered.is_empty() {
        return false;
    }
    AUTH_ERROR_KEYWORDS.iter().any(|kw| lowered.contains(kw))
}

fn profile_validity(record: &Map<String, Value>, snapshot_dir: &Path) -> String {
    let token_health = read_auth_token_health(&snapshot_dir.join(AUTH_FILE_NAME));
    if !token_health.exists {
        return "已失效".to_string();
    }

    let last_error = record.get("last_error").and_then(Value::as_str);
    if is_auth_error(last_error) {
        return "已失效".to_string();
    }

    let now_ts = Local::now().timestamp();
    if let Some(exp) = token_health.access_exp {
        if exp <= now_ts && !token_health.has_refresh {
            return "已失效".to_string();
        }
    }
    let plan_type = record
        .get("plan_type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if plan_type == "free" && !record_has_window_duration(record, 300, 30) {
        return "受限(仅周额度)".to_string();
    }
    "正常".to_string()
}

fn record_snapshot_dir(name: &str, record: &Map<String, Value>) -> CmdResult<PathBuf> {
    if let Some(path_text) = record.get("snapshot_dir").and_then(Value::as_str) {
        let path = PathBuf::from(path_text);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }
    profile_snapshot_dir(name)
}

fn window_quota_from_payload(payload: Option<&Value>) -> Option<WindowQuota> {
    let map = payload?.as_object()?;
    let used = map.get("usedPercent").and_then(Value::as_i64)?;
    let win = map.get("windowDurationMins").and_then(Value::as_i64);
    let resets_at = map.get("resetsAt").and_then(Value::as_i64);
    let remaining = (100 - used).clamp(0, 100);
    Some(WindowQuota {
        window_minutes: win,
        used_percent: Some(used),
        remaining_percent: Some(remaining),
        resets_at,
    })
}

fn pick_window(
    windows: &[WindowQuota],
    target_minutes: i64,
    tolerance_minutes: i64,
) -> Option<WindowQuota> {
    if windows.is_empty() {
        return None;
    }
    if let Some(exact) = windows
        .iter()
        .find(|w| w.window_minutes == Some(target_minutes))
        .cloned()
    {
        return Some(exact);
    }
    windows
        .iter()
        .filter_map(|w| {
            let mins = w.window_minutes?;
            let diff = (mins - target_minutes).abs();
            if diff <= tolerance_minutes {
                Some((w.clone(), diff))
            } else {
                None
            }
        })
        .min_by_key(|(_, diff)| *diff)
        .map(|(w, _)| w)
}

fn record_has_window_duration(
    record: &Map<String, Value>,
    target_minutes: i64,
    tolerance_minutes: i64,
) -> bool {
    let quota = record.get("quota").and_then(Value::as_object);
    let five = quota
        .and_then(|q| q.get("five_hour").or_else(|| q.get("fiveHour")))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let week = quota
        .and_then(|q| q.get("one_week").or_else(|| q.get("oneWeek")))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mins_from = |obj: &Map<String, Value>| -> Option<i64> {
        obj.get("window_minutes")
            .or_else(|| obj.get("windowMinutes"))
            .and_then(Value::as_i64)
    };
    [mins_from(&five), mins_from(&week)]
        .into_iter()
        .flatten()
        .any(|mins| (mins - target_minutes).abs() <= tolerance_minutes)
}

