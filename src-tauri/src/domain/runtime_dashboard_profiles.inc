fn build_auto_profile_base(quota: &AccountQuota) -> String {
    let email = quota.email.clone().unwrap_or_default();
    let workspace = quota
        .workspace_name
        .clone()
        .or_else(|| quota.workspace_id.clone())
        .unwrap_or_default();
    let email = email.trim();
    let workspace = workspace.trim();

    if !email.is_empty() && !workspace.is_empty() {
        format!("{email} [{workspace}]")
    } else if !workspace.is_empty() {
        workspace.to_string()
    } else if !email.is_empty() {
        email.to_string()
    } else {
        "current-account".to_string()
    }
}

fn refresh_one_profile_quota_with_timeout(
    store: &mut StoreData,
    name: &str,
    refresh_token: bool,
    timeout_seconds: u64,
) -> bool {
    let Some(record) = store.profiles.get(name).and_then(Value::as_object).cloned() else {
        return false;
    };
    let (next_record, refreshed) =
        refresh_profile_record_quota_with_timeout(name, record, refresh_token, timeout_seconds);
    store
        .profiles
        .insert(name.to_string(), Value::Object(next_record));
    refreshed
}

fn refresh_profile_record_quota_with_timeout(
    name: &str,
    mut record: Map<String, Value>,
    refresh_token: bool,
    timeout_seconds: u64,
) -> (Map<String, Value>, bool) {
    let snapshot_dir = match record_snapshot_dir(name, &record) {
        Ok(v) => v,
        Err(err) => {
            record.insert("last_checked_at".to_string(), Value::String(now_iso()));
            record.insert("last_error".to_string(), Value::String(err));
            return (record, false);
        }
    };

    if !snapshot_dir.join(AUTH_FILE_NAME).exists() {
        record.insert("last_checked_at".to_string(), Value::String(now_iso()));
        record.insert(
            "last_error".to_string(),
            Value::String(format!("缺少 {}", AUTH_FILE_NAME)),
        );
        return (record, false);
    }

    match fetch_quota_from_codex_home_with_timeout(&snapshot_dir, refresh_token, timeout_seconds) {
        Ok(quota) => {
            record.insert(
                "email".to_string(),
                quota.email.map(Value::String).unwrap_or(Value::Null),
            );
            record.insert(
                "workspace_name".to_string(),
                quota
                    .workspace_name
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            record.insert(
                "workspace_id".to_string(),
                quota.workspace_id.map(Value::String).unwrap_or(Value::Null),
            );
            record.insert(
                "plan_type".to_string(),
                quota.plan_type.map(Value::String).unwrap_or(Value::Null),
            );
            let quota_value = json!({
                "five_hour": quota.five_hour,
                "one_week": quota.one_week
            });
            record.insert("quota".to_string(), quota_value);
            record.insert("last_checked_at".to_string(), Value::String(now_iso()));
            record.insert("last_error".to_string(), Value::Null);
            (record, true)
        }
        Err(err) => {
            record.insert("last_checked_at".to_string(), Value::String(now_iso()));
            record.insert("last_error".to_string(), Value::String(err));
            (record, false)
        }
    }
}

fn should_refresh_candidate_for_soft_trigger(record: &Map<String, Value>, now_sec: i64) -> bool {
    let (five, five_reset, week, week_reset) = quota_fields_from_record(record);
    if candidate_quota_ok(five, week) {
        return true;
    }
    let maybe_recovered =
        |remain: Option<i64>, min_required: i64, reset_at: Option<i64>| match remain {
            Some(value) if value <= min_required => {
                reset_at.map(|ts| ts <= now_sec).unwrap_or(false)
            }
            Some(_) => true,
            None => false,
        };
    maybe_recovered(five, CANDIDATE_MIN_FIVE_HOUR, five_reset)
        && maybe_recovered(week, CANDIDATE_MIN_ONE_WEEK, week_reset)
}

fn refresh_one_profile_quota(store: &mut StoreData, name: &str, refresh_token: bool) -> bool {
    refresh_one_profile_quota_with_timeout(
        store,
        name,
        refresh_token,
        APP_SERVER_TIMEOUT_DEFAULT_SECONDS,
    )
}

fn quota_fields_from_record(
    record: &Map<String, Value>,
) -> (Option<i64>, Option<i64>, Option<i64>, Option<i64>) {
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

    let read_i64 = |obj: &Map<String, Value>, key1: &str, key2: &str| {
        obj.get(key1)
            .or_else(|| obj.get(key2))
            .and_then(Value::as_i64)
    };
    let calc_remaining_from_used = |obj: &Map<String, Value>| {
        read_i64(obj, "used_percent", "usedPercent").map(|used| (100 - used).clamp(0, 100))
    };

    let five_pct = read_i64(&five, "remaining_percent", "remainingPercent")
        .or_else(|| calc_remaining_from_used(&five));
    let five_reset = read_i64(&five, "resets_at", "resetsAt");
    let week_pct = read_i64(&week, "remaining_percent", "remainingPercent")
        .or_else(|| calc_remaining_from_used(&week));
    let week_reset = read_i64(&week, "resets_at", "resetsAt");
    (five_pct, five_reset, week_pct, week_reset)
}

fn build_profile_view(store: &StoreData, name: &str, record: &Map<String, Value>) -> ProfileView {
    let snapshot_dir = record_snapshot_dir(name, record).unwrap_or_else(|_| PathBuf::from(name));
    let mut workspace_name = record
        .get("workspace_name")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let mut workspace_id = record
        .get("workspace_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    if workspace_name.as_deref().unwrap_or("").trim().is_empty()
        && workspace_id.as_deref().unwrap_or("").trim().is_empty()
    {
        let (wname, wid) = read_workspace_info_from_auth_file(&snapshot_dir.join(AUTH_FILE_NAME));
        workspace_name = wname;
        workspace_id = wid;
    }

    let workspace_alias = record
        .get("workspace_alias")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let support = profile_support_from_value(record.get("support"));
    let display_workspace = format_workspace_display(
        workspace_name.as_deref(),
        workspace_id.as_deref(),
        workspace_alias.as_deref(),
    );
    let (five_pct, five_reset, week_pct, week_reset) = quota_fields_from_record(record);
    let validity = profile_validity(record, &snapshot_dir);
    let is_active = store.active_profile.as_deref() == Some(name);
    let status = if is_active {
        format!("{validity}(当前生效)")
    } else {
        validity
    };

    ProfileView {
        name: name.to_string(),
        email: record
            .get("email")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        workspace_name,
        workspace_id,
        workspace_alias,
        support,
        display_workspace,
        five_hour_remaining_percent: five_pct,
        five_hour_resets_at: five_reset,
        one_week_remaining_percent: week_pct,
        one_week_resets_at: week_reset,
        last_checked_at: record
            .get("last_checked_at")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        last_error: record
            .get("last_error")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        status,
        is_active,
    }
}

fn build_dashboard(
    store: &StoreData,
    current: Option<CurrentStatusView>,
    opencode_current: Option<CurrentStatusView>,
    current_error: Option<String>,
    current_error_mode: Option<String>,
) -> DashboardData {
    let mut profiles = Vec::new();
    for name in list_profile_names(store) {
        let record = store
            .profiles
            .get(&name)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        profiles.push(build_profile_view(store, &name, &record));
    }
    DashboardData {
        app_name: APP_NAME.to_string(),
        active_profile: store.active_profile.clone(),
        current,
        opencode_current,
        current_error,
        current_error_mode,
        last_keepalive_at: store.last_keepalive_at,
        profiles,
    }
}

include!("runtime_quota_cache.inc");

fn auto_sync_current_account_to_list(
    store: &mut StoreData,
    quota: &AccountQuota,
) -> CmdResult<String> {
    let matched = find_profile_name_by_identity_prefer_existing(
        store,
        quota.workspace_id.as_deref(),
        quota.email.as_deref(),
    );

    if let Some(name) = matched {
        let target = profile_snapshot_dir(&name)?;
        copy_current_account_snapshot(&target)?;
        let existing = store.profiles.get(&name).and_then(Value::as_object);
        let record = build_profile_record(&name, &target, quota, existing);
        store.profiles.insert(name.clone(), record);
        store.active_profile = Some(name.clone());
        return Ok(name);
    }

    let auto_name = next_auto_profile_name(store, Some(&build_auto_profile_base(quota)));
    let target = profile_snapshot_dir(&auto_name)?;
    copy_current_account_snapshot(&target)?;
    let record = build_profile_record(&auto_name, &target, quota, None);
    store.profiles.insert(auto_name.clone(), record);
    store.active_profile = Some(auto_name.clone());
    Ok(auto_name)
}

fn fetch_quota_from_opencode_profile_snapshot_with_timeout(
    store: &StoreData,
    workspace_id: Option<&str>,
    timeout_seconds: u64,
) -> CmdResult<AccountQuota> {
    let profile_name = find_profile_name_by_identity_prefer_existing(store, workspace_id, None)
        .ok_or_else(|| "OpenCode 当前账号未映射到已保存账号快照。".to_string())?;
    let record = store
        .profiles
        .get(&profile_name)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("账号记录缺失: {profile_name}"))?;
    let snapshot_dir = record_snapshot_dir(&profile_name, record)?;
    fetch_quota_from_codex_home_with_timeout(&snapshot_dir, false, timeout_seconds)
}

fn fetch_quota_from_opencode_profile_snapshot(
    store: &StoreData,
    workspace_id: Option<&str>,
) -> CmdResult<AccountQuota> {
    fetch_quota_from_opencode_profile_snapshot_with_timeout(
        store,
        workspace_id,
        APP_SERVER_TIMEOUT_DEFAULT_SECONDS,
    )
}

fn load_live_opencode_current_status(
    store: &mut StoreData,
    sync_current: bool,
    now_ms: i64,
) -> (Option<CurrentStatusView>, Option<String>) {
    let live_workspace_id = live_opencode_workspace_id_internal();
    let cached_quota = cached_opencode_quota_snapshot(now_ms).and_then(|(quota, age_ms)| {
        if cached_quota_matches_workspace_id(&quota, live_workspace_id.as_deref()) {
            Some((quota, age_ms))
        } else {
            None
        }
    });
    let push_running = opencode_rate_limit_push_state()
        .lock()
        .ok()
        .map(|state| state.running)
        .unwrap_or(false);

    let fresh_cache_max_age_ms = if push_running {
        OPENCODE_RATE_LIMIT_PUSH_READ_INTERVAL_MS + 5_000
    } else {
        GPT_CURRENT_QUOTA_CACHE_FRESH_MS
    };
    let can_use_fresh_cached = !sync_current
        && cached_quota
            .as_ref()
            .map(|(_, age_ms)| *age_ms <= fresh_cache_max_age_ms)
            .unwrap_or(false);
    if can_use_fresh_cached {
        return (
            cached_quota
                .as_ref()
                .map(|(quota, _)| current_status_from_quota(store, quota)),
            None,
        );
    }
    if push_running && !sync_current {
        if let Some((quota, _)) = cached_quota.as_ref() {
            return (Some(current_status_from_quota(store, quota)), None);
        }
    }
    if !sync_current && opencode_quota_runtime_error_is_hot(now_ms, CURRENT_QUOTA_ERROR_COOLDOWN_MS)
    {
        return (
            None,
            latest_opencode_quota_runtime_error(now_ms, CURRENT_QUOTA_ERROR_COOLDOWN_MS),
        );
    }

    let process_count = get_opencode_process_count_internal();
    if process_count == 0 {
        return (None, None);
    }
    ensure_opencode_rate_limit_push_worker();

    let quota_timeout_seconds = if sync_current {
        APP_SERVER_TIMEOUT_DEFAULT_SECONDS
    } else {
        APP_SERVER_OPENCODE_POLL_TIMEOUT_SECONDS
    };
    let quota_result = fetch_quota_from_live_opencode_auth_with_timeout(quota_timeout_seconds);

    match quota_result {
        Ok(quota) => {
            update_opencode_quota_runtime_cache(&quota, now_ms);
            sync_live_quota_to_store(
                store,
                &quota,
                now_ms,
                AutoSwitchMode::OpenCode,
                sync_current,
            );
            (Some(current_status_from_quota(store, &quota)), None)
        }
        Err(err) => {
            match fetch_quota_from_opencode_profile_snapshot_with_timeout(
                store,
                live_workspace_id.as_deref(),
                quota_timeout_seconds,
            ) {
                Ok(quota) => {
                    update_opencode_quota_runtime_cache(&quota, now_ms);
                    sync_live_quota_to_store(
                        store,
                        &quota,
                        now_ms,
                        AutoSwitchMode::OpenCode,
                        sync_current,
                    );
                    (Some(current_status_from_quota(store, &quota)), None)
                }
                Err(_) => {
                    mark_opencode_quota_runtime_error(&err, now_ms);
                    (None, Some(err))
                }
            }
        }
    }
}

fn load_dashboard_internal_for_mode(
    sync_current: bool,
    mode: Option<AutoSwitchMode>,
) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let now_ms = now_ts_ms();
    let need_opencode_current = true;
    let mut current = None;
    let (opencode_current, opencode_error) = if need_opencode_current {
        load_live_opencode_current_status(&mut store, sync_current, now_ms)
    } else {
        (None, None)
    };
    let focus_mode = mode.unwrap_or(AutoSwitchMode::Gpt);
    let mut current_error = None;
    let mut current_error_mode = None;
    if matches!(focus_mode, AutoSwitchMode::OpenCode) {
        if opencode_current.is_none() {
            current_error = opencode_error;
            if current_error.is_some() {
                current_error_mode = Some("opencode".to_string());
            }
        }
    }
    let codex_home_opt = codex_home().ok();
    if let Some(codex_home) = codex_home_opt.as_ref() {
        ensure_gpt_rate_limit_push_worker(codex_home);
    }
    let cached_quota = cached_current_quota_snapshot(now_ms).and_then(|(quota, age_ms)| {
        if let Some(codex_home) = codex_home_opt.as_ref() {
            if cached_quota_matches_live_workspace(codex_home, &quota) {
                Some((quota, age_ms))
            } else {
                None
            }
        } else {
            Some((quota, age_ms))
        }
    });

    let can_use_fresh_cached = !sync_current
        && cached_quota
            .as_ref()
            .map(|(_, age_ms)| *age_ms <= CURRENT_QUOTA_CACHE_FRESH_MS)
            .unwrap_or(false);
    if can_use_fresh_cached {
        if let Some((quota, _)) = cached_quota.as_ref() {
            current = Some(current_status_from_quota(&store, quota));
            return Ok(build_dashboard(
                &store,
                current,
                opencode_current,
                current_error,
                current_error_mode,
            ));
        }
    }
    if sync_current || !current_quota_runtime_error_is_hot(now_ms, CURRENT_QUOTA_ERROR_COOLDOWN_MS)
    {
        if let Some(codex_home) = codex_home_opt.as_ref() {
            let quota_timeout_seconds = if sync_current {
                APP_SERVER_TIMEOUT_DEFAULT_SECONDS
            } else {
                APP_SERVER_TIMEOUT_POLL_SECONDS
            };
            match fetch_quota_from_codex_home_with_timeout(codex_home, false, quota_timeout_seconds)
            {
                Ok(quota) => {
                    update_current_quota_runtime_cache(&quota, now_ms);
                    sync_live_quota_to_store(
                        &mut store,
                        &quota,
                        now_ms,
                        AutoSwitchMode::Gpt,
                        sync_current,
                    );
                    current = Some(current_status_from_quota(&store, &quota));
                    return Ok(build_dashboard(
                        &store,
                        current,
                        opencode_current,
                        current_error,
                        current_error_mode,
                    ));
                }
                Err(err) => {
                    mark_current_quota_runtime_error(&err, now_ms);
                }
            }
        }
    }
    if let Some(quota) = quota_from_rollout_snapshot(&store) {
        update_current_quota_runtime_cache(&quota, now_ms);
        sync_live_quota_to_store(
            &mut store,
            &quota,
            now_ms,
            AutoSwitchMode::Gpt,
            sync_current,
        );
        current = Some(current_status_from_quota(&store, &quota));
        return Ok(build_dashboard(
            &store,
            current,
            opencode_current,
            current_error,
            current_error_mode,
        ));
    }
    if let Some(quota) = quota_from_active_profile_record(&store) {
        current = Some(current_status_from_quota(&store, &quota));
        return Ok(build_dashboard(
            &store,
            current,
            opencode_current,
            current_error,
            current_error_mode,
        ));
    }
    if let Some((quota, _)) = cached_quota {
        current = Some(current_status_from_quota(&store, &quota));
        return Ok(build_dashboard(
            &store,
            current,
            opencode_current,
            current_error,
            current_error_mode,
        ));
    }
    Ok(build_dashboard(
        &store,
        current,
        opencode_current,
        current_error,
        current_error_mode,
    ))
}

