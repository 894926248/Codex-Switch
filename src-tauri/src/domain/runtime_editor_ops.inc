fn push_unique_text(entries: &mut Vec<String>, seen: &mut HashSet<String>, value: String) {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return;
    }
    let key = trimmed.replace('/', "\\").to_ascii_lowercase();
    if seen.insert(key) {
        entries.push(trimmed.to_string());
    }
}

#[cfg(target_os = "windows")]
fn push_existing_path_candidate(
    entries: &mut Vec<String>,
    seen: &mut HashSet<String>,
    path: PathBuf,
) {
    if path.exists() {
        push_unique_text(entries, seen, path.to_string_lossy().to_string());
    }
}

#[cfg(target_os = "windows")]
fn list_windows_vscode_cli_binaries() -> Vec<String> {
    let mut bins: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let add_install_layout_candidates = |entries: &mut Vec<String>,
                                         seen_keys: &mut HashSet<String>,
                                         root: PathBuf| {
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Microsoft VS Code").join("Code.exe"),
        );
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Microsoft VS Code").join("bin").join("code.cmd"),
        );
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Microsoft VS Code Insiders")
                .join("Code - Insiders.exe"),
        );
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Microsoft VS Code Insiders")
                .join("bin")
                .join("code-insiders.cmd"),
        );
        push_existing_path_candidate(entries, seen_keys, root.join("Cursor").join("Cursor.exe"));
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Cursor").join("bin").join("cursor.cmd"),
        );
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Cursor")
                .join("resources")
                .join("app")
                .join("bin")
                .join("cursor.cmd"),
        );
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Windsurf").join("Windsurf.exe"),
        );
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Windsurf").join("bin").join("windsurf.cmd"),
        );
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Windsurf")
                .join("resources")
                .join("app")
                .join("bin")
                .join("windsurf.cmd"),
        );
        push_existing_path_candidate(entries, seen_keys, root.join("Kiro").join("Kiro.exe"));
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Kiro").join("bin").join("kiro.cmd"),
        );
        push_existing_path_candidate(
            entries,
            seen_keys,
            root.join("Kiro")
                .join("resources")
                .join("app")
                .join("bin")
                .join("kiro.cmd"),
        );
    };

    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        add_install_layout_candidates(
            &mut bins,
            &mut seen,
            PathBuf::from(local_app_data).join("Programs"),
        );
    }
    for env_key in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(program_files) = env::var(env_key) {
            add_install_layout_candidates(&mut bins, &mut seen, PathBuf::from(program_files));
        }
    }

    for alias in ["code", "code-insiders", "cursor", "windsurf", "kiro"] {
        if let Ok(output) = command_no_window("where").arg(alias).output() {
            if output.status.success() {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let path = line.trim();
                    if path.is_empty() {
                        continue;
                    }
                    push_unique_text(&mut bins, &mut seen, path.to_string());
                    let lower = path.to_ascii_lowercase();
                    if lower.ends_with("\\code.cmd")
                        || lower.ends_with("\\code-insiders.cmd")
                        || lower.ends_with("\\code.exe")
                        || lower.ends_with("\\code - insiders.exe")
                        || lower.ends_with("\\cursor.cmd")
                        || lower.ends_with("\\cursor.exe")
                        || lower.ends_with("\\windsurf.cmd")
                        || lower.ends_with("\\windsurf.exe")
                        || lower.ends_with("\\kiro.cmd")
                        || lower.ends_with("\\kiro.exe")
                    {
                        if let Some(bin_dir) = Path::new(path).parent() {
                            if lower.ends_with("\\code.cmd")
                                || lower.ends_with("\\code-insiders.cmd")
                            {
                                if let Some(install_dir) = bin_dir.parent() {
                                    push_existing_path_candidate(
                                        &mut bins,
                                        &mut seen,
                                        install_dir.join("Code.exe"),
                                    );
                                    push_existing_path_candidate(
                                        &mut bins,
                                        &mut seen,
                                        install_dir.join("Code - Insiders.exe"),
                                    );
                                }
                            }
                            if lower.ends_with("\\cursor.cmd") {
                                if let Some(install_dir) = bin_dir.parent() {
                                    push_existing_path_candidate(
                                        &mut bins,
                                        &mut seen,
                                        install_dir.join("Cursor.exe"),
                                    );
                                }
                            }
                            if lower.ends_with("\\windsurf.cmd") {
                                if let Some(install_dir) = bin_dir.parent() {
                                    push_existing_path_candidate(
                                        &mut bins,
                                        &mut seen,
                                        install_dir.join("Windsurf.exe"),
                                    );
                                }
                            }
                            if lower.ends_with("\\kiro.cmd") {
                                if let Some(install_dir) = bin_dir.parent() {
                                    push_existing_path_candidate(
                                        &mut bins,
                                        &mut seen,
                                        install_dir.join("Kiro.exe"),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    push_unique_text(&mut bins, &mut seen, "code".to_string());
    push_unique_text(&mut bins, &mut seen, "code-insiders".to_string());
    push_unique_text(&mut bins, &mut seen, "cursor".to_string());
    push_unique_text(&mut bins, &mut seen, "windsurf".to_string());
    push_unique_text(&mut bins, &mut seen, "kiro".to_string());
    bins
}

#[cfg(target_os = "windows")]
fn preferred_editor_kinds_internal() -> Vec<&'static str> {
    fn push_kind_unique(kinds: &mut Vec<&'static str>, kind: &'static str) {
        if !kinds.contains(&kind) {
            kinds.push(kind);
        }
    }

    let mut kinds: Vec<&'static str> = Vec::new();

    if let Some(latest_log) = find_latest_codex_extension_log_file() {
        if let Some(kind) = editor_kind_from_codex_log_path(&latest_log) {
            push_kind_unique(&mut kinds, kind);
        }
    }

    let counts = count_windows_processes_by_images(&[
        "Windsurf.exe",
        "Cursor.exe",
        "Code.exe",
        "Code - Insiders.exe",
        "Kiro.exe",
    ]);
    let windsurf_running = counts.get("windsurf.exe").copied().unwrap_or(0) > 0;
    let cursor_running = counts.get("cursor.exe").copied().unwrap_or(0) > 0;
    let kiro_running = counts.get("kiro.exe").copied().unwrap_or(0) > 0;
    let vscode_running = counts.get("code.exe").copied().unwrap_or(0) > 0
        || counts.get("code - insiders.exe").copied().unwrap_or(0) > 0;

    if kiro_running {
        push_kind_unique(&mut kinds, "kiro");
    }
    if windsurf_running {
        push_kind_unique(&mut kinds, "windsurf");
    }
    if cursor_running {
        push_kind_unique(&mut kinds, "cursor");
    }
    if vscode_running {
        push_kind_unique(&mut kinds, "vscode");
    }

    if kinds.is_empty() {
        push_kind_unique(&mut kinds, "kiro");
        push_kind_unique(&mut kinds, "windsurf");
        push_kind_unique(&mut kinds, "cursor");
        push_kind_unique(&mut kinds, "vscode");
    }
    kinds
}

#[cfg(not(target_os = "windows"))]
fn preferred_editor_kinds_internal() -> Vec<&'static str> {
    Vec::new()
}

fn build_editor_command_uris(command_id: &str, preferred_kinds: &[&str]) -> Vec<String> {
    if preferred_kinds.is_empty() {
        vec![
            format!("windsurf://command/{command_id}"),
            format!("cursor://command/{command_id}"),
            format!("kiro://command/{command_id}"),
            format!("vscode://command/{command_id}"),
        ]
    } else {
        preferred_kinds
            .iter()
            .map(|kind| match *kind {
                "windsurf" => format!("windsurf://command/{command_id}"),
                "cursor" => format!("cursor://command/{command_id}"),
                "kiro" => format!("kiro://command/{command_id}"),
                _ => format!("vscode://command/{command_id}"),
            })
            .collect()
    }
}

fn invoke_vscode_command_uri_internal(command_id: &str, success_text: &str) -> CmdResult<String> {
    let preferred_kinds = preferred_editor_kinds_internal();
    let command_uris = build_editor_command_uris(command_id, &preferred_kinds);
    let mut errors: Vec<String> = Vec::new();

    #[cfg(target_os = "windows")]
    let bins = {
        let all_bins = list_windows_vscode_cli_binaries();
        if preferred_kinds.is_empty() {
            all_bins
        } else {
            let mut out: Vec<String> = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            for bin in all_bins {
                let lower = bin.to_lowercase();
                let is_windsurf = lower.contains("windsurf");
                let is_cursor = lower.contains("cursor");
                let is_kiro = lower.contains("kiro");
                let is_vscode = !is_windsurf
                    && !is_cursor
                    && !is_kiro
                    && (lower.contains("code-insiders")
                        || lower.contains("\\code")
                        || lower.ends_with("code")
                        || lower.ends_with("code.exe"));
                let matched = (preferred_kinds.contains(&"windsurf") && is_windsurf)
                    || (preferred_kinds.contains(&"cursor") && is_cursor)
                    || (preferred_kinds.contains(&"kiro") && is_kiro)
                    || (preferred_kinds.contains(&"vscode") && is_vscode);
                if matched {
                    let key = lower;
                    if seen.insert(key) {
                        out.push(bin);
                    }
                }
            }
            if out.is_empty() {
                if preferred_kinds.contains(&"windsurf") {
                    out.push("windsurf".to_string());
                }
                if preferred_kinds.contains(&"cursor") {
                    out.push("cursor".to_string());
                }
                if preferred_kinds.contains(&"kiro") {
                    out.push("kiro".to_string());
                }
                if preferred_kinds.contains(&"vscode") {
                    out.push("code-insiders".to_string());
                    out.push("code".to_string());
                }
            }
            out
        }
    };
    #[cfg(not(target_os = "windows"))]
    let bins = vec![
        "code".to_string(),
        "code-insiders".to_string(),
        "cursor".to_string(),
        "windsurf".to_string(),
        "kiro".to_string(),
    ];

    for command_uri in &command_uris {
        for bin in &bins {
            for args in [
                vec![
                    "--reuse-window".to_string(),
                    "--open-url".to_string(),
                    command_uri.clone(),
                ],
                vec!["--open-url".to_string(), command_uri.clone()],
            ] {
                match command_no_window(bin).args(&args).output() {
                    Ok(output) => {
                        if output.status.success() {
                            return Ok(success_text.to_string());
                        }
                        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        let detail = if !stderr.is_empty() {
                            stderr
                        } else if !stdout.is_empty() {
                            stdout
                        } else {
                            format!("exit {}", output.status)
                        };
                        errors.push(format!("{bin} {} -> {detail}", args.join(" ")));
                    }
                    Err(err) => errors.push(format!("{bin} {} -> {err}", args.join(" "))),
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        for command_uri in &command_uris {
            if command_no_window("cmd")
                .args(["/C", "start", "", command_uri.as_str()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                return Ok(success_text.to_string());
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        for command_uri in &command_uris {
            if command_no_window("xdg-open")
                .arg(command_uri.as_str())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                return Ok(success_text.to_string());
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        for command_uri in &command_uris {
            if command_no_window("open")
                .arg(command_uri.as_str())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
            {
                return Ok(success_text.to_string());
            }
        }
    }

    if errors.is_empty() {
        Err(format!("无法触发编辑器命令：{command_id}。"))
    } else {
        Err(format!(
            "无法触发编辑器命令：{command_id}。详情: {}",
            errors.join(" | ")
        ))
    }
}

#[cfg(target_os = "windows")]
fn parse_csv_line_quoted(line: &str) -> Vec<String> {
    let mut cols: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '"' {
            if in_quotes && i + 1 < chars.len() && chars[i + 1] == '"' {
                cur.push('"');
                i += 2;
                continue;
            }
            in_quotes = !in_quotes;
            i += 1;
            continue;
        }
        if ch == ',' && !in_quotes {
            cols.push(cur.trim().to_string());
            cur.clear();
            i += 1;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    cols.push(cur.trim().to_string());
    cols
}

#[cfg(target_os = "windows")]
fn list_windows_codex_process_ids() -> Vec<u32> {
    let output = command_no_window("tasklist")
        .args(["/FI", "IMAGENAME eq codex.exe", "/FO", "CSV", "/NH"])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let mut pids: Vec<u32> = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let text = line.trim();
        if text.is_empty() || text.to_lowercase().contains("no tasks are running") {
            continue;
        }
        let cols = parse_csv_line_quoted(text);
        if cols.len() < 2 {
            continue;
        }
        let image = cols[0].to_lowercase();
        if image != "codex.exe" {
            continue;
        }
        if let Ok(pid) = cols[1].trim().parse::<u32>() {
            pids.push(pid);
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(not(target_os = "windows"))]
fn list_unix_codex_process_ids() -> Vec<u32> {
    let output = command_no_window("pgrep").args(["-x", "codex"]).output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let mut pids: Vec<u32> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

fn codex_runtime_signature_internal() -> Option<String> {
    #[cfg(target_os = "windows")]
    let pids = list_windows_codex_process_ids();

    #[cfg(not(target_os = "windows"))]
    let pids = list_unix_codex_process_ids();

    if pids.is_empty() {
        None
    } else {
        Some(
            pids.iter()
                .map(|pid| pid.to_string())
                .collect::<Vec<_>>()
                .join(","),
        )
    }
}

fn wait_for_codex_runtime_signature_change(before: Option<String>, timeout_ms: u64) -> bool {
    let start = Instant::now();
    loop {
        let now = codex_runtime_signature_internal();
        if now != before {
            return true;
        }
        if start.elapsed() >= Duration::from_millis(timeout_ms) {
            return false;
        }
        thread::sleep(Duration::from_millis(120));
    }
}

fn wait_for_codex_runtime_restart_observed(before: Option<String>, timeout_ms: u64) -> bool {
    let start = Instant::now();
    let mut observed_down = before.is_none();
    loop {
        let now = codex_runtime_signature_internal();
        if now != before {
            return true;
        }
        if now.is_none() {
            observed_down = true;
        } else if observed_down {
            // Even if PID gets reused, a down->up bounce indicates runtime restart happened.
            return true;
        }
        if start.elapsed() >= Duration::from_millis(timeout_ms) {
            return false;
        }
        thread::sleep(Duration::from_millis(120));
    }
}

#[cfg(target_os = "windows")]
fn list_windows_extension_host_pids() -> Vec<u32> {
    fn parse_extension_host_pids_from_status(status_text: &str) -> Vec<u32> {
        let mut pids: Vec<u32> = Vec::new();
        for raw_line in status_text.lines() {
            let cols: Vec<&str> = raw_line.split_whitespace().collect();
            if cols.len() < 4 {
                continue;
            }
            if !cols[3].to_ascii_lowercase().starts_with("extension-host") {
                continue;
            }
            if let Ok(pid) = cols[2].parse::<u32>() {
                pids.push(pid);
            }
        }
        pids
    }

    fn parse_pids_from_text(text: &str) -> Vec<u32> {
        text.lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .collect()
    }

    fn list_parent_pids_from_codex_process() -> Vec<u32> {
        let script = r#"Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'codex.exe' -and $_.CommandLine -match 'app-server' } | ForEach-Object { $_.ParentProcessId }"#;
        let output = command_no_window("powershell")
            .args(["-NoProfile", "-Command", script])
            .output();
        let Ok(output) = output else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        parse_pids_from_text(&String::from_utf8_lossy(&output.stdout))
            .into_iter()
            .filter(|pid| *pid > 0)
            .collect()
    }

    let mut pids: Vec<u32> = Vec::new();
    for bin in list_windows_vscode_cli_binaries() {
        let output = command_no_window(&bin).arg("--status").output();
        let Ok(output) = output else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        pids.extend(parse_extension_host_pids_from_status(&text));
    }

    if pids.is_empty() {
        pids.extend(list_parent_pids_from_codex_process());
    }

    if pids.is_empty() {
        // Fallback for environments where `code --status` output is unavailable.
        let script = r#"Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'Code.exe' -or $_.Name -eq 'Code - Insiders.exe' -or $_.Name -eq 'Cursor.exe' -or $_.Name -eq 'Windsurf.exe' -or $_.Name -eq 'Kiro.exe') -and $_.CommandLine -match '--utility-sub-type=node\.mojom\.NodeService' -and $_.CommandLine -match '--inspect-port=0' } | ForEach-Object { $_.ProcessId }"#;
        let output = command_no_window("powershell")
            .args(["-NoProfile", "-Command", script])
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                pids.extend(parse_pids_from_text(&String::from_utf8_lossy(
                    &output.stdout,
                )));
            }
        }
    }

    pids.sort_unstable();
    pids.dedup();
    pids
}

#[cfg(target_os = "windows")]
fn restart_extension_host_hard_internal() -> CmdResult<String> {
    let pids = list_windows_extension_host_pids();
    if pids.is_empty() {
        return Err("未找到 Extension Host 进程，无法执行方案1兜底。".to_string());
    }
    let mut killed = 0u32;
    let mut failed: Vec<String> = Vec::new();
    for pid in pids {
        match command_no_window("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
        {
            Ok(output) if output.status.success() => {
                killed = killed.saturating_add(1);
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let detail = if !stderr.is_empty() {
                    stderr
                } else if !stdout.is_empty() {
                    stdout
                } else {
                    format!("exit {}", output.status)
                };
                failed.push(format!("{pid}: {detail}"));
            }
            Err(err) => failed.push(format!("{pid}: {err}")),
        }
    }
    if killed == 0 {
        return Err(format!(
            "未能结束任何 Extension Host 进程。{}",
            if failed.is_empty() {
                String::new()
            } else {
                format!("详情: {}", failed.join(" | "))
            }
        ));
    }
    if failed.is_empty() {
        Ok(format!(
            "已强制重启 Extension Host（结束 {killed} 个进程）。"
        ))
    } else {
        Ok(format!(
            "已强制重启 Extension Host（结束 {killed} 个进程，部分失败: {}）。",
            failed.join(" | ")
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn restart_extension_host_hard_internal() -> CmdResult<String> {
    Err("当前系统暂不支持方案1强制兜底。".to_string())
}

#[cfg(target_os = "windows")]
fn count_windows_processes_by_image(image_name: &str) -> u64 {
    let key = image_name.trim().to_lowercase();
    if key.is_empty() {
        return 0;
    }
    count_windows_processes_by_images(&[image_name])
        .get(&key)
        .copied()
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
fn count_windows_processes_by_images(image_names: &[&str]) -> HashMap<String, u64> {
    let targets: HashSet<String> = image_names
        .iter()
        .map(|name| name.trim().to_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    let mut counts: HashMap<String, u64> = targets.iter().map(|name| (name.clone(), 0)).collect();
    if targets.is_empty() {
        return counts;
    }

    let output = command_no_window("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output();
    let Ok(output) = output else {
        return counts;
    };
    if !output.status.success() {
        return counts;
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let text = line.trim();
        if text.is_empty() || text.to_lowercase().contains("no tasks are running") {
            continue;
        }
        let cols = parse_csv_line_quoted(text);
        if cols.is_empty() {
            continue;
        }
        let image = cols[0].trim().to_lowercase();
        if targets.contains(&image) {
            if let Some(total) = counts.get_mut(&image) {
                *total += 1;
            } else {
                counts.insert(image, 1);
            }
        }
    }
    counts
}

#[cfg(not(target_os = "windows"))]
fn count_unix_processes_by_name(proc_name: &str) -> u64 {
    let output = command_no_window("pgrep").args(["-x", proc_name]).output();
    let Ok(output) = output else {
        return 0;
    };
    if !output.status.success() {
        return 0;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as u64
}

fn get_opencode_process_count_internal() -> u64 {
    #[cfg(target_os = "windows")]
    {
        let counts = count_windows_processes_by_images(&[
            "OpenCode.exe",
            "opencode-cli.exe",
            "opencode.exe",
        ]);
        return counts.values().sum::<u64>();
    }

    #[cfg(not(target_os = "windows"))]
    {
        count_unix_processes_by_name("OpenCode")
            + count_unix_processes_by_name("opencode")
            + count_unix_processes_by_name("opencode-cli")
    }
}

fn get_vscode_status_internal(target: Option<&str>) -> VsCodeStatusView {
    let editor = normalize_editor_target(target);
    #[cfg(target_os = "windows")]
    let process_count = {
        let counts = if editor == "kiro" {
            count_windows_processes_by_images(&["Kiro.exe"])
        } else {
            count_windows_processes_by_images(&[
                "Code.exe",
                "Code - Insiders.exe",
                "Cursor.exe",
                "Windsurf.exe",
            ])
        };
        counts.values().sum::<u64>()
    };

    #[cfg(not(target_os = "windows"))]
    let process_count = {
        if editor == "kiro" {
            count_unix_processes_by_name("kiro") + count_unix_processes_by_name("Kiro")
        } else {
            count_unix_processes_by_name("code")
                + count_unix_processes_by_name("code-insiders")
                + count_unix_processes_by_name("Code")
                + count_unix_processes_by_name("cursor")
                + count_unix_processes_by_name("Cursor")
                + count_unix_processes_by_name("windsurf")
                + count_unix_processes_by_name("Windsurf")
        }
    };

    VsCodeStatusView {
        running: process_count > 0,
        process_count,
    }
}

fn trigger_vscode_reload_internal() -> CmdResult<String> {
    invoke_vscode_command_uri_internal("workbench.action.reloadWindow", "已请求 VS Code 重载窗口。")
}

fn restart_extension_host_internal() -> CmdResult<String> {
    let before = codex_runtime_signature_internal();
    let invoke_result = invoke_vscode_command_uri_internal(
        "workbench.action.restartExtensionHost",
        "已请求重启 VS Code Extension Host。",
    );
    if wait_for_codex_runtime_signature_change(before.clone(), 8_000) {
        return Ok(match invoke_result {
            Ok(msg) => format!("{msg} 已检测到 Codex 运行时重启。"),
            Err(_) => "已检测到 Codex 运行时重启。".to_string(),
        });
    }

    let hard_msg = restart_extension_host_hard_internal()?;
    if wait_for_codex_runtime_signature_change(before, 12_000) {
        return Ok(format!("{hard_msg} 已检测到 Codex 运行时重启。"));
    }
    Err(format!("{hard_msg} 但仍未检测到 Codex 运行时重启。"))
}

fn write_codex_hook_restart_signal_internal(success_text: &str) -> CmdResult<String> {
    let signal_path = codex_hook_signal_file()?;
    if let Some(parent) = signal_path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建 Hook 信号目录失败: {err}"))?;
    }
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let token = format!("{}-{}-{nonce}", now_ts_ms(), std::process::id());
    fs::write(&signal_path, format!("{token}\n"))
        .map_err(|err| format!("写入 Hook 重启信号失败 ({}): {err}", signal_path.display()))?;
    Ok(success_text.to_string())
}

fn write_codex_hook_newchat_signal_internal(success_text: &str) -> CmdResult<String> {
    let signal_path = codex_hook_newchat_signal_file()?;
    if let Some(parent) = signal_path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建 Hook 信号目录失败: {err}"))?;
    }
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let token = format!("{}-{}-{nonce}", now_ts_ms(), std::process::id());
    fs::write(&signal_path, format!("{token}\n")).map_err(|err| {
        format!(
            "写入 Hook 新对话信号失败 ({}): {err}",
            signal_path.display()
        )
    })?;
    Ok(success_text.to_string())
}

fn trigger_codex_hook_restart_by_signal_internal() -> CmdResult<String> {
    let before_first = codex_runtime_signature_internal();
    let first_msg = write_codex_hook_restart_signal_internal("已写入 Hook 提速重启信号。")?;
    if wait_for_codex_runtime_restart_observed(before_first, 3_000) {
        return Ok(format!(
            "{first_msg} 已检测到 Extension Host/Codex 运行时重启。"
        ));
    }

    thread::sleep(Duration::from_millis(120));
    let before_second = codex_runtime_signature_internal();
    let second_msg =
        write_codex_hook_restart_signal_internal("已写入 Hook 提速重启信号（第2次）。")?;
    if wait_for_codex_runtime_restart_observed(before_second, 3_000) {
        Ok(format!(
            "{first_msg} 首次未确认；{second_msg} 已检测到 Extension Host/Codex 运行时重启。"
        ))
    } else {
        Err(format!(
            "{first_msg}；{second_msg} 但连续2次均未检测到 Extension Host/Codex 运行时重启。"
        ))
    }
}

fn trigger_codex_hook_restart_by_command_internal() -> CmdResult<String> {
    let before_first = codex_runtime_signature_internal();
    let first_msg = invoke_vscode_command_uri_internal(
        CODEX_SWITCH_HOOK_COMMAND_ID,
        "已请求执行 Hook 提速重启。",
    )?;
    if wait_for_codex_runtime_restart_observed(before_first, 3_000) {
        return Ok(format!(
            "{first_msg} 已检测到 Extension Host/Codex 运行时重启。"
        ));
    }

    thread::sleep(Duration::from_millis(120));
    let before_second = codex_runtime_signature_internal();
    let second_msg = invoke_vscode_command_uri_internal(
        CODEX_SWITCH_HOOK_COMMAND_ID,
        "已请求执行 Hook 提速重启（第2次）。",
    )?;
    if wait_for_codex_runtime_restart_observed(before_second, 3_000) {
        Ok(format!(
            "{first_msg} 首次未确认；{second_msg} 已检测到 Extension Host/Codex 运行时重启。"
        ))
    } else {
        Err(format!(
            "{first_msg}；{second_msg} 但连续2次均未检测到 Extension Host/Codex 运行时重启。"
        ))
    }
}

fn trigger_codex_hook_restart_internal(prefer_signal: bool) -> CmdResult<String> {
    let mut errors: Vec<String> = Vec::new();

    if prefer_signal {
        match trigger_codex_hook_restart_by_signal_internal() {
            Ok(msg) => return Ok(msg),
            Err(err) => errors.push(format!("信号触发失败：{err}")),
        }
    }

    match trigger_codex_hook_restart_by_command_internal() {
        Ok(msg) => {
            if errors.is_empty() {
                Ok(msg)
            } else {
                Ok(format!("{} 已降级为命令触发。{}", errors.join("；"), msg))
            }
        }
        Err(err) => {
            errors.push(format!("命令触发失败：{err}"));
            Err(errors.join("；"))
        }
    }
}

fn run_post_switch_action_internal(strategy: &str) -> CmdResult<String> {
    match strategy.trim() {
        "hook" => {
            if !has_codex_hook_installed_internal(None) {
                return Err(
                    "方案2 Hook 提速版未安装。请先在设置中心执行“安装/更新方案2 Hook 提速版”。"
                        .to_string(),
                );
            }
            let auth_sync_note = ensure_live_auth_matches_active_profile_internal()?;
            let hook_watch_ready = has_codex_hook_watch_installed_internal();
            let hook_signal_ready = has_codex_hook_signal_watch_installed_internal();
            let runtime_msg = if hook_watch_ready {
                let before = codex_runtime_signature_internal();
                if wait_for_codex_runtime_restart_observed(before, 700) {
                    "方案2提速监听已生效：检测到 Extension Host 已自动重启。".to_string()
                } else {
                    match trigger_codex_hook_restart_internal(hook_signal_ready) {
                        Ok(msg) => format!("方案2提速监听未触发，已转为主动触发。{msg}"),
                        Err(hook_err) => {
                            let hint = "未执行强制兜底以避免中断当前会话。可手动执行方案1，或重新安装方案2 Hook 提速版。";
                            return Err(format!("方案2提速失败：{hook_err}。{hint}"));
                        }
                    }
                }
            } else {
                match trigger_codex_hook_restart_internal(hook_signal_ready) {
                    Ok(msg) => msg,
                    Err(hook_err) => {
                        let hint =
                            "未执行强制兜底以避免中断当前会话。可先安装/更新方案2 Hook 提速版，再重试。";
                        return Err(format!("方案2提速失败：{hook_err}。{hint}"));
                    }
                }
            };
            let runtime_msg = if let Some(note) = auth_sync_note {
                format!("{note} {runtime_msg}")
            } else {
                runtime_msg
            };
            Ok(format!("{runtime_msg} 切号后不自动新建对话。"))
        }
        "restart_extension_host" => {
            let restart_msg = restart_extension_host_internal()?;
            thread::sleep(Duration::from_millis(800));
            Ok(format!("{restart_msg} 切号后不自动新建对话。"))
        }
        other => Err(format!("未知切后策略: {other}")),
    }
}

fn trigger_chatgpt_new_chat_reset_internal(
    allow_hook_auto_install: bool,
    allow_uri_fallback: bool,
) -> CmdResult<String> {
    let mut notes: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut signal_written = false;
    let mut command_sent = false;

    if allow_hook_auto_install && !has_codex_hook_newchat_watch_installed_internal() {
        if let Ok(msg) = install_codex_hook_internal(None) {
            notes.push(format!("已自动更新 Hook 提速版。{msg}"));
        }
    }

    if has_codex_hook_newchat_watch_installed_internal() {
        match write_codex_hook_newchat_signal_internal("已写入 Hook 新对话重置信号。") {
            Ok(msg) => {
                signal_written = true;
                notes.push(msg);
            }
            Err(err) => errors.push(format!("写入 Hook 新对话信号失败：{err}")),
        }
    }

    if signal_written {
        return Ok(notes.join(" "));
    }

    if !allow_uri_fallback {
        if errors.is_empty() {
            return Err("未检测到可用的 Hook 新会话监听，且已禁用 URI 回退。".to_string());
        }
        return Err(format!(
            "仅允许 Hook 新会话重置，未执行 URI 回退。{}",
            errors.join(" | ")
        ));
    }

    for attempt in 1..=2 {
        match invoke_vscode_command_uri_internal(
            "chatgpt.newChat",
            "已请求在当前窗口重置为新对话。",
        ) {
            Ok(msg) => {
                command_sent = true;
                if attempt == 1 {
                    notes.push(msg);
                } else {
                    notes.push(format!("{msg}（第{attempt}次）"));
                }
                break;
            }
            Err(err) => {
                errors.push(format!("chatgpt.newChat 第{attempt}次失败：{err}"));
                thread::sleep(Duration::from_millis(300));
            }
        }
    }

    if signal_written || command_sent {
        return Ok(notes.join(" "));
    }

    Err(format!(
        "同窗口新会话重置失败。{}",
        if errors.is_empty() {
            "未获得可用执行通道。".to_string()
        } else {
            errors.join(" | ")
        }
    ))
}

include!("runtime_log_tail.inc");

include!("runtime_state_db.inc");

