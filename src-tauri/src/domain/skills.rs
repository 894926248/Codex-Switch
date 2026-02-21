use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::constants::SKILL_MANIFEST_FILE_NAME;
use super::models::CmdResult;
use super::paths::{
    ccswitch_ssot_skills_dir, codex_skills_dir, legacy_switcher_skills_dir,
    opencode_legacy_skills_dir, opencode_skills_dir,
};
use super::SkillScanEntry;

pub(crate) fn normalize_skill_id(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            prev_dash = false;
        } else if (lower == '-' || lower == '_' || lower == ' ' || lower == '.')
            && !prev_dash
            && !out.is_empty()
        {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

pub(crate) fn trim_wrapping_quotes(raw: &str) -> String {
    let text = raw.trim();
    if text.len() >= 2 {
        let bytes = text.as_bytes();
        if (bytes[0] == b'"' && bytes[text.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[text.len() - 1] == b'\'')
        {
            return text[1..text.len() - 1].trim().to_string();
        }
    }
    text.to_string()
}

pub(crate) fn parse_skill_manifest(skill_dir: &Path) -> (String, String) {
    let fallback_name = skill_dir
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("unknown")
        .to_string();
    let manifest = skill_dir.join(SKILL_MANIFEST_FILE_NAME);
    let text = match fs::read_to_string(&manifest) {
        Ok(v) => v,
        Err(_) => return (fallback_name, "未提供描述".to_string()),
    };

    let mut name = fallback_name.clone();
    let mut description = String::new();
    let mut body_start_idx = 0usize;
    let lines: Vec<&str> = text.lines().collect();

    if lines.first().map(|line| line.trim()) == Some("---") {
        for (idx, line) in lines.iter().enumerate().skip(1) {
            let trimmed = line.trim();
            if trimmed == "---" {
                body_start_idx = idx.saturating_add(1);
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("name:") {
                let value = trim_wrapping_quotes(rest);
                if !value.is_empty() {
                    name = value;
                }
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("description:") {
                let value = trim_wrapping_quotes(rest);
                if !value.is_empty() {
                    description = value;
                }
                continue;
            }
        }
    }

    if description.is_empty() {
        let mut parts: Vec<String> = Vec::new();
        for line in lines.iter().skip(body_start_idx) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                if !parts.is_empty() {
                    break;
                }
                continue;
            }
            if trimmed.starts_with('#')
                || trimmed.starts_with("```")
                || trimmed.starts_with('|')
                || trimmed.starts_with("- ")
                || trimmed.starts_with("* ")
            {
                if !parts.is_empty() {
                    break;
                }
                continue;
            }
            parts.push(trimmed.to_string());
            if parts.join(" ").len() >= 260 {
                break;
            }
        }
        description = parts.join(" ").trim().to_string();
    }

    if description.is_empty() {
        description = "未提供描述".to_string();
    }
    (name, description)
}

pub(crate) fn parse_skill_manifest_text(text: &str, fallback_name: &str) -> (String, String) {
    let mut name = fallback_name.to_string();
    let mut description = String::new();
    let mut body_start_idx = 0usize;
    let lines: Vec<&str> = text.lines().collect();

    if lines.first().map(|line| line.trim()) == Some("---") {
        for (idx, line) in lines.iter().enumerate().skip(1) {
            let trimmed = line.trim();
            if trimmed == "---" {
                body_start_idx = idx.saturating_add(1);
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("name:") {
                let value = trim_wrapping_quotes(rest);
                if !value.is_empty() {
                    name = value;
                }
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("description:") {
                let value = trim_wrapping_quotes(rest);
                if !value.is_empty() {
                    description = value;
                }
                continue;
            }
        }
    }

    if description.is_empty() {
        let mut parts: Vec<String> = Vec::new();
        for line in lines.iter().skip(body_start_idx) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                if !parts.is_empty() {
                    break;
                }
                continue;
            }
            if trimmed.starts_with('#')
                || trimmed.starts_with("```")
                || trimmed.starts_with('|')
                || trimmed.starts_with("- ")
                || trimmed.starts_with("* ")
            {
                if !parts.is_empty() {
                    break;
                }
                continue;
            }
            parts.push(trimmed.to_string());
            if parts.join(" ").len() >= 260 {
                break;
            }
        }
        description = parts.join(" ").trim().to_string();
    }

    if description.is_empty() {
        description = "未提供描述".to_string();
    }
    (name, description)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SkillScanSource {
    Ssot,
    Codex,
    OpenCode,
    OpenCodeLegacy,
}

pub(crate) fn is_skill_dir(path: &Path) -> bool {
    path.is_dir() && path.join(SKILL_MANIFEST_FILE_NAME).exists()
}

pub(crate) fn add_skill_location(entry: &mut SkillScanEntry, path: &Path) {
    let location = path.to_string_lossy().to_string();
    if !entry.locations.iter().any(|item| item == &location) {
        entry.locations.push(location);
    }
}

pub(crate) fn scan_skill_root(
    root: &Path,
    source: SkillScanSource,
    merged: &mut BTreeMap<String, SkillScanEntry>,
) -> CmdResult<()> {
    if !root.exists() {
        return Ok(());
    }
    let entries =
        fs::read_dir(root).map_err(|e| format!("读取 skills 目录失败 {}: {e}", root.display()))?;
    for entry in entries {
        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(dir_name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if dir_name.starts_with('.') {
            continue;
        }
        if !is_skill_dir(&path) {
            continue;
        }
        let (name, description) = parse_skill_manifest(&path);
        let key = dir_name.to_lowercase();
        let row = merged.entry(key).or_insert_with(|| SkillScanEntry {
            id: dir_name.to_string(),
            directory: dir_name.to_string(),
            name: name.clone(),
            description: description.clone(),
            ssot_source: false,
            codex_source: false,
            opencode_source: false,
            opencode_legacy_source: false,
            locations: Vec::new(),
        });
        if row.directory.trim().is_empty() {
            row.directory = dir_name.to_string();
        }
        if row.id.trim().is_empty() {
            row.id = dir_name.to_string();
        }
        if row.name.trim().is_empty() {
            row.name = name.clone();
        }
        if row.description.trim().is_empty() {
            row.description = description.clone();
        }
        match source {
            SkillScanSource::Ssot => row.ssot_source = true,
            SkillScanSource::Codex => row.codex_source = true,
            SkillScanSource::OpenCode => row.opencode_source = true,
            SkillScanSource::OpenCodeLegacy => row.opencode_legacy_source = true,
        }
        add_skill_location(row, &path);
    }
    Ok(())
}

pub(crate) fn skill_source_label(entry: &SkillScanEntry) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if entry.ssot_source {
        parts.push("CCSwitch");
    }
    if entry.codex_source {
        parts.push("Codex");
    }
    if entry.opencode_source || entry.opencode_legacy_source {
        parts.push("OpenCode");
    }
    if parts.is_empty() {
        "Local".to_string()
    } else {
        parts.join("+")
    }
}

pub(crate) fn copy_dir_recursive(src: &Path, dest: &Path) -> CmdResult<()> {
    if !src.is_dir() {
        return Err(format!(
            "复制 Skills 目录失败，源目录不存在: {}",
            src.display()
        ));
    }
    fs::create_dir_all(dest).map_err(|e| format!("创建目录失败 {}: {e}", dest.display()))?;

    let entries = fs::read_dir(src).map_err(|e| format!("读取目录失败 {}: {e}", src.display()))?;
    for entry in entries {
        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let from = entry.path();
        let to = dest.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| {
            format!(
                "读取目录条目类型失败 {}: {e}",
                from.to_string_lossy().to_string()
            )
        })?;
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
            continue;
        }
        if ty.is_file() {
            fs::copy(&from, &to)
                .map_err(|e| format!("复制文件失败 {} -> {}: {e}", from.display(), to.display()))?;
            continue;
        }
        if ty.is_symlink() {
            let target = fs::read_link(&from)
                .map_err(|e| format!("读取符号链接失败 {}: {e}", from.display()))?;
            let resolved = if target.is_absolute() {
                target
            } else {
                from.parent().unwrap_or(src).join(target)
            };
            if resolved.is_dir() {
                copy_dir_recursive(&resolved, &to)?;
            } else if resolved.is_file() {
                fs::copy(&resolved, &to).map_err(|e| {
                    format!(
                        "复制符号链接目标失败 {} -> {}: {e}",
                        resolved.display(),
                        to.display()
                    )
                })?;
            }
        }
    }

    Ok(())
}

pub(crate) fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

pub(crate) fn path_exists_or_symlink(path: &Path) -> bool {
    path.exists() || is_symlink(path)
}

pub(crate) fn remove_path_safe(path: &Path) -> CmdResult<()> {
    if !path_exists_or_symlink(path) {
        return Ok(());
    }
    if is_symlink(path) {
        #[cfg(unix)]
        {
            fs::remove_file(path)
                .map_err(|e| format!("删除符号链接失败 {}: {e}", path.display()))?;
        }
        #[cfg(windows)]
        {
            if let Err(dir_err) = fs::remove_dir(path) {
                fs::remove_file(path).map_err(|file_err| {
                    format!("删除符号链接失败 {}: {dir_err}; {file_err}", path.display())
                })?;
            }
        }
        return Ok(());
    }
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("删除目录失败 {}: {e}", path.display()))?;
        return Ok(());
    }
    fs::remove_file(path).map_err(|e| format!("删除文件失败 {}: {e}", path.display()))
}