fn load_dashboard_internal(sync_current: bool) -> CmdResult<DashboardData> {
    load_dashboard_internal_for_mode(sync_current, None)
}

fn save_current_profile_internal(profile_name: &str) -> CmdResult<DashboardData> {
    let profile_name = profile_name.trim();
    if profile_name.is_empty() {
        return Err("账号名称不能为空。".to_string());
    }
    let mut store = load_store()?;
    let quota = fetch_quota_from_codex_home(&codex_home()?, false)?;
    let matched = find_profile_name_by_identity_prefer_existing(
        &store,
        quota.workspace_id.as_deref(),
        quota.email.as_deref(),
    );

    let final_name = matched.unwrap_or_else(|| profile_name.to_string());
    let target = profile_snapshot_dir(&final_name)?;
    copy_current_account_snapshot(&target)?;
    let existing = store.profiles.get(&final_name).and_then(Value::as_object);
    let record = build_profile_record(&final_name, &target, &quota, existing);
    store.profiles.insert(final_name.clone(), record);
    if store.active_profile.is_none() {
        store.active_profile = Some(final_name);
    }
    save_store(&store)?;
    load_dashboard_internal(false)
}

fn finalize_login_target(
    store: &mut StoreData,
    target: &Path,
    alias_opt: &Option<String>,
) -> CmdResult<String> {
    let auth_file = target.join(AUTH_FILE_NAME);
    if !auth_file.exists() {
        return Err("登录已完成，但未检测到登录态文件 auth.json，请重试。".to_string());
    }
    if !target.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME).exists() {
        let _ = ensure_opencode_snapshot_from_codex_auth(target);
    }

    let login_result_message = match fetch_quota_from_codex_home(target, false) {
        Ok(quota) => {
            let existing = find_profile_name_by_identity_prefer_existing(
                store,
                quota.workspace_id.as_deref(),
                quota.email.as_deref(),
            );
            let is_overwrite_existing = existing.is_some();

            let (final_name, final_dir) = if let Some(name) = existing {
                let current_record = store
                    .profiles
                    .get(&name)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let final_dir = record_snapshot_dir(&name, &current_record)?;
                fs::create_dir_all(&final_dir).map_err(|e| format!("创建账号目录失败: {e}"))?;
                fs::copy(&auth_file, final_dir.join(AUTH_FILE_NAME))
                    .map_err(|e| format!("复制登录 auth.json 失败: {e}"))?;
                for optional in [
                    CAP_SID_FILE_NAME,
                    CONFIG_FILE_NAME,
                    OPENCODE_OPENAI_SNAPSHOT_FILE_NAME,
                ] {
                    let src = target.join(optional);
                    if src.exists() {
                        let _ = fs::copy(&src, final_dir.join(optional));
                    }
                }
                safe_remove_dir(target);
                (name, final_dir)
            } else {
                let base = build_auto_profile_base(&quota);
                let final_name = next_auto_profile_name(store, Some(&base));
                let final_dir = profile_snapshot_dir(&final_name)?;
                if fs::rename(target, &final_dir).is_err() {
                    fs::create_dir_all(&final_dir).map_err(|e| format!("创建账号目录失败: {e}"))?;
                    fs::copy(&auth_file, final_dir.join(AUTH_FILE_NAME))
                        .map_err(|e| format!("复制登录 auth.json 失败: {e}"))?;
                    for optional in [
                        CAP_SID_FILE_NAME,
                        CONFIG_FILE_NAME,
                        OPENCODE_OPENAI_SNAPSHOT_FILE_NAME,
                    ] {
                        let src = target.join(optional);
                        if src.exists() {
                            let _ = fs::copy(&src, final_dir.join(optional));
                        }
                    }
                    safe_remove_dir(target);
                }
                (final_name, final_dir)
            };

            let existing_record = store.profiles.get(&final_name).and_then(Value::as_object);
            let mut record = build_profile_record(&final_name, &final_dir, &quota, existing_record)
                .as_object()
                .cloned()
                .unwrap_or_default();
            if final_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME).exists() {
                record.insert(
                    "support".to_string(),
                    profile_support_json(ProfileSupportView {
                        gpt: true,
                        opencode: true,
                    }),
                );
            }
            if let Some(alias) = alias_opt.as_ref() {
                record.insert("workspace_alias".to_string(), Value::String(alias.clone()));
            }
            let replaced_old = store
                .profiles
                .insert(final_name.clone(), Value::Object(record))
                .is_some();
            if store.active_profile.is_none() {
                store.active_profile = Some(final_name);
            }
            if replaced_old || is_overwrite_existing {
                "检测到相同账号身份，已覆盖旧记录。".to_string()
            } else {
                "新增账号成功。".to_string()
            }
        }
        Err(err) => {
            let base = format!("new-account-{}", Local::now().format("%H%M%S"));
            let final_name = next_auto_profile_name(store, Some(&base));
            let final_dir = profile_snapshot_dir(&final_name)?;
            if fs::rename(target, &final_dir).is_err() {
                fs::create_dir_all(&final_dir).map_err(|e| format!("创建账号目录失败: {e}"))?;
                fs::copy(&auth_file, final_dir.join(AUTH_FILE_NAME))
                    .map_err(|e| format!("复制登录 auth.json 失败: {e}"))?;
                let openai_snapshot = target.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME);
                if openai_snapshot.exists() {
                    let _ = fs::copy(
                        &openai_snapshot,
                        final_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME),
                    );
                }
                safe_remove_dir(target);
            }
            let (workspace_name, workspace_id) =
                read_workspace_info_from_auth_file(&final_dir.join(AUTH_FILE_NAME));
            let support = if final_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME).exists() {
                profile_support_json(ProfileSupportView {
                    gpt: true,
                    opencode: true,
                })
            } else {
                profile_support_json(default_profile_support())
            };
            let record = json!({
                "name": final_name,
                "snapshot_dir": final_dir.to_string_lossy().to_string(),
                "email": Value::Null,
                "workspace_name": workspace_name,
                "workspace_id": workspace_id,
                "workspace_alias": alias_opt.clone().map(Value::String).unwrap_or(Value::Null),
                "support": support,
                "plan_type": Value::Null,
                "quota": {"five_hour": Value::Null, "one_week": Value::Null},
                "last_checked_at": now_iso(),
                "last_error": format!("登录完成，但读取账号/额度失败：{err}"),
                "updated_at": now_iso()
            });
            store.profiles.insert(final_name.clone(), record);
            if store.active_profile.is_none() {
                store.active_profile = Some(final_name.clone());
            }
            format!("登录完成，但读取账号信息失败，已按新账号保存：{final_name}")
        }
    };

    Ok(login_result_message)
}

