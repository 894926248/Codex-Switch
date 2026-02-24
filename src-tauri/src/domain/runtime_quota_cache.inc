fn current_quota_runtime_cache() -> &'static Mutex<CurrentQuotaRuntimeCache> {
    CURRENT_QUOTA_RUNTIME_CACHE.get_or_init(|| Mutex::new(CurrentQuotaRuntimeCache::default()))
}

fn opencode_current_quota_runtime_cache() -> &'static Mutex<CurrentQuotaRuntimeCache> {
    OPENCODE_CURRENT_QUOTA_RUNTIME_CACHE
        .get_or_init(|| Mutex::new(CurrentQuotaRuntimeCache::default()))
}

fn opencode_quota_bridge_lock() -> &'static Mutex<()> {
    OPENCODE_QUOTA_BRIDGE_LOCK.get_or_init(|| Mutex::new(()))
}

fn live_quota_store_sync_state() -> &'static Mutex<HashMap<String, i64>> {
    LIVE_QUOTA_STORE_SYNC_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gpt_rate_limit_push_state() -> &'static Mutex<GptRateLimitPushState> {
    GPT_RATE_LIMIT_PUSH_STATE.get_or_init(|| Mutex::new(GptRateLimitPushState::default()))
}

fn opencode_rate_limit_push_state() -> &'static Mutex<OpencodeRateLimitPushState> {
    OPENCODE_RATE_LIMIT_PUSH_STATE.get_or_init(|| Mutex::new(OpencodeRateLimitPushState::default()))
}

fn live_quota_store_sync_allowed(sync_key: &str, now_ms: i64, force: bool) -> bool {
    if force {
        return true;
    }
    let Ok(state) = live_quota_store_sync_state().lock() else {
        return false;
    };
    let last_ms = state.get(sync_key).copied().unwrap_or(0);
    now_ms.saturating_sub(last_ms) >= LIVE_QUOTA_STORE_SYNC_INTERVAL_MS
}

fn mark_live_quota_store_synced(sync_key: &str, now_ms: i64) {
    if let Ok(mut state) = live_quota_store_sync_state().lock() {
        state.insert(sync_key.to_string(), now_ms);
    }
}

