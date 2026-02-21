use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub(super) type CmdResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowQuota {
    pub(super) window_minutes: Option<i64>,
    pub(super) used_percent: Option<i64>,
    pub(super) remaining_percent: Option<i64>,
    pub(super) resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct AccountQuota {
    pub(super) email: Option<String>,
    pub(super) workspace_name: Option<String>,
    pub(super) workspace_id: Option<String>,
    pub(super) plan_type: Option<String>,
    pub(super) five_hour: Option<WindowQuota>,
    pub(super) one_week: Option<WindowQuota>,
}

#[derive(Debug, Clone, Default)]
pub(super) struct CurrentQuotaRuntimeCache {
    pub(super) quota: Option<AccountQuota>,
    pub(super) fetched_at_ms: i64,
    pub(super) last_error: Option<String>,
    pub(super) last_error_at_ms: i64,
}

#[derive(Debug, Clone, Default)]
pub(super) struct GptRateLimitPushState {
    pub(super) running: bool,
    pub(super) codex_home: Option<PathBuf>,
    pub(super) last_error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(super) struct OpencodeRateLimitPushState {
    pub(super) running: bool,
    pub(super) last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LoginProgressEvent {
    pub(super) phase: String,
    pub(super) message: String,
}

#[derive(Debug, Clone)]
pub(super) struct TokenHealth {
    pub(super) exists: bool,
    pub(super) has_refresh: bool,
    pub(super) access_exp: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TriggerReason {
    Soft,
    Hard,
}

impl TriggerReason {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            TriggerReason::Soft => "soft",
            TriggerReason::Hard => "hard",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum StaleRecoverReason {
    RolloutMissing,
    ThreadNotFound,
    RuntimeUnavailable,
    TurnMetadataTimeout,
}

impl StaleRecoverReason {
    pub(super) fn message(self) -> &'static str {
        match self {
            StaleRecoverReason::RolloutMissing => "会话索引失效（no rollout found）",
            StaleRecoverReason::ThreadNotFound => "当前会话线程已失效（thread not found）",
            StaleRecoverReason::RuntimeUnavailable => {
                "Codex 运行时不可用（process is not available）"
            }
            StaleRecoverReason::TurnMetadataTimeout => {
                "Codex 元数据构建超时（turn_metadata timeout）"
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AutoSwitchMode {
    Gpt,
    OpenCode,
}