fn add_account_by_login_internal(
    app: &tauri::AppHandle,
    workspace_alias: Option<String>,
) -> CmdResult<DashboardData> {
    emit_login_progress(app, "opening", "正在打开内嵌登录窗口...");
    let alias = workspace_alias.unwrap_or_default();
    let alias = alias.trim().to_string();
    let mut alias_opt = if alias.is_empty() { None } else { Some(alias) };

    let mut store = load_store()?;
    let target = make_pending_login_dir()?;
    let auth_file = target.join(AUTH_FILE_NAME);
    if let Err(err) = ensure_login_callback_port_ready() {
        safe_remove_dir(&target);
        return Err(err);
    }
    let mut login_session = match start_browser_oauth_login_session() {
        Ok(v) => v,
        Err(err) => {
            safe_remove_dir(&target);
            return Err(format!("启动内嵌登录失败：{err}"));
        }
    };
    let login_window_label = format!("login-{}", Local::now().format("%Y%m%d_%H%M%S%3f"));
    let login_window =
        match open_embedded_login_window(app, &login_window_label, &login_session.auth_url) {
            Ok(v) => v,
            Err(err) => {
                shutdown_browser_oauth_login_session(&mut login_session);
                safe_remove_dir(&target);
                return Err(err);
            }
        };
    if login_session.callback_port != LOGIN_CALLBACK_PORT {
        emit_login_progress(
            app,
            "callback_port_switched",
            &format!(
                "1455 已被占用，已切换到内嵌回调端口 {} 继续登录。",
                login_session.callback_port
            ),
        );
    }
    emit_login_progress(app, "awaiting_login", "请在内嵌窗口完成登录...");

    let deadline = Instant::now() + Duration::from_secs(CHATGPT_BROWSER_OAUTH_TIMEOUT_SECS);
    let mut login_error: Option<String> = None;
    let mut completed = false;

    while Instant::now() < deadline {
        if let Some(window) = app.get_webview_window(&login_window.label) {
            let _ = window.eval(WORKSPACE_CAPTURE_SCRIPT);
            let _ = window.eval(LOGIN_ERROR_CAPTURE_SCRIPT);
            if let Ok(title) = window.title() {
                if let Some(text) = title.strip_prefix(WORKSPACE_CAPTURE_TITLE_PREFIX) {
                    let clean = text.trim().replace('\n', " ");
                    if !clean.is_empty() {
                        if let Ok(mut guard) = login_window.selected_workspace_name.lock() {
                            *guard = Some(clean);
                        }
                    }
                }
                if let Some(text) = title.strip_prefix(LOGIN_ERROR_CAPTURE_TITLE_PREFIX) {
                    let detail = text.trim();
                    let detail = if detail.is_empty() {
                        "unknown_error".to_string()
                    } else {
                        detail.to_string()
                    };
                    login_error = Some(format!("内嵌登录验证失败：{detail}"));
                    break;
                }
            }
        } else {
            login_error = Some("已取消登录（登录窗口已关闭）。".to_string());
            break;
        }

        match login_session.rx.recv_timeout(Duration::from_millis(350)) {
            Ok(result) => match result {
                Ok(tokens) => {
                    emit_login_progress(app, "token_exchange", "授权成功，正在保存登录态...");
                    if let Err(err) = persist_chatgpt_tokens_to_auth_file(&target, &tokens) {
                        login_error = Some(err);
                        break;
                    }
                    if let Err(err) = write_opencode_openai_snapshot(&target, &tokens) {
                        login_error = Some(err);
                        break;
                    }
                    completed = true;
                    break;
                }
                Err(err) => {
                    login_error = Some(err);
                    break;
                }
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if auth_file.exists() {
                    completed = true;
                } else {
                    login_error = Some("登录回调连接中断。".to_string());
                }
                break;
            }
        }
    }

    if completed && !auth_file.exists() {
        let grace_deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < grace_deadline && !auth_file.exists() {
            thread::sleep(Duration::from_millis(200));
        }
    }

    close_login_window(app, &login_window.label);
    shutdown_browser_oauth_login_session(&mut login_session);

    if !completed {
        safe_remove_dir(&target);
        return Err(
            login_error.unwrap_or_else(|| "15 分钟内未检测到登录完成事件，请重试。".to_string())
        );
    }
    if !auth_file.exists() {
        safe_remove_dir(&target);
        return Err("登录已完成，但未检测到登录态文件 auth.json，请重试。".to_string());
    }
    if !target.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME).exists() {
        let _ = ensure_opencode_snapshot_from_codex_auth(&target);
    }
    if alias_opt.is_none() {
        alias_opt = login_window
            .selected_workspace_name
            .lock()
            .ok()
            .and_then(|v| v.clone())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
    }

    emit_login_progress(app, "fetching_profile", "登录完成，正在拉取账号信息...");
    let login_result_message = finalize_login_target(&mut store, &target, &alias_opt)?;

    save_store(&store)?;
    emit_login_progress(app, "done", &login_result_message);
    load_dashboard_internal(true)
}

