use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::{Local, TimeZone, Utc};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rand::{thread_rng, Rng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering as CmpOrdering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tar::{Archive, Builder, Header};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use toml_edit::{
    Array as TomlEditArray, DocumentMut as TomlEditDocument, InlineTable as TomlEditInlineTable,
    Item as TomlEditItem, Table as TomlEditTable, Value as TomlEditValue,
};

#[path = "../constants.rs"]
mod constants;
#[path = "../commands/mod.rs"]
mod commands;
#[path = "../models.rs"]
mod models;
#[path = "../paths.rs"]
mod paths;
#[path = "../util/mod.rs"]
mod util;

use commands::*;
use constants::*;
use skills::*;
use models::*;
use paths::*;
use util::command_no_window;

static CURRENT_QUOTA_RUNTIME_CACHE: OnceLock<Mutex<CurrentQuotaRuntimeCache>> = OnceLock::new();
static OPENCODE_CURRENT_QUOTA_RUNTIME_CACHE: OnceLock<Mutex<CurrentQuotaRuntimeCache>> =
    OnceLock::new();
static OPENCODE_QUOTA_BRIDGE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static APP_RUNTIME_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
static LIVE_QUOTA_STORE_SYNC_STATE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
static GPT_RATE_LIMIT_PUSH_STATE: OnceLock<Mutex<GptRateLimitPushState>> = OnceLock::new();
static OPENCODE_RATE_LIMIT_PUSH_STATE: OnceLock<Mutex<OpencodeRateLimitPushState>> =
    OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoreData {
    #[serde(default)]
    active_profile: Option<String>,
    #[serde(default)]
    profiles: BTreeMap<String, Value>,
    #[serde(default)]
    profile_order: Vec<String>,
    #[serde(default)]
    last_keepalive_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentStatusView {
    email: Option<String>,
    workspace_name: Option<String>,
    workspace_id: Option<String>,
    display_workspace: String,
    five_hour_remaining_percent: Option<i64>,
    five_hour_resets_at: Option<i64>,
    one_week_remaining_percent: Option<i64>,
    one_week_resets_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSupportView {
    gpt: bool,
    opencode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileView {
    name: String,
    email: Option<String>,
    workspace_name: Option<String>,
    workspace_id: Option<String>,
    workspace_alias: Option<String>,
    support: ProfileSupportView,
    display_workspace: String,
    five_hour_remaining_percent: Option<i64>,
    five_hour_resets_at: Option<i64>,
    one_week_remaining_percent: Option<i64>,
    one_week_resets_at: Option<i64>,
    last_checked_at: Option<String>,
    last_error: Option<String>,
    status: String,
    is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardData {
    app_name: String,
    active_profile: Option<String>,
    current: Option<CurrentStatusView>,
    opencode_current: Option<CurrentStatusView>,
    current_error: Option<String>,
    current_error_mode: Option<String>,
    last_keepalive_at: Option<i64>,
    profiles: Vec<ProfileView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoSwitchTickResult {
    action: String,
    message: Option<String>,
    switched_to: Option<String>,
    reload_triggered: bool,
    pending_reason: Option<String>,
    dashboard: Option<DashboardData>,
}

impl AutoSwitchTickResult {
    fn new(action: &str) -> Self {
        Self {
            action: action.to_string(),
            message: None,
            switched_to: None,
            reload_triggered: false,
            pending_reason: None,
            dashboard: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VsCodeStatusView {
    running: bool,
    process_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexExtensionInfoView {
    current_version: Option<String>,
    all_versions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeMonitorStatusView {
    auth_ready: bool,
    running: bool,
    process_count: u64,
    log_ready: bool,
    log_recent: bool,
    last_log_age_ms: Option<i64>,
    activity_recent: bool,
    last_activity_age_ms: Option<i64>,
    activity_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillEntryView {
    id: String,
    directory: String,
    name: String,
    description: String,
    claude_enabled: bool,
    codex_enabled: bool,
    gemini_enabled: bool,
    opencode_enabled: bool,
    codex_available: bool,
    opencode_available: bool,
    source: String,
    locations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillsCatalogView {
    total: usize,
    claude_enabled_count: usize,
    codex_enabled_count: usize,
    gemini_enabled_count: usize,
    opencode_enabled_count: usize,
    skills: Vec<SkillEntryView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverSkillRepoView {
    owner: String,
    name: String,
    branch: String,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverSkillEntryView {
    id: String,
    name: String,
    description: String,
    directory: String,
    repo_directory: String,
    repo_owner: String,
    repo_name: String,
    repo_branch: String,
    readme_url: String,
    installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillsDiscoveryView {
    total: usize,
    repos: Vec<DiscoverSkillRepoView>,
    skills: Vec<DiscoverSkillEntryView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillRepoManageItemView {
    owner: String,
    name: String,
    branch: String,
    enabled: bool,
    skill_count: Option<usize>,
    repo_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillRepoManageView {
    repos: Vec<SkillRepoManageItemView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerView {
    id: String,
    name: String,
    description: String,
    doc_url: Option<String>,
    endpoint_url: Option<String>,
    source: String,
    kind: String,
    claude_enabled: bool,
    codex_enabled: bool,
    gemini_enabled: bool,
    opencode_enabled: bool,
    codex_available: bool,
    opencode_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpManageView {
    total: usize,
    claude_enabled_count: usize,
    codex_enabled_count: usize,
    gemini_enabled_count: usize,
    opencode_enabled_count: usize,
    servers: Vec<McpServerView>,
}

#[derive(Debug, Clone, Default)]
struct SkillRepoCacheMeta {
    head_sha: Option<String>,
    skill_count: usize,
    checked_at: i64,
}

#[derive(Debug, Clone, Default)]
struct SkillScanEntry {
    id: String,
    directory: String,
    name: String,
    description: String,
    ssot_source: bool,
    codex_source: bool,
    opencode_source: bool,
    opencode_legacy_source: bool,
    locations: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct UnifiedMcpEntry {
    id: String,
    codex_spec: Option<Value>,
    opencode_spec: Option<Value>,
}

#[derive(Debug, Clone)]
struct CcSwitchSkillDbRow {
    id: String,
    directory: String,
    name: String,
    description: Option<String>,
    repo_owner: Option<String>,
    repo_name: Option<String>,
    repo_branch: Option<String>,
    readme_url: Option<String>,
    enabled_claude: bool,
    enabled_codex: bool,
    enabled_gemini: bool,
    enabled_opencode: bool,
    installed_at: i64,
}

#[derive(Debug, Clone, Copy)]
struct CcSwitchSkillTargetFlags {
    claude_enabled: bool,
    codex_enabled: bool,
    gemini_enabled: bool,
    opencode_enabled: bool,
}

#[derive(Debug, Clone, Copy)]
struct CcSwitchMcpAppFlags {
    claude_enabled: bool,
    gemini_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format: String,
    schema_version: u32,
    created_at: String,
    file_count: usize,
    estimated_total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupExportResult {
    archive_path: String,
    file_count: usize,
    estimated_total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupImportResult {
    source_file_name: String,
    safeguard_archive_path: String,
    restored_count: usize,
    dashboard: DashboardData,
}

#[derive(Debug, Default)]
struct ParsedBackupPayload {
    switcher_entries: Vec<(PathBuf, Vec<u8>)>,
    codex_entries: Vec<(PathBuf, Vec<u8>)>,
    has_switcher_payload: bool,
    has_profiles_file_payload: bool,
}

#[derive(Debug, Clone, Default)]
struct SessionQuotaSnapshot {
    five_hour_remaining_percent: Option<i64>,
    one_week_remaining_percent: Option<i64>,
    five_hour_resets_at: Option<i64>,
    one_week_resets_at: Option<i64>,
    updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutoSwitchSignature {
    event_seq: u64,
    user_seq: u64,
    open_turn_count: usize,
}

#[derive(Debug, Clone)]
struct SessionTailState {
    current_file: Option<PathBuf>,
    offset: u64,
    open_turns: HashSet<String>,
    event_seq: u64,
    user_seq: u64,
    quota: SessionQuotaSnapshot,
    hard_trigger_seq: u64,
    last_hard_trigger_reason: Option<String>,
    last_scan_at_ms: i64,
}

impl Default for SessionTailState {
    fn default() -> Self {
        Self {
            current_file: None,
            offset: 0,
            open_turns: HashSet::new(),
            event_seq: 0,
            user_seq: 0,
            quota: SessionQuotaSnapshot::default(),
            hard_trigger_seq: 0,
            last_hard_trigger_reason: None,
            last_scan_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct CodexLogTailState {
    current_file: Option<PathBuf>,
    offset: u64,
    thread_not_found_seq: u64,
    rollout_missing_seq: u64,
    runtime_unavailable_seq: u64,
    turn_metadata_timeout_seq: u64,
    runtime_restart_seq: u64,
    last_scan_at_ms: i64,
}

impl Default for CodexLogTailState {
    fn default() -> Self {
        Self {
            current_file: None,
            offset: 0,
            thread_not_found_seq: 0,
            rollout_missing_seq: 0,
            runtime_unavailable_seq: 0,
            turn_metadata_timeout_seq: 0,
            runtime_restart_seq: 0,
            last_scan_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct OpenCodeLogTailState {
    current_file: Option<PathBuf>,
    offset: u64,
    session_error_seq: u64,
    last_scan_at_ms: i64,
}

impl Default for OpenCodeLogTailState {
    fn default() -> Self {
        Self {
            current_file: None,
            offset: 0,
            session_error_seq: 0,
            last_scan_at_ms: 0,
        }
    }
}

include!("runtime_state.inc");

fn emit_login_progress(app: &tauri::AppHandle, phase: &str, message: &str) {
    let payload = LoginProgressEvent {
        phase: phase.to_string(),
        message: message.to_string(),
    };
    let _ = app.emit("codex-switch://login-progress", payload);
}

include!("runtime_ccswitch_tables.inc");

include!("runtime_ccswitch_db_access.inc");

include!("runtime_ccswitch_repo_cache.inc");

include!("runtime_ccswitch_skills.inc");

include!("runtime_mcp.inc");

include!("runtime_hook_and_paths.inc");

include!("runtime_ops.inc");

include!("runtime_dashboard_profiles.inc");

include!("runtime_editor_ops.inc");

include!("runtime_autoswitch.inc");