fn apply_quota_to_profile_record(record: &mut Map<String, Value>, quota: &AccountQuota) {
    record.insert(
        "email".to_string(),
        quota
            .email
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    record.insert(
        "workspace_name".to_string(),
        quota
            .workspace_name
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    record.insert(
        "workspace_id".to_string(),
        quota
            .workspace_id
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    record.insert(
        "plan_type".to_string(),
        quota
            .plan_type
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    let quota_value = json!({
        "five_hour": quota.five_hour,
        "one_week": quota.one_week
    });
    record.insert("quota".to_string(), quota_value);
    record.insert("last_checked_at".to_string(), Value::String(now_iso()));
    record.insert("last_error".to_string(), Value::Null);
    record.insert("updated_at".to_string(), Value::String(now_iso()));
}

fn fallback_profile_name_for_live_sync(store: &StoreData, quota: &AccountQuota) -> Option<String> {
    let target_workspace = normalize_identity_value(quota.workspace_id.as_deref());
    let target_email = normalize_identity_value(quota.email.as_deref());

    let mut workspace_matches: Vec<String> = Vec::new();
    let mut email_matches: Vec<String> = Vec::new();

    for name in list_profile_names(store) {
        let Some(record) = store.profiles.get(&name).and_then(Value::as_object) else {
            continue;
        };
        let rec_workspace =
            normalize_identity_value(read_workspace_id_from_record_or_auth(&name, record).as_deref());
        let rec_email = read_email_from_record(record);

        if let Some(target) = target_workspace.as_deref() {
            if rec_workspace.as_deref() == Some(target) {
                workspace_matches.push(name.clone());
            }
        }
        if let Some(target) = target_email.as_deref() {
            if rec_email.as_deref() == Some(target) {
                email_matches.push(name);
            }
        }
    }

    let choose_active = |candidates: &[String]| -> Option<String> {
        let active = store.active_profile.as_deref()?;
        candidates
            .iter()
            .find(|name| name.as_str() == active)
            .cloned()
    };

    if target_workspace.is_some() {
        if workspace_matches.len() == 1 {
            return workspace_matches.into_iter().next();
        }
        if workspace_matches.is_empty() {
            return None;
        }
        if let Some(active) = choose_active(&workspace_matches) {
            return Some(active);
        }
        return workspace_matches.into_iter().next();
    }

    if target_email.is_some() && email_matches.len() == 1 {
        return email_matches.into_iter().next();
    }

    None
}

fn sync_live_quota_to_store(
    store: &mut StoreData,
    quota: &AccountQuota,
    now_ms: i64,
    mode: AutoSwitchMode,
    force: bool,
) {
    let Some(profile_name) = find_profile_name_by_identity_prefer_existing(
        store,
        quota.workspace_id.as_deref(),
        quota.email.as_deref(),
    )
    .or_else(|| fallback_profile_name_for_live_sync(store, quota))
    else {
        return;
    };
    let sync_key = format!(
        "{}:{}",
        if matches!(mode, AutoSwitchMode::OpenCode) {
            "opencode"
        } else {
            "gpt"
        },
        profile_name
    );
    if !live_quota_store_sync_allowed(&sync_key, now_ms, force) {
        return;
    }
    let Some(record_value) = store.profiles.get(&profile_name).cloned() else {
        return;
    };
    let mut record = record_value.as_object().cloned().unwrap_or_default();
    apply_quota_to_profile_record(&mut record, quota);
    store
        .profiles
        .insert(profile_name.clone(), Value::Object(record));
    if save_store(store).is_ok() {
        mark_live_quota_store_synced(&sync_key, now_ms);
    }
}

fn cached_quota_snapshot_for_cache(
    cache: &Mutex<CurrentQuotaRuntimeCache>,
    now_ms: i64,
) -> Option<(AccountQuota, i64)> {
    let cache = cache.lock().ok()?;
    let quota = cache.quota.clone()?;
    if cache.fetched_at_ms <= 0 {
        return None;
    }
    let age_ms = now_ms.saturating_sub(cache.fetched_at_ms);
    if age_ms > CURRENT_QUOTA_CACHE_MAX_AGE_MS {
        return None;
    }
    Some((quota, age_ms))
}

fn cached_current_quota_snapshot(now_ms: i64) -> Option<(AccountQuota, i64)> {
    cached_quota_snapshot_for_cache(current_quota_runtime_cache(), now_ms)
}

fn cached_opencode_quota_snapshot(now_ms: i64) -> Option<(AccountQuota, i64)> {
    cached_quota_snapshot_for_cache(opencode_current_quota_runtime_cache(), now_ms)
}

fn update_quota_runtime_cache(
    cache: &Mutex<CurrentQuotaRuntimeCache>,
    quota: &AccountQuota,
    now_ms: i64,
) {
    if let Ok(mut cache) = cache.lock() {
        cache.quota = Some(quota.clone());
        cache.fetched_at_ms = now_ms;
        cache.last_error = None;
        cache.last_error_at_ms = 0;
    }
}

fn update_current_quota_runtime_cache(quota: &AccountQuota, now_ms: i64) {
    update_quota_runtime_cache(current_quota_runtime_cache(), quota, now_ms);
}

fn update_opencode_quota_runtime_cache(quota: &AccountQuota, now_ms: i64) {
    update_quota_runtime_cache(opencode_current_quota_runtime_cache(), quota, now_ms);
}

fn mark_quota_runtime_error(cache: &Mutex<CurrentQuotaRuntimeCache>, err: &str, now_ms: i64) {
    if let Ok(mut cache) = cache.lock() {
        cache.last_error = Some(err.to_string());
        cache.last_error_at_ms = now_ms;
    }
}

fn mark_current_quota_runtime_error(err: &str, now_ms: i64) {
    mark_quota_runtime_error(current_quota_runtime_cache(), err, now_ms);
}

fn mark_opencode_quota_runtime_error(err: &str, now_ms: i64) {
    mark_quota_runtime_error(opencode_current_quota_runtime_cache(), err, now_ms);
}

fn latest_quota_runtime_error(
    cache: &Mutex<CurrentQuotaRuntimeCache>,
    now_ms: i64,
    max_age_ms: i64,
) -> Option<String> {
    let cache = cache.lock().ok()?;
    let err = cache.last_error.clone()?;
    if cache.last_error_at_ms <= 0 {
        return None;
    }
    if now_ms.saturating_sub(cache.last_error_at_ms) > max_age_ms {
        return None;
    }
    Some(err)
}

fn latest_opencode_quota_runtime_error(now_ms: i64, max_age_ms: i64) -> Option<String> {
    latest_quota_runtime_error(opencode_current_quota_runtime_cache(), now_ms, max_age_ms)
}

fn quota_runtime_error_is_hot(
    cache: &Mutex<CurrentQuotaRuntimeCache>,
    now_ms: i64,
    cooldown_ms: i64,
) -> bool {
    let Ok(cache) = cache.lock() else {
        return false;
    };
    if cache.last_error_at_ms <= 0 {
        return false;
    }
    now_ms.saturating_sub(cache.last_error_at_ms) < cooldown_ms
}

fn current_quota_runtime_error_is_hot(now_ms: i64, cooldown_ms: i64) -> bool {
    quota_runtime_error_is_hot(current_quota_runtime_cache(), now_ms, cooldown_ms)
}

fn opencode_quota_runtime_error_is_hot(now_ms: i64, cooldown_ms: i64) -> bool {
    quota_runtime_error_is_hot(opencode_current_quota_runtime_cache(), now_ms, cooldown_ms)
}

fn cached_quota_matches_workspace_id(quota: &AccountQuota, workspace_id: Option<&str>) -> bool {
    let live = workspace_id.map(str::trim).unwrap_or("").to_string();
    let cached = quota
        .workspace_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if live.is_empty() || cached.is_empty() {
        return true;
    }
    live.eq_ignore_ascii_case(&cached)
}

fn cached_quota_matches_live_workspace(codex_home: &Path, quota: &AccountQuota) -> bool {
    let (_, live_workspace_id) =
        read_workspace_info_from_auth_file(&codex_home.join(AUTH_FILE_NAME));
    cached_quota_matches_workspace_id(quota, live_workspace_id.as_deref())
}

fn current_status_from_quota(store: &StoreData, quota: &AccountQuota) -> CurrentStatusView {
    let alias = find_workspace_alias_by_identity(
        store,
        quota.workspace_id.as_deref(),
        quota.email.as_deref(),
    );
    let display_workspace = format_workspace_display(
        quota.workspace_name.as_deref(),
        quota.workspace_id.as_deref(),
        alias.as_deref(),
    );
    CurrentStatusView {
        email: quota.email.clone(),
        workspace_name: quota.workspace_name.clone(),
        workspace_id: quota.workspace_id.clone(),
        display_workspace,
        five_hour_remaining_percent: quota.five_hour.as_ref().and_then(|v| v.remaining_percent),
        five_hour_resets_at: quota.five_hour.as_ref().and_then(|v| v.resets_at),
        one_week_remaining_percent: quota.one_week.as_ref().and_then(|v| v.remaining_percent),
        one_week_resets_at: quota.one_week.as_ref().and_then(|v| v.resets_at),
    }
}

