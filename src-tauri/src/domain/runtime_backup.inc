fn ensure_dirs() -> CmdResult<()> {
    fs::create_dir_all(switcher_home()?).map_err(|e| format!("创建目录失败: {e}"))?;
    fs::create_dir_all(profiles_dir()?).map_err(|e| format!("创建 profiles 目录失败: {e}"))?;
    fs::create_dir_all(backups_dir()?).map_err(|e| format!("创建 backups 目录失败: {e}"))?;
    Ok(())
}

fn next_backup_archive_path_in_dir(output_dir: &Path, prefix: &str) -> CmdResult<PathBuf> {
    if output_dir.exists() && !output_dir.is_dir() {
        return Err(format!("导出目录不是文件夹：{}", output_dir.display()));
    }
    fs::create_dir_all(output_dir)
        .map_err(|e| format!("创建导出目录失败 {}: {e}", output_dir.display()))?;

    let stamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let mut index: usize = 1;
    loop {
        let file_name = if index == 1 {
            format!("{prefix}_{stamp}.tar.gz")
        } else {
            format!("{prefix}_{stamp}_{index}.tar.gz")
        };
        let candidate = output_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
        index = index.saturating_add(1);
    }
}

fn next_backup_archive_path(prefix: &str) -> CmdResult<PathBuf> {
    ensure_dirs()?;
    let backups_root = backups_dir()?;
    next_backup_archive_path_in_dir(&backups_root, prefix)
}

fn collect_regular_files_recursive(base_dir: &Path, out: &mut Vec<PathBuf>) -> CmdResult<()> {
    if !base_dir.exists() {
        return Ok(());
    }
    let entries =
        fs::read_dir(base_dir).map_err(|e| format!("读取目录失败 {}: {e}", base_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取目录项失败 {}: {e}", base_dir.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败 {}: {e}", path.display()))?;
        if file_type.is_dir() {
            collect_regular_files_recursive(&path, out)?;
        } else if file_type.is_file() {
            out.push(path);
        }
    }
    Ok(())
}

fn path_to_posix(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn collect_backup_file_entries() -> CmdResult<Vec<(PathBuf, String)>> {
    ensure_dirs()?;
    let mut entries: Vec<(PathBuf, String)> = Vec::new();
    let mut seen_arc_names: HashSet<String> = HashSet::new();
    let switcher_root = switcher_home()?;

    let store_path = profiles_file()?;
    if store_path.exists() {
        let rel = store_path
            .strip_prefix(&switcher_root)
            .map_err(|e| format!("计算备份路径失败 {}: {e}", store_path.display()))?;
        let arc_name = format!("{BACKUP_SWITCHER_PREFIX}/{}", path_to_posix(rel));
        if seen_arc_names.insert(arc_name.clone()) {
            entries.push((store_path, arc_name));
        }
    }

    let mut profile_files: Vec<PathBuf> = Vec::new();
    collect_regular_files_recursive(&profiles_dir()?, &mut profile_files)?;
    profile_files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));

    for file_path in profile_files {
        let rel = file_path
            .strip_prefix(&switcher_root)
            .map_err(|e| format!("计算备份路径失败 {}: {e}", file_path.display()))?;
        let arc_name = format!("{BACKUP_SWITCHER_PREFIX}/{}", path_to_posix(rel));
        if seen_arc_names.insert(arc_name.clone()) {
            entries.push((file_path, arc_name));
        }
    }

    let codex_root = codex_home()?;
    for file_name in [AUTH_FILE_NAME, CAP_SID_FILE_NAME, CONFIG_FILE_NAME] {
        let file_path = codex_root.join(file_name);
        if !file_path.exists() {
            continue;
        }
        let arc_name = format!("{BACKUP_CODEX_PREFIX}/{file_name}");
        if seen_arc_names.insert(arc_name.clone()) {
            entries.push((file_path, arc_name));
        }
    }
    Ok(entries)
}