#[cfg(unix)]
pub(crate) fn create_dir_symlink(source: &Path, dest: &Path) -> CmdResult<()> {
    std::os::unix::fs::symlink(source, dest).map_err(|e| {
        format!(
            "创建符号链接失败 {} -> {}: {e}",
            source.display(),
            dest.display()
        )
    })
}

#[cfg(windows)]
pub(crate) fn create_dir_symlink(source: &Path, dest: &Path) -> CmdResult<()> {
    std::os::windows::fs::symlink_dir(source, dest).map_err(|e| {
        format!(
            "创建符号链接失败 {} -> {}: {e}",
            source.display(),
            dest.display()
        )
    })
}

pub(crate) fn ensure_ccswitch_ssot_seeded() -> CmdResult<()> {
    let ssot = ccswitch_ssot_skills_dir()?;
    fs::create_dir_all(&ssot)
        .map_err(|e| format!("创建 Skills 中心目录失败 {}: {e}", ssot.display()))?;

    let legacy = legacy_switcher_skills_dir()?;
    if !legacy.exists() {
        return Ok(());
    }

    let entries = match fs::read_dir(&legacy) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    for entry in entries {
        let entry = match entry {
            Ok(v) => v,
            Err(_) => continue,
        };
        let path = entry.path();
        if !is_skill_dir(&path) {
            continue;
        }
        let dir_name = entry.file_name();
        let dest = ssot.join(&dir_name);
        if is_skill_dir(&dest) {
            continue;
        }
        if path_exists_or_symlink(&dest) {
            remove_path_safe(&dest)?;
        }
        copy_dir_recursive(&path, &dest)?;
    }

    Ok(())
}