fn apply_profile_internal(name: &str) -> CmdResult<DashboardData> {
    apply_profile_internal_for_mode(name, None)
}

fn apply_profile_internal_for_mode(name: &str, mode: Option<&str>) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    let record = store
        .profiles
        .get(profile_name)
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| format!("账号不存在：{profile_name}"))?;
    let source = record_snapshot_dir(profile_name, &record)?;
    match mode.unwrap_or("both").trim().to_lowercase().as_str() {
        "both" => {
            let _backup_name = apply_profile_snapshot(&source)?;
            store.active_profile = Some(profile_name.to_string());
            save_store(&store)?;
            load_dashboard_internal(true)
        }
        "gpt" => {
            let _backup_name = apply_profile_snapshot_codex_only(&source)?;
            store.active_profile = Some(profile_name.to_string());
            save_store(&store)?;
            load_dashboard_internal(true)
        }
        "opencode" => {
            let _backup_name = apply_profile_snapshot_opencode_only(&source)?;
            // OpenCode 独立切号不应影响 Codex 当前账号指针。
            load_dashboard_internal_for_mode(true, Some(AutoSwitchMode::OpenCode))
        }
        other => Err(format!(
            "不支持的切号模式: {other}。可选值: gpt / opencode / both"
        )),
    }
}