fn create_backup_archive_at(archive_path: &Path) -> CmdResult<BackupExportResult> {
    ensure_dirs()?;
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建备份目录失败 {}: {e}", parent.to_string_lossy()))?;
    }

    let entries = collect_backup_file_entries()?;
    let file_count = entries.len();
    let estimated_total_bytes: u64 = entries
        .iter()
        .map(|(path, _)| fs::metadata(path).map(|m| m.len()).unwrap_or(0))
        .sum();

    let manifest = BackupManifest {
        format: BACKUP_FORMAT_NAME.to_string(),
        schema_version: BACKUP_SCHEMA_VERSION,
        created_at: now_iso(),
        file_count,
        estimated_total_bytes,
    };
    let mut manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| format!("序列化备份 manifest 失败: {e}"))?;
    manifest_bytes.push(b'\n');

    let archive_file = File::create(archive_path)
        .map_err(|e| format!("创建备份文件失败 {}: {e}", archive_path.display()))?;
    let encoder = GzEncoder::new(archive_file, Compression::default());
    let mut builder = Builder::new(encoder);

    let mut manifest_header = Header::new_gnu();
    manifest_header.set_size(manifest_bytes.len() as u64);
    manifest_header.set_mode(0o644);
    let manifest_mtime = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    manifest_header.set_mtime(manifest_mtime);
    manifest_header.set_cksum();
    builder
        .append_data(
            &mut manifest_header,
            BACKUP_MANIFEST_NAME,
            Cursor::new(manifest_bytes),
        )
        .map_err(|e| format!("写入备份 manifest 失败: {e}"))?;

    for (source_path, arc_name) in entries {
        builder
            .append_path_with_name(&source_path, &arc_name)
            .map_err(|e| {
                format!(
                    "写入备份条目失败 {} -> {}: {e}",
                    source_path.display(),
                    arc_name
                )
            })?;
    }

    builder
        .finish()
        .map_err(|e| format!("完成备份归档失败: {e}"))?;
    let encoder = builder
        .into_inner()
        .map_err(|e| format!("写入备份归档失败: {e}"))?;
    encoder
        .finish()
        .map_err(|e| format!("落盘备份归档失败: {e}"))?;

    Ok(BackupExportResult {
        archive_path: archive_path.to_string_lossy().to_string(),
        file_count,
        estimated_total_bytes,
    })
}

fn safe_archive_path_parts(raw: &str) -> CmdResult<Vec<String>> {
    let normalized = raw.replace('\\', "/");
    if normalized.trim().is_empty() {
        return Err("备份条目路径为空。".to_string());
    }
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err(format!("备份条目包含非法绝对路径: {raw}"));
    }

    let mut parts: Vec<String> = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("备份条目包含非法路径片段: {raw}"));
        }
        parts.push(part.to_string());
    }
    if parts.is_empty() {
        return Err("备份条目路径为空。".to_string());
    }
    Ok(parts)
}

fn parse_backup_archive_reader<R: Read>(reader: R) -> CmdResult<ParsedBackupPayload> {
    let mut payload = ParsedBackupPayload::default();
    let switcher_root = switcher_home()?;
    let codex_root = codex_home()?;
    let store_path = profiles_file()?;
    let mut manifest: Option<BackupManifest> = None;

    let mut archive = Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|e| format!("读取备份归档条目失败: {e}"))?;
    for item in entries {
        let mut entry = item.map_err(|e| format!("读取备份条目失败: {e}"))?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_dir() {
            continue;
        }
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err("备份包含符号链接/硬链接，出于安全考虑已拒绝。".to_string());
        }
        if !entry_type.is_file() {
            continue;
        }

        let entry_path = entry
            .path()
            .map_err(|e| format!("读取备份条目路径失败: {e}"))?;
        let member_name = path_to_posix(&entry_path);
        if member_name == BACKUP_MANIFEST_NAME {
            let mut manifest_bytes: Vec<u8> = Vec::new();
            entry
                .read_to_end(&mut manifest_bytes)
                .map_err(|e| format!("读取备份 manifest 失败: {e}"))?;
            let parsed: BackupManifest = serde_json::from_slice(&manifest_bytes)
                .map_err(|e| format!("解析备份 manifest 失败: {e}"))?;
            manifest = Some(parsed);
            continue;
        }

        let parts = safe_archive_path_parts(&member_name)?;
        let root = parts.first().map(|v| v.as_str()).unwrap_or_default();

        if root == BACKUP_SWITCHER_PREFIX {
            let target = if parts.len() == 2 && parts[1] == PROFILES_FILE_NAME {
                payload.has_switcher_payload = true;
                payload.has_profiles_file_payload = true;
                store_path.clone()
            } else if parts.len() >= 3 && parts[1] == PROFILES_DIR_NAME {
                payload.has_switcher_payload = true;
                let mut path = switcher_root.join(PROFILES_DIR_NAME);
                for part in parts.iter().skip(2) {
                    path.push(part);
                }
                path
            } else {
                continue;
            };
            let mut bytes: Vec<u8> = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| format!("读取备份条目失败 {member_name}: {e}"))?;
            payload.switcher_entries.push((target, bytes));
            continue;
        }

        if root == BACKUP_CODEX_PREFIX {
            if parts.len() != 2 {
                continue;
            }
            let file_name = parts[1].as_str();
            if ![AUTH_FILE_NAME, CAP_SID_FILE_NAME, CONFIG_FILE_NAME].contains(&file_name) {
                continue;
            }
            let mut bytes: Vec<u8> = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| format!("读取备份条目失败 {member_name}: {e}"))?;
            payload
                .codex_entries
                .push((codex_root.join(file_name), bytes));
        }
    }

    let Some(manifest) = manifest else {
        return Err("备份缺少 manifest，无法导入。".to_string());
    };
    if manifest.format != BACKUP_FORMAT_NAME {
        return Err("备份格式不匹配，无法导入。".to_string());
    }
    if manifest.schema_version != BACKUP_SCHEMA_VERSION {
        return Err(format!(
            "备份 schema 版本不支持：{}，当前仅支持 {}。",
            manifest.schema_version, BACKUP_SCHEMA_VERSION
        ));
    }

    Ok(payload)
}

