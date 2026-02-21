use std::env;
use std::path::PathBuf;

use super::constants::{
    AGENTS_HOME_DIR, AUTH_FILE_NAME, BACKUPS_DIR_NAME, CC_SWITCH_DB_FILE_NAME, CC_SWITCH_HOME_DIR,
    CODEX_SWITCH_HOOK_NEWCHAT_SIGNAL_FILE_NAME, CODEX_SWITCH_HOOK_SIGNAL_FILE_NAME,
    OPENCODE_CONFIG_FILE_NAME, PROFILES_DIR_NAME, PROFILES_FILE_NAME, SKILLS_DIR_NAME,
    SWITCHER_HOME_DIR,
};
use super::models::CmdResult;

pub(super) fn home_dir() -> CmdResult<PathBuf> {
    dirs::home_dir().ok_or_else(|| "无法定位用户目录。".to_string())
}

pub(super) fn codex_home() -> CmdResult<PathBuf> {
    Ok(home_dir()?.join(".codex"))
}

pub(super) fn switcher_home() -> CmdResult<PathBuf> {
    Ok(home_dir()?.join(SWITCHER_HOME_DIR))
}

pub(super) fn opencode_data_dir() -> CmdResult<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();

        if let Some(value) = env::var_os("OPENCODE_DATA_DIR") {
            let path = PathBuf::from(value);
            if !path.as_os_str().is_empty() {
                candidates.push(path);
            }
        }
        if let Some(value) = env::var_os("APPDATA") {
            candidates.push(PathBuf::from(value).join("opencode"));
        }
        if let Some(value) = env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(value).join("opencode"));
        }
        candidates.push(home_dir()?.join(".local").join("share").join("opencode"));

        if let Some(found) = candidates
            .iter()
            .find(|path| path.join(AUTH_FILE_NAME).exists())
            .cloned()
        {
            return Ok(found);
        }

        return candidates
            .into_iter()
            .next()
            .ok_or_else(|| "无法定位 OpenCode 数据目录。".to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok(home_dir()?.join(".local").join("share").join("opencode"))
    }
}

pub(super) fn opencode_auth_file() -> CmdResult<PathBuf> {
    Ok(opencode_data_dir()?.join(AUTH_FILE_NAME))
}

pub(super) fn agents_home() -> CmdResult<PathBuf> {
    Ok(home_dir()?.join(AGENTS_HOME_DIR))
}

pub(super) fn codex_skills_dir() -> CmdResult<PathBuf> {
    Ok(codex_home()?.join(SKILLS_DIR_NAME))
}

pub(super) fn opencode_skills_dir() -> CmdResult<PathBuf> {
    Ok(home_dir()?
        .join(".config")
        .join("opencode")
        .join(SKILLS_DIR_NAME))
}

pub(super) fn opencode_legacy_skills_dir() -> CmdResult<PathBuf> {
    Ok(agents_home()?.join(SKILLS_DIR_NAME))
}

pub(super) fn opencode_skills_target_dirs() -> CmdResult<Vec<PathBuf>> {
    let mut dirs = vec![opencode_skills_dir()?];
    let legacy = opencode_legacy_skills_dir()?;
    if !dirs.iter().any(|d| d == &legacy) {
        dirs.push(legacy);
    }
    Ok(dirs)
}

pub(super) fn cc_switch_home() -> CmdResult<PathBuf> {
    Ok(home_dir()?.join(CC_SWITCH_HOME_DIR))
}

pub(super) fn ccswitch_ssot_skills_dir() -> CmdResult<PathBuf> {
    Ok(cc_switch_home()?.join(SKILLS_DIR_NAME))
}

pub(super) fn legacy_switcher_skills_dir() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(SKILLS_DIR_NAME))
}

pub(super) fn ccswitch_db_file() -> CmdResult<PathBuf> {
    Ok(cc_switch_home()?.join(CC_SWITCH_DB_FILE_NAME))
}

pub(super) fn profiles_dir() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(PROFILES_DIR_NAME))
}

pub(super) fn backups_dir() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(BACKUPS_DIR_NAME))
}

pub(super) fn profiles_file() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(PROFILES_FILE_NAME))
}

pub(super) fn codex_hook_signal_file() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(CODEX_SWITCH_HOOK_SIGNAL_FILE_NAME))
}

pub(super) fn codex_hook_newchat_signal_file() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(CODEX_SWITCH_HOOK_NEWCHAT_SIGNAL_FILE_NAME))
}

pub(super) fn mcp_opencode_config_file() -> CmdResult<PathBuf> {
    Ok(home_dir()?
        .join(".config")
        .join("opencode")
        .join(OPENCODE_CONFIG_FILE_NAME))
}

pub(super) fn opencode_quota_bridge_home() -> CmdResult<PathBuf> {
    Ok(switcher_home()?
        .join("runtime")
        .join("opencode_live_codex_home"))
}