fn active_profile_workspace_id_internal(store: &StoreData) -> Option<String> {
    let active_name = store.active_profile.as_ref()?;
    let record = store.profiles.get(active_name).and_then(Value::as_object)?;
    read_workspace_id_from_record_or_auth(active_name, record)
}

fn live_workspace_id_internal() -> Option<String> {
    let home = codex_home().ok()?;
    let (_, wid) = read_workspace_info_from_auth_file(&home.join(AUTH_FILE_NAME));
    wid
}

fn ensure_live_auth_matches_active_profile_internal() -> CmdResult<Option<String>> {
    let store = load_store()?;
    let Some(active_name) = store.active_profile.as_ref() else {
        return Ok(None);
    };
    let Some(expected_workspace_id) = active_profile_workspace_id_internal(&store) else {
        return Ok(None);
    };
    let current_workspace_id = live_workspace_id_internal();
    if current_workspace_id.as_deref() == Some(expected_workspace_id.as_str()) {
        return Ok(None);
    }

    let record = store
        .profiles
        .get(active_name)
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| format!("账号不存在：{active_name}"))?;
    let source = record_snapshot_dir(active_name, &record)?;
    let _ = apply_profile_snapshot(&source)?;

    let after_workspace_id = live_workspace_id_internal();
    if after_workspace_id.as_deref() == Some(expected_workspace_id.as_str()) {
        Ok(Some(
            "检测到本地 auth 未切到目标账号，已自动重新写入账号快照。".to_string(),
        ))
    } else {
        Err(format!(
            "本地 auth 与目标账号不一致，重写后仍不一致。目标={} 当前={}",
            expected_workspace_id,
            after_workspace_id.unwrap_or_else(|| "-".to_string())
        ))
    }
}