fn parse_backup_archive_bytes(archive_bytes: &[u8]) -> CmdResult<ParsedBackupPayload> {
    let is_gzip = archive_bytes.len() >= 2 && archive_bytes[0] == 0x1F && archive_bytes[1] == 0x8B;
    if is_gzip {
        parse_backup_archive_reader(GzDecoder::new(Cursor::new(archive_bytes)))
    } else {
        parse_backup_archive_reader(Cursor::new(archive_bytes))
    }
}

fn normalize_restored_profiles_snapshot_paths() -> CmdResult<()> {
    let store_path = profiles_file()?;
    if !store_path.exists() {
        return Ok(());
    }
    let text = match fs::read_to_string(&store_path) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let mut root: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    let Some(root_obj) = root.as_object_mut() else {
        return Ok(());
    };
    let Some(profiles_obj) = root_obj.get_mut("profiles").and_then(Value::as_object_mut) else {
        return Ok(());
    };

    let profiles_root = profiles_dir()?;
    let mut changed = false;
    for (name, record_value) in profiles_obj.iter_mut() {
        let Some(record_obj) = record_value.as_object_mut() else {
            continue;
        };
        let expected = profiles_root.join(name).to_string_lossy().to_string();
        let current = record_obj.get("snapshot_dir").and_then(Value::as_str);
        if current != Some(expected.as_str()) {
            record_obj.insert("snapshot_dir".to_string(), Value::String(expected));
            changed = true;
        }
        let support = profile_support_json(profile_support_from_value(record_obj.get("support")));
        if record_obj.get("support") != Some(&support) {
            record_obj.insert("support".to_string(), support);
            changed = true;
        }
    }

    if changed {
        let serialized = serde_json::to_string_pretty(&root)
            .map_err(|e| format!("序列化恢复后的 profiles.json 失败: {e}"))?;
        fs::write(&store_path, format!("{serialized}\n"))
            .map_err(|e| format!("写入恢复后的 profiles.json 失败: {e}"))?;
    }
    Ok(())
}

fn apply_backup_payload(payload: ParsedBackupPayload) -> CmdResult<usize> {
    ensure_dirs()?;
    if payload.has_switcher_payload {
        let profiles_path = profiles_dir()?;
        safe_remove_dir(&profiles_path);
        fs::create_dir_all(&profiles_path).map_err(|e| format!("重建 profiles 目录失败: {e}"))?;
        if !payload.has_profiles_file_payload {
            let store_path = profiles_file()?;
            if store_path.exists() {
                let _ = fs::remove_file(store_path);
            }
        }
    }

    let mut restored_count: usize = 0;
    for (target, bytes) in payload.switcher_entries {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建恢复目录失败 {}: {e}", parent.display()))?;
        }
        fs::write(&target, bytes)
            .map_err(|e| format!("写入恢复文件失败 {}: {e}", target.display()))?;
        restored_count = restored_count.saturating_add(1);
    }
    for (target, bytes) in payload.codex_entries {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建恢复目录失败 {}: {e}", parent.display()))?;
        }
        fs::write(&target, bytes)
            .map_err(|e| format!("写入恢复文件失败 {}: {e}", target.display()))?;
        restored_count = restored_count.saturating_add(1);
    }

    normalize_restored_profiles_snapshot_paths()?;
    Ok(restored_count)
}

fn export_data_backup_internal(output_dir: Option<&str>) -> CmdResult<BackupExportResult> {
    let archive_path = if let Some(dir_text) = output_dir {
        let trimmed = dir_text.trim();
        if trimmed.is_empty() {
            next_backup_archive_path("backup")?
        } else {
            next_backup_archive_path_in_dir(&PathBuf::from(trimmed), "backup")?
        }
    } else {
        next_backup_archive_path("backup")?
    };
    create_backup_archive_at(&archive_path)
}

fn import_data_backup_base64_internal(
    file_name: &str,
    archive_base64: &str,
) -> CmdResult<BackupImportResult> {
    ensure_dirs()?;
    let source_file_name = if file_name.trim().is_empty() {
        "backup.tar.gz".to_string()
    } else {
        file_name.trim().to_string()
    };
    let archive_bytes = STANDARD
        .decode(archive_base64.trim())
        .map_err(|e| format!("备份文件解码失败: {e}"))?;
    if archive_bytes.is_empty() {
        return Err("备份文件为空。".to_string());
    }

    let safeguard_path = next_backup_archive_path("pre_restore")?;
    let _ = create_backup_archive_at(&safeguard_path)?;

    let payload = parse_backup_archive_bytes(&archive_bytes)?;
    let restored_count = apply_backup_payload(payload)?;
    let dashboard = load_dashboard_internal(true)?;
    Ok(BackupImportResult {
        source_file_name,
        safeguard_archive_path: safeguard_path.to_string_lossy().to_string(),
        restored_count,
        dashboard,
    })
}

