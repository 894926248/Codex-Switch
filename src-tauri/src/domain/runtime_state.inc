#[derive(Debug, Default)]
struct AutoSwitchRuntime {
    session: SessionTailState,
    codex_log: CodexLogTailState,
    opencode_log: OpenCodeLogTailState,
    monitor_mode: Option<AutoSwitchMode>,
    pending_reason: Option<TriggerReason>,
    last_observed_hard_trigger_seq: u64,
    last_observed_thread_not_found_seq: u64,
    last_observed_rollout_missing_seq: u64,
    last_observed_runtime_unavailable_seq: u64,
    last_observed_turn_metadata_timeout_seq: u64,
    last_observed_opencode_session_error_seq: u64,
    last_runtime_unavailable_recover_restart_seq: Option<u64>,
    last_thread_recover_user_seq: u64,
    last_stale_recover_reason: Option<StaleRecoverReason>,
    last_stale_recover_at_ms: i64,
    stale_recover_repeat_count: u32,
    last_new_chat_reset_at_ms: i64,
    last_new_chat_reset_user_seq: u64,
    switch_cooldown_until_ms: i64,
    no_candidate_until_ms: i64,
    thread_recover_cooldown_until_ms: i64,
    state_index_purge_cooldown_until_ms: i64,
    last_switch_applied_at_ms: i64,
    last_live_quota_sync_at_ms: i64,
}

#[derive(Debug, Default)]
struct AutoSwitchRuntimeState {
    inner: Arc<Mutex<AutoSwitchRuntime>>,
}