fn set_workspace_alias_internal(name: &str, alias: Option<String>) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    let record_value = store
        .profiles
        .get(profile_name)
        .cloned()
        .ok_or_else(|| format!("账号不存在：{profile_name}"))?;
    let mut record = record_value.as_object().cloned().unwrap_or_default();
    if let Some(v) = alias.map(|v| v.trim().to_string()) {
        if v.is_empty() {
            record.remove("workspace_alias");
        } else {
            record.insert("workspace_alias".to_string(), Value::String(v));
        }
    } else {
        record.remove("workspace_alias");
    }
    record.insert("updated_at".to_string(), Value::String(now_iso()));
    store
        .profiles
        .insert(profile_name.to_string(), Value::Object(record));
    save_store(&store)?;
    load_dashboard_internal(true)
}

fn set_profile_support_internal(name: &str, gpt: bool, opencode: bool) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    if !gpt && !opencode {
        return Err("支持标签至少选择一个：GPT 或 OpenCode。".to_string());
    }
    let record_value = store
        .profiles
        .get(profile_name)
        .cloned()
        .ok_or_else(|| format!("账号不存在：{profile_name}"))?;
    let mut record = record_value.as_object().cloned().unwrap_or_default();
    let support = ProfileSupportView { gpt, opencode };
    record.insert("support".to_string(), profile_support_json(support));
    record.insert("updated_at".to_string(), Value::String(now_iso()));
    store
        .profiles
        .insert(profile_name.to_string(), Value::Object(record));
    save_store(&store)?;
    load_dashboard_internal(true)
}