pub(crate) fn ensure_skill_in_ssot(directory: &str) -> CmdResult<PathBuf> {
    let ssot = ccswitch_ssot_skills_dir()?;
    fs::create_dir_all(&ssot)
        .map_err(|e| format!("创建 Skills 中心目录失败 {}: {e}", ssot.display()))?;

    let dest = ssot.join(directory);
    if is_skill_dir(&dest) {
        return Ok(dest);
    }

    let candidate_roots = vec![
        legacy_switcher_skills_dir()?,
        codex_skills_dir()?,
        opencode_skills_dir()?,
        opencode_legacy_skills_dir()?,
    ];

    for root in candidate_roots {
        let candidate = root.join(directory);
        if !is_skill_dir(&candidate) {
            continue;
        }
        if path_exists_or_symlink(&dest) {
            remove_path_safe(&dest)?;
        }
        copy_dir_recursive(&candidate, &dest)?;
        return Ok(dest);
    }

    Err(format!("未找到可用于同步的 Skill 源目录: {directory}"))
}

pub(crate) fn sync_skill_to_target_dir(directory: &str, target_root: &Path) -> CmdResult<()> {
    let ssot_skill = ensure_skill_in_ssot(directory)?;
    fs::create_dir_all(target_root)
        .map_err(|e| format!("创建 Skills 目录失败 {}: {e}", target_root.display()))?;
    let target_skill = target_root.join(directory);
    if path_exists_or_symlink(&target_skill) {
        remove_path_safe(&target_skill)?;
    }

    match create_dir_symlink(&ssot_skill, &target_skill) {
        Ok(()) => Ok(()),
        Err(_) => copy_dir_recursive(&ssot_skill, &target_skill),
    }
}

pub(crate) fn remove_skill_from_target_dir(directory: &str, target_root: &Path) -> CmdResult<()> {
    let target_skill = target_root.join(directory);
    remove_path_safe(&target_skill)
}