fn refresh_profile_quota_internal(
    name: &str,
    refresh_token: bool,
    mode: Option<AutoSwitchMode>,
) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    if !store.profiles.contains_key(profile_name) {
        return Err(format!("账号不存在：{profile_name}"));
    }
    let _ = refresh_one_profile_quota(&mut store, profile_name, refresh_token);
    save_store(&store)?;
    load_dashboard_internal_for_mode(true, mode)
}

fn refresh_profiles_quota_internal(
    names: &[String],
    refresh_token: bool,
    mode: Option<AutoSwitchMode>,
) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let mut deduped: HashSet<String> = HashSet::new();
    for raw_name in names {
        let profile_name = raw_name.trim();
        if profile_name.is_empty() {
            continue;
        }
        if !deduped.insert(profile_name.to_string()) {
            continue;
        }
        if !store.profiles.contains_key(profile_name) {
            continue;
        }
        let _ = refresh_one_profile_quota(&mut store, profile_name, refresh_token);
    }
    save_store(&store)?;
    load_dashboard_internal_for_mode(true, mode)
}

fn refresh_all_quota_internal(
    refresh_token: bool,
    mode: Option<AutoSwitchMode>,
) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let names = list_profile_names(&store);
    for name in names {
        let _ = refresh_one_profile_quota(&mut store, &name, refresh_token);
    }
    save_store(&store)?;
    load_dashboard_internal_for_mode(true, mode)
}

fn keepalive_all_internal() -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let names = list_profile_names(&store);
    for name in names {
        let _ = refresh_one_profile_quota(&mut store, &name, true);
    }
    store.last_keepalive_at = Some(Local::now().timestamp());
    save_store(&store)?;
    load_dashboard_internal(true)
}

fn delete_profile_internal(name: &str) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    let Some(record) = store
        .profiles
        .get(profile_name)
        .and_then(Value::as_object)
        .cloned()
    else {
        return Err(format!("账号不存在：{profile_name}"));
    };

    if let Ok(snapshot_dir) = record_snapshot_dir(profile_name, &record) {
        safe_remove_dir(&snapshot_dir);
    }
    store.profiles.remove(profile_name);
    if store.active_profile.as_deref() == Some(profile_name) {
        store.active_profile = None;
    }
    save_store(&store)?;
    load_dashboard_internal(false)
}

fn reorder_profiles_internal(names: Vec<String>) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let mut ordered: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !store.profiles.contains_key(trimmed) {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            ordered.push(trimmed.to_string());
        }
    }

    store.profile_order = ordered;
    normalize_profile_order(&mut store);
    save_store(&store)?;
    load_dashboard_internal(false)
}

