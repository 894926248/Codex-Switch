fn ccswitch_generate_local_skill_id(conn: &Connection, directory: &str) -> CmdResult<String> {
    let raw = normalize_skill_id(directory);
    let stem = if raw.trim().is_empty() {
        "skill".to_string()
    } else {
        raw
    };
    let base = format!("local:{stem}");
    let mut id = base.clone();
    let mut seq: u32 = 2;
    loop {
        let existing_dir = conn
            .query_row(
                "SELECT directory FROM skills WHERE id = ?1 LIMIT 1",
                params![id.clone()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("检查 CC Switch skill id 冲突失败: {e}"))?;
        match existing_dir {
            None => return Ok(id),
            Some(found) if found.eq_ignore_ascii_case(directory) => return Ok(id),
            Some(_) => {
                id = format!("{base}:{seq}");
                seq = seq.saturating_add(1);
            }
        }
    }
}

fn ccswitch_upsert_skill_row(conn: &Connection, skill: &SkillEntryView) -> CmdResult<()> {
    let existing = ccswitch_find_skill_by_directory(conn, &skill.directory)?;
    let now_ts = Local::now().timestamp();
    let description = if skill.description.trim().is_empty() {
        None
    } else {
        Some(skill.description.clone())
    };
    let display_name = if skill.name.trim().is_empty() {
        skill.directory.clone()
    } else {
        skill.name.clone()
    };

    if let Some(row) = existing {
        let final_name = if display_name.trim().is_empty() {
            row.name
        } else {
            display_name
        };
        let final_description = if description.is_some() {
            description
        } else {
            row.description
        };
        conn.execute(
            "UPDATE skills
             SET name = ?1,
                 description = ?2,
                 directory = ?3,
                 repo_owner = ?4,
                 repo_name = ?5,
                 repo_branch = ?6,
                 readme_url = ?7,
                 enabled_claude = ?8,
                 enabled_codex = ?9,
                 enabled_gemini = ?10,
                 enabled_opencode = ?11,
                 installed_at = ?12
             WHERE id = ?13",
            params![
                final_name,
                final_description,
                skill.directory,
                row.repo_owner,
                row.repo_name,
                row.repo_branch,
                row.readme_url,
                skill.claude_enabled,
                skill.codex_enabled,
                skill.gemini_enabled,
                skill.opencode_enabled,
                if row.installed_at > 0 {
                    row.installed_at
                } else {
                    now_ts
                },
                row.id,
            ],
        )
        .map_err(|e| format!("更新 CC Switch skill 记录失败: {e}"))?;
        return Ok(());
    }

    let new_id = ccswitch_generate_local_skill_id(conn, &skill.directory)?;
    conn.execute(
        "INSERT INTO skills
         (id, name, description, directory, repo_owner, repo_name, repo_branch, readme_url,
          enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, installed_at)
         VALUES (?1, ?2, ?3, ?4, NULL, NULL, 'main', NULL, ?5, ?6, ?7, ?8, ?9)",
        params![
            new_id,
            display_name,
            description,
            skill.directory,
            skill.claude_enabled,
            skill.codex_enabled,
            skill.gemini_enabled,
            skill.opencode_enabled,
            now_ts,
        ],
    )
    .map_err(|e| format!("写入 CC Switch skill 记录失败: {e}"))?;
    Ok(())
}

fn sanitize_local_skill_directory(raw: &str) -> String {
    let leaf = Path::new(raw)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(raw);
    let normalized = normalize_skill_id(leaf);
    if normalized.trim().is_empty() {
        "skill".to_string()
    } else {
        normalized
    }
}

fn choose_unique_skill_directory(
    base: &str,
    preferred_existing: Option<&str>,
) -> CmdResult<String> {
    let ssot_root = ccswitch_ssot_skills_dir()?;
    fs::create_dir_all(&ssot_root)
        .map_err(|e| format!("创建 Skills 中心目录失败 {}: {e}", ssot_root.display()))?;

    let stem = sanitize_local_skill_directory(base);
    let mut candidate = stem.clone();
    let mut suffix: u32 = 2;
    loop {
        let path = ssot_root.join(&candidate);
        if !path_exists_or_symlink(&path) {
            return Ok(candidate);
        }
        if let Some(existing) = preferred_existing {
            if existing.eq_ignore_ascii_case(&candidate) {
                return Ok(candidate);
            }
        }
        candidate = format!("{stem}-{suffix}");
        suffix = suffix.saturating_add(1);
        if suffix > 20_000 {
            return Err("生成技能目录名失败，重名次数过多。".to_string());
        }
    }
}

fn download_repo_tarball_bytes(
    repo_owner: &str,
    repo_name: &str,
    repo_branch: &str,
) -> CmdResult<Vec<u8>> {
    use reqwest::blocking::Client;

    let url = format!(
        "https://api.github.com/repos/{}/{}/tarball/{}",
        repo_owner, repo_name, repo_branch
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("创建发现技能请求客户端失败: {e}"))?;
    let response = client
        .get(&url)
        .header("User-Agent", "codex-switch-discovery")
        .send()
        .map_err(|e| format!("拉取仓库失败 {repo_owner}/{repo_name}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "拉取仓库失败 {repo_owner}/{repo_name}: HTTP {}",
            response.status()
        ));
    }

    response
        .bytes()
        .map(|b| b.to_vec())
        .map_err(|e| format!("读取仓库归档失败 {repo_owner}/{repo_name}: {e}"))
}

fn fetch_repo_branch_head_sha(repo: &DiscoverSkillRepoView) -> CmdResult<String> {
    use reqwest::blocking::Client;

    let url = format!(
        "https://api.github.com/repos/{}/{}/commits/{}",
        repo.owner, repo.name, repo.branch
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建仓库比对请求客户端失败: {e}"))?;
    let response = client
        .get(&url)
        .header("User-Agent", "codex-switch-discovery")
        .send()
        .map_err(|e| format!("读取仓库 HEAD 失败 {}/{}: {e}", repo.owner, repo.name))?;
    if !response.status().is_success() {
        return Err(format!(
            "读取仓库 HEAD 失败 {}/{}: HTTP {}",
            repo.owner,
            repo.name,
            response.status()
        ));
    }
    let value: Value = response
        .json()
        .map_err(|e| format!("解析仓库 HEAD 响应失败 {}/{}: {e}", repo.owner, repo.name))?;
    let sha = value
        .get("sha")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if sha.is_empty() {
        return Err(format!(
            "仓库 HEAD 响应缺少 sha 字段 {}/{}",
            repo.owner, repo.name
        ));
    }
    Ok(sha)
}

fn extract_discovery_skill_from_tarball(
    payload: &[u8],
    repo_directory: &str,
    out_dir: &Path,
) -> CmdResult<()> {
    let decoder = GzDecoder::new(Cursor::new(payload.to_vec()));
    let mut archive = Archive::new(decoder);
    let repo_dir_norm = repo_directory.trim().trim_matches('/').replace('\\', "/");
    let repo_parts: Vec<&str> = repo_dir_norm
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .collect();
    let mut extracted_any = false;

    let entries = archive
        .entries()
        .map_err(|e| format!("解析仓库归档失败: {e}"))?;
    for item in entries {
        let mut entry = item.map_err(|e| format!("读取仓库条目失败: {e}"))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|e| format!("读取仓库路径失败: {e}"))?;
        let member = path_to_posix(path.as_ref());
        let parts: Vec<&str> = member.split('/').collect();
        if parts.len() < 2 {
            continue;
        }
        let inner_parts = &parts[1..];
        let rel_parts: Vec<&str> = if repo_parts.is_empty() {
            inner_parts.to_vec()
        } else {
            if inner_parts.len() <= repo_parts.len() {
                continue;
            }
            if !repo_parts
                .iter()
                .enumerate()
                .all(|(idx, part)| inner_parts[idx].eq_ignore_ascii_case(part))
            {
                continue;
            }
            inner_parts[repo_parts.len()..].to_vec()
        };

        if rel_parts.is_empty() {
            continue;
        }
        if rel_parts
            .iter()
            .any(|part| *part == "." || *part == ".." || part.trim().is_empty())
        {
            continue;
        }

        let rel_path = rel_parts.join("/");
        let out_path = out_dir.join(Path::new(&rel_path));
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建技能文件目录失败 {}: {e}", parent.display()))?;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("读取技能文件失败 {member}: {e}"))?;
        fs::write(&out_path, buf)
            .map_err(|e| format!("写入技能文件失败 {}: {e}", out_path.display()))?;
        extracted_any = true;
    }

    if !extracted_any {
        return Err("未在仓库归档中找到可安装的技能文件。".to_string());
    }
    if !out_dir.join(SKILL_MANIFEST_FILE_NAME).exists() {
        return Err("技能安装失败：目标目录缺少 SKILL.md。".to_string());
    }
    Ok(())
}

fn ccswitch_upsert_discovery_skill_row(
    conn: &Connection,
    directory: &str,
    name: &str,
    description: &str,
    repo_owner: &str,
    repo_name: &str,
    repo_branch: &str,
    readme_url: &str,
) -> CmdResult<()> {
    let existing = ccswitch_find_skill_by_directory(conn, directory)?;
    let now_ts = Local::now().timestamp();
    let display_name = if name.trim().is_empty() {
        directory.to_string()
    } else {
        name.trim().to_string()
    };
    let description_opt = if description.trim().is_empty() {
        None
    } else {
        Some(description.trim().to_string())
    };

    if let Some(row) = existing {
        let final_name = if display_name.trim().is_empty() {
            row.name
        } else {
            display_name
        };
        let final_description = if description_opt.is_some() {
            description_opt
        } else {
            row.description
        };
        conn.execute(
            "UPDATE skills
             SET name = ?1,
                 description = ?2,
                 directory = ?3,
                 repo_owner = ?4,
                 repo_name = ?5,
                 repo_branch = ?6,
                 readme_url = ?7,
                 enabled_claude = ?8,
                 enabled_codex = ?9,
                 enabled_gemini = ?10,
                 enabled_opencode = ?11,
                 installed_at = ?12
             WHERE id = ?13",
            params![
                final_name,
                final_description,
                directory,
                repo_owner,
                repo_name,
                repo_branch,
                readme_url,
                row.enabled_claude,
                true,
                row.enabled_gemini,
                true,
                if row.installed_at > 0 {
                    row.installed_at
                } else {
                    now_ts
                },
                row.id,
            ],
        )
        .map_err(|e| format!("更新发现技能 DB 记录失败: {e}"))?;
        return Ok(());
    }

    let new_id = ccswitch_generate_local_skill_id(conn, directory)?;
    conn.execute(
        "INSERT INTO skills
         (id, name, description, directory, repo_owner, repo_name, repo_branch, readme_url,
          enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, installed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 1, 0, 1, ?9)",
        params![
            new_id,
            display_name,
            description_opt,
            directory,
            repo_owner,
            repo_name,
            repo_branch,
            readme_url,
            now_ts,
        ],
    )
    .map_err(|e| format!("写入发现技能 DB 记录失败: {e}"))?;
    Ok(())
}

fn install_discovery_skill_internal(
    repo_owner: &str,
    repo_name: &str,
    repo_branch: &str,
    repo_directory: &str,
    local_directory: &str,
    readme_url: &str,
    name: &str,
    description: &str,
) -> CmdResult<SkillsCatalogView> {
    let owner = repo_owner.trim();
    let repo = repo_name.trim();
    let branch = repo_branch.trim();
    if owner.is_empty() || repo.is_empty() || branch.is_empty() {
        return Err("安装失败：repo_owner/repo_name/repo_branch 不能为空。".to_string());
    }

    let source_dir = repo_directory.trim().trim_matches('/').replace('\\', "/");
    let fallback_local_name = if local_directory.trim().is_empty() {
        if source_dir.is_empty() {
            repo.to_string()
        } else {
            Path::new(&source_dir)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(repo)
                .to_string()
        }
    } else {
        local_directory.trim().to_string()
    };
    let fallback_local_name = if fallback_local_name.trim().is_empty() {
        sanitize_local_skill_directory(name)
    } else {
        fallback_local_name
    };

    let effective_readme = if readme_url.trim().is_empty() {
        let doc_path = if source_dir.is_empty() {
            SKILL_MANIFEST_FILE_NAME.to_string()
        } else {
            format!("{source_dir}/{SKILL_MANIFEST_FILE_NAME}")
        };
        build_skill_doc_url(owner, repo, branch, &doc_path)
    } else {
        readme_url.trim().to_string()
    };

    ensure_ccswitch_ssot_seeded()?;

    let db_path = ccswitch_db_file()?;
    let mut preferred_dir: Option<String> = None;
    if db_path.exists() {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
        let _ = conn.busy_timeout(Duration::from_millis(1500));
        if ccswitch_db_has_skills_table(&conn)? {
            if let Some(row) = ccswitch_find_skill_by_readme(&conn, owner, repo, &effective_readme)?
            {
                if !row.directory.trim().is_empty() {
                    preferred_dir = Some(row.directory);
                }
            }
        }
    }

    let target_directory =
        choose_unique_skill_directory(&fallback_local_name, preferred_dir.as_deref())?;
    let payload = download_repo_tarball_bytes(owner, repo, branch)?;
    let install_token = format!(
        "{}-{}-{}",
        sanitize_local_skill_directory(owner),
        sanitize_local_skill_directory(repo),
        Local::now().timestamp_millis()
    );
    let stage_root = env::temp_dir().join(format!("codex-switch-skill-install-{install_token}"));
    let stage_skill_dir = stage_root.join(&target_directory);
    if path_exists_or_symlink(&stage_root) {
        let _ = remove_path_safe(&stage_root);
    }
    fs::create_dir_all(&stage_skill_dir)
        .map_err(|e| format!("创建安装临时目录失败 {}: {e}", stage_skill_dir.display()))?;
    extract_discovery_skill_from_tarball(&payload, &source_dir, &stage_skill_dir)?;

    let ssot_root = ccswitch_ssot_skills_dir()?;
    fs::create_dir_all(&ssot_root)
        .map_err(|e| format!("创建 Skills 中心目录失败 {}: {e}", ssot_root.display()))?;
    let target_skill_dir = ssot_root.join(&target_directory);
    if path_exists_or_symlink(&target_skill_dir) {
        remove_path_safe(&target_skill_dir)?;
    }
    if fs::rename(&stage_skill_dir, &target_skill_dir).is_err() {
        copy_dir_recursive(&stage_skill_dir, &target_skill_dir)?;
    }
    let _ = fs::remove_dir_all(&stage_root);

    sync_skill_to_target_dir(&target_directory, &codex_skills_dir()?)?;
    for root in opencode_skills_target_dirs()? {
        sync_skill_to_target_dir(&target_directory, &root)?;
    }

    if db_path.exists() {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
        let _ = conn.busy_timeout(Duration::from_millis(1500));
        if ccswitch_db_has_skills_table(&conn)? {
            ccswitch_upsert_discovery_skill_row(
                &conn,
                &target_directory,
                name,
                description,
                owner,
                repo,
                branch,
                &effective_readme,
            )?;
        }
    }

    load_skills_catalog_internal()
}

fn ccswitch_load_skill_repos(conn: &Connection) -> CmdResult<Vec<DiscoverSkillRepoView>> {
    let mut stmt = conn
        .prepare(
            "SELECT owner, name, branch, enabled FROM skill_repos ORDER BY owner ASC, name ASC",
        )
        .map_err(|e| format!("读取 CC Switch skill_repos 失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DiscoverSkillRepoView {
                owner: row.get(0)?,
                name: row.get(1)?,
                branch: row.get(2)?,
                enabled: row.get(3)?,
            })
        })
        .map_err(|e| format!("遍历 CC Switch skill_repos 失败: {e}"))?;
    let mut repos = Vec::new();
    for item in rows {
        repos.push(item.map_err(|e| format!("解析 CC Switch skill_repos 行失败: {e}"))?);
    }
    Ok(repos)
}

fn normalize_repo_segment(raw: &str) -> String {
    raw.trim()
        .trim_matches('/')
        .trim_matches('\\')
        .trim()
        .to_string()
}

fn parse_repo_input(raw: &str) -> CmdResult<(String, String)> {
    let text = raw.trim();
    if text.is_empty() {
        return Err("仓库 URL 不能为空。".to_string());
    }
    let normalized = text.replace('\\', "/");
    let path = if let Some(rest) = normalized.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = normalized.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = normalized.strip_prefix("github.com/") {
        rest
    } else {
        normalized.as_str()
    };

    let mut parts: Vec<&str> = path
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .collect();
    if parts.len() < 2 {
        return Err("仓库格式错误，请输入 owner/name 或 github 链接。".to_string());
    }
    let owner = normalize_repo_segment(parts[0]);
    let mut name = normalize_repo_segment(parts[1]);
    if name.ends_with(".git") {
        name = name.trim_end_matches(".git").to_string();
    }
    if owner.is_empty() || name.is_empty() {
        return Err("仓库格式错误，请输入 owner/name。".to_string());
    }
    parts.clear();
    Ok((owner, name))
}

fn normalize_repo_branch(raw: Option<&str>) -> String {
    let value = raw.unwrap_or("main").trim().to_string();
    if value.is_empty() {
        "main".to_string()
    } else {
        value
    }
}

fn load_skill_repos_manage_internal(refresh_count: bool) -> CmdResult<SkillRepoManageView> {
    let db_path = ccswitch_db_file()?;
    if !db_path.exists() {
        return Ok(SkillRepoManageView { repos: Vec::new() });
    }
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    if !ccswitch_db_has_skill_repos_table(&conn)? {
        return Ok(SkillRepoManageView { repos: Vec::new() });
    }
    ccswitch_ensure_skill_repo_cache_tables(&conn)?;

    let repos = ccswitch_load_skill_repos(&conn)?;
    let mut out: Vec<SkillRepoManageItemView> = Vec::new();
    for repo in repos {
        let mut skill_count =
            ccswitch_load_repo_cache_meta(&conn, &repo)?.map(|meta| meta.skill_count);
        if refresh_count && repo.enabled {
            match ccswitch_get_repo_discovery_skills(&conn, &repo, true, false) {
                Ok(skills) => {
                    skill_count = Some(skills.len());
                }
                Err(err) => {
                    eprintln!(
                        "仓库计数刷新失败 {}/{}@{}: {}",
                        repo.owner, repo.name, repo.branch, err
                    );
                }
            }
        }
        out.push(SkillRepoManageItemView {
            owner: repo.owner.clone(),
            name: repo.name.clone(),
            branch: repo.branch.clone(),
            enabled: repo.enabled,
            skill_count,
            repo_url: format!("https://github.com/{}/{}", repo.owner, repo.name),
        });
    }
    Ok(SkillRepoManageView { repos: out })
}

fn add_skill_repo_internal(
    repo_input: &str,
    branch: Option<&str>,
) -> CmdResult<SkillRepoManageView> {
    let (owner, name) = parse_repo_input(repo_input)?;
    let branch = normalize_repo_branch(branch);

    let db_path = ccswitch_db_file()?;
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建 CC Switch 目录失败 {}: {e}", parent.display()))?;
    }
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    ccswitch_ensure_skill_repos_table(&conn)?;
    ccswitch_ensure_skill_repo_cache_tables(&conn)?;
    conn.execute(
        "INSERT INTO skill_repos (owner, name, branch, enabled)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(owner, name)
         DO UPDATE SET branch = excluded.branch, enabled = 1",
        params![owner, name, branch],
    )
    .map_err(|e| format!("保存仓库失败: {e}"))?;

    load_skill_repos_manage_internal(false)
}

fn remove_skill_repo_internal(owner: &str, name: &str) -> CmdResult<SkillRepoManageView> {
    let owner = owner.trim();
    let name = name.trim();
    if owner.is_empty() || name.is_empty() {
        return Err("删除仓库失败：owner/name 不能为空。".to_string());
    }

    let db_path = ccswitch_db_file()?;
    if !db_path.exists() {
        return Ok(SkillRepoManageView { repos: Vec::new() });
    }
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    if !ccswitch_db_has_skill_repos_table(&conn)? {
        return Ok(SkillRepoManageView { repos: Vec::new() });
    }
    ccswitch_ensure_skill_repo_cache_tables(&conn)?;
    conn.execute(
        "DELETE FROM skill_repos WHERE lower(owner)=lower(?1) AND lower(name)=lower(?2)",
        params![owner, name],
    )
    .map_err(|e| format!("删除仓库失败: {e}"))?;
    ccswitch_remove_repo_cache(&conn, owner, name)?;

    load_skill_repos_manage_internal(false)
}

fn build_skill_doc_url(owner: &str, repo: &str, branch: &str, doc_path: &str) -> String {
    format!("https://github.com/{owner}/{repo}/blob/{branch}/{doc_path}")
}

fn fetch_repo_discovery_skills(
    repo: &DiscoverSkillRepoView,
) -> CmdResult<Vec<DiscoverSkillEntryView>> {
    let payload = download_repo_tarball_bytes(&repo.owner, &repo.name, &repo.branch)?;
    let decoder = GzDecoder::new(Cursor::new(payload));
    let mut archive = Archive::new(decoder);

    let mut seen_dirs: HashSet<String> = HashSet::new();
    let mut skills: Vec<DiscoverSkillEntryView> = Vec::new();

    let entries = archive
        .entries()
        .map_err(|e| format!("解析仓库归档失败 {}/{}: {e}", repo.owner, repo.name))?;
    for item in entries {
        let mut entry =
            item.map_err(|e| format!("读取仓库条目失败 {}/{}: {e}", repo.owner, repo.name))?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry
            .path()
            .map_err(|e| format!("读取仓库路径失败 {}/{}: {e}", repo.owner, repo.name))?;
        let member = path_to_posix(path.as_ref());
        if !member.ends_with("/SKILL.md") {
            continue;
        }
        let parts: Vec<&str> = member.split('/').collect();
        if parts.len() < 2 {
            continue;
        }
        let inner_parts = &parts[1..];
        if inner_parts.last().copied() != Some("SKILL.md") {
            continue;
        }
        let repo_directory = if inner_parts.len() > 1 {
            inner_parts[..inner_parts.len() - 1].join("/")
        } else {
            String::new()
        };
        let dedupe_key = repo_directory.to_lowercase();
        if !seen_dirs.insert(dedupe_key) {
            continue;
        }

        let fallback = if repo_directory.is_empty() {
            repo.name.clone()
        } else {
            Path::new(&repo_directory)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("skill")
                .to_string()
        };
        let local_directory = sanitize_local_skill_directory(&fallback);

        let mut bytes: Vec<u8> = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取 SKILL.md 失败 {}/{}: {e}", repo.owner, repo.name))?;
        let manifest = String::from_utf8_lossy(&bytes);
        let (name, description) = parse_skill_manifest_text(&manifest, &fallback);

        let doc_path = if repo_directory.is_empty() {
            "SKILL.md".to_string()
        } else {
            format!("{repo_directory}/SKILL.md")
        };
        let readme_url = build_skill_doc_url(&repo.owner, &repo.name, &repo.branch, &doc_path);

        let mut id = normalize_skill_id(&format!(
            "{}-{}-{}",
            repo.owner,
            repo.name,
            if repo_directory.is_empty() {
                "__root__".to_string()
            } else {
                repo_directory.clone()
            }
        ));
        if id.is_empty() {
            id = normalize_skill_id(&format!("{}-{}-skill", repo.owner, repo.name));
        }
        if id.is_empty() {
            continue;
        }

        skills.push(DiscoverSkillEntryView {
            id,
            name,
            description,
            directory: local_directory,
            repo_directory,
            repo_owner: repo.owner.clone(),
            repo_name: repo.name.clone(),
            repo_branch: repo.branch.clone(),
            readme_url,
            installed: false,
        });
    }

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(skills)
}

fn ccswitch_get_repo_discovery_skills(
    conn: &Connection,
    repo: &DiscoverSkillRepoView,
    sync_remote: bool,
    force_refresh: bool,
) -> CmdResult<Vec<DiscoverSkillEntryView>> {
    let cached_skills = ccswitch_load_repo_cached_skills(conn, repo)?;
    let cached_meta = ccswitch_load_repo_cache_meta(conn, repo)?;
    if !sync_remote {
        return Ok(cached_skills);
    }

    let now_ts = Local::now().timestamp();
    let should_skip_compare = !force_refresh
        && cached_meta
            .as_ref()
            .map(|meta| {
                meta.checked_at > 0
                    && (now_ts - meta.checked_at) < SKILL_DISCOVERY_COMPARE_MIN_INTERVAL_SECS
            })
            .unwrap_or(false);
    if should_skip_compare {
        return Ok(cached_skills);
    }

    let head_sha = match fetch_repo_branch_head_sha(repo) {
        Ok(sha) => Some(sha),
        Err(err) => {
            eprintln!(
                "仓库 HEAD 比对失败 {}/{}@{}: {}",
                repo.owner, repo.name, repo.branch, err
            );
            None
        }
    };

    let should_fetch_tarball = if force_refresh {
        true
    } else {
        match (head_sha.as_deref(), cached_meta.as_ref()) {
            (Some(sha), Some(meta)) => {
                meta.head_sha.as_deref() != Some(sha)
                    || meta.skill_count != cached_skills.len()
                    || cached_skills.is_empty()
            }
            (Some(_), None) => true,
            (None, _) => cached_skills.is_empty(),
        }
    };

    if !should_fetch_tarball {
        ccswitch_touch_repo_cache_checked(conn, repo, head_sha.as_deref(), cached_skills.len())?;
        return Ok(cached_skills);
    }

    match fetch_repo_discovery_skills(repo) {
        Ok(fresh) => {
            ccswitch_replace_repo_cache(conn, repo, head_sha.as_deref(), &fresh)?;
            Ok(fresh)
        }
        Err(err) => {
            eprintln!(
                "仓库技能增量同步失败 {}/{}@{}: {}",
                repo.owner, repo.name, repo.branch, err
            );
            if !cached_skills.is_empty() {
                let _ = ccswitch_touch_repo_cache_checked(
                    conn,
                    repo,
                    head_sha.as_deref(),
                    cached_skills.len(),
                );
                Ok(cached_skills)
            } else {
                Err(err)
            }
        }
    }
}

fn load_skills_discovery_internal(sync_remote: bool) -> CmdResult<SkillsDiscoveryView> {
    ensure_ccswitch_ssot_seeded()?;
    let installed_directories: HashSet<String> = load_skills_catalog_internal()
        .map(|catalog| {
            catalog
                .skills
                .into_iter()
                .map(|skill| skill.directory.to_lowercase())
                .collect()
        })
        .unwrap_or_default();

    let db_path = ccswitch_db_file()?;
    if !db_path.exists() {
        return Ok(SkillsDiscoveryView {
            total: 0,
            repos: Vec::new(),
            skills: Vec::new(),
        });
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    ccswitch_ensure_skill_repo_cache_tables(&conn)?;

    let repos = ccswitch_load_skill_repos(&conn)?;
    let installed_readmes = if ccswitch_db_has_skills_table(&conn)? {
        ccswitch_load_installed_readme_urls(&conn)?
    } else {
        HashSet::new()
    };
    let mut all_skills: Vec<DiscoverSkillEntryView> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for repo in repos.iter().filter(|repo| repo.enabled) {
        match ccswitch_get_repo_discovery_skills(&conn, repo, sync_remote, false) {
            Ok(skills) => {
                for mut item in skills {
                    item.installed = installed_readmes.contains(&item.readme_url.to_lowercase())
                        || installed_directories.contains(&item.directory.to_lowercase());
                    let key = format!(
                        "{}|{}|{}",
                        item.repo_owner.to_lowercase(),
                        item.repo_name.to_lowercase(),
                        item.repo_directory.to_lowercase()
                    );
                    if seen.insert(key) {
                        all_skills.push(item);
                    }
                }
            }
            Err(err) => {
                eprintln!(
                    "发现技能读取失败 {}/{}@{}: {}",
                    repo.owner, repo.name, repo.branch, err
                );
            }
        }
    }

    all_skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(SkillsDiscoveryView {
        total: all_skills.len(),
        repos,
        skills: all_skills,
    })
}

fn sync_skills_to_ccswitch_db(skills: &[SkillEntryView]) -> CmdResult<()> {
    let db_path = ccswitch_db_file()?;
    if !db_path.exists() {
        return Ok(());
    }
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    if !ccswitch_db_has_skills_table(&conn)? {
        return Ok(());
    }
    for skill in skills {
        ccswitch_upsert_skill_row(&conn, skill)?;
    }
    Ok(())
}

fn load_skills_catalog_internal() -> CmdResult<SkillsCatalogView> {
    ensure_ccswitch_ssot_seeded()?;
    let target_flags = ccswitch_load_skill_target_flags_map()?;

    let mut merged: BTreeMap<String, SkillScanEntry> = BTreeMap::new();
    scan_skill_root(
        &ccswitch_ssot_skills_dir()?,
        SkillScanSource::Ssot,
        &mut merged,
    )?;
    scan_skill_root(&codex_skills_dir()?, SkillScanSource::Codex, &mut merged)?;
    scan_skill_root(
        &opencode_skills_dir()?,
        SkillScanSource::OpenCode,
        &mut merged,
    )?;
    scan_skill_root(
        &opencode_legacy_skills_dir()?,
        SkillScanSource::OpenCodeLegacy,
        &mut merged,
    )?;

    let mut skills: Vec<SkillEntryView> = merged
        .into_values()
        .map(|mut entry| {
            let opencode_present = entry.opencode_source || entry.opencode_legacy_source;
            let flags = target_flags.get(&entry.directory.to_lowercase());
            let claude_enabled = flags.map(|item| item.claude_enabled).unwrap_or(false);
            let codex_enabled = flags
                .map(|item| item.codex_enabled)
                .unwrap_or(entry.codex_source);
            let gemini_enabled = flags.map(|item| item.gemini_enabled).unwrap_or(false);
            let opencode_enabled = flags
                .map(|item| item.opencode_enabled)
                .unwrap_or(opencode_present);
            let has_source = entry.ssot_source || entry.codex_source || opencode_present;
            let source = skill_source_label(&entry);
            entry.locations.sort();
            entry.locations.dedup();
            SkillEntryView {
                id: entry.id,
                directory: entry.directory,
                name: entry.name,
                description: entry.description,
                claude_enabled,
                codex_enabled,
                gemini_enabled,
                opencode_enabled,
                codex_available: has_source,
                opencode_available: has_source,
                source,
                locations: entry.locations,
            }
        })
        .collect();

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let claude_enabled_count = skills.iter().filter(|s| s.claude_enabled).count();
    let codex_enabled_count = skills.iter().filter(|s| s.codex_enabled).count();
    let gemini_enabled_count = skills.iter().filter(|s| s.gemini_enabled).count();
    let opencode_enabled_count = skills.iter().filter(|s| s.opencode_enabled).count();
    let total = skills.len();

    let catalog = SkillsCatalogView {
        total,
        claude_enabled_count,
        codex_enabled_count,
        gemini_enabled_count,
        opencode_enabled_count,
        skills,
    };

    sync_skills_to_ccswitch_db(&catalog.skills)?;

    Ok(catalog)
}

fn set_skill_targets_internal(
    skill_id: &str,
    claude: Option<bool>,
    codex: bool,
    gemini: Option<bool>,
    opencode: bool,
) -> CmdResult<SkillsCatalogView> {
    let key_raw = skill_id.trim();
    if key_raw.is_empty() {
        return Err("skillId 不能为空。".to_string());
    }

    let normalized = normalize_skill_id(key_raw);
    let catalog = load_skills_catalog_internal()?;
    let skill = catalog
        .skills
        .into_iter()
        .find(|item| {
            item.id.eq_ignore_ascii_case(key_raw)
                || item.directory.eq_ignore_ascii_case(key_raw)
                || (!normalized.is_empty() && item.id.eq_ignore_ascii_case(&normalized))
        })
        .ok_or_else(|| format!("未找到 Skill: {key_raw}"))?;

    ensure_skill_in_ssot(&skill.directory)?;

    if codex {
        sync_skill_to_target_dir(&skill.directory, &codex_skills_dir()?)?;
    } else {
        remove_skill_from_target_dir(&skill.directory, &codex_skills_dir()?)?;
    }

    for root in opencode_skills_target_dirs()? {
        if opencode {
            sync_skill_to_target_dir(&skill.directory, &root)?;
        } else {
            remove_skill_from_target_dir(&skill.directory, &root)?;
        }
    }

    let mut updated_skill = skill.clone();
    updated_skill.claude_enabled = claude.unwrap_or(skill.claude_enabled);
    updated_skill.codex_enabled = codex;
    updated_skill.gemini_enabled = gemini.unwrap_or(skill.gemini_enabled);
    updated_skill.opencode_enabled = opencode;
    sync_skills_to_ccswitch_db(&[updated_skill])?;

    load_skills_catalog_internal()
}

fn delete_skill_internal(skill_id: &str) -> CmdResult<SkillsCatalogView> {
    let key_raw = skill_id.trim();
    if key_raw.is_empty() {
        return Err("skillId 不能为空。".to_string());
    }

    let normalized = normalize_skill_id(key_raw);
    let catalog = load_skills_catalog_internal()?;
    let skill = catalog
        .skills
        .into_iter()
        .find(|item| {
            item.id.eq_ignore_ascii_case(key_raw)
                || item.directory.eq_ignore_ascii_case(key_raw)
                || (!normalized.is_empty() && item.id.eq_ignore_ascii_case(&normalized))
        })
        .ok_or_else(|| format!("未找到 Skill: {key_raw}"))?;

    let directory = skill.directory.clone();

    let _ = remove_skill_from_target_dir(&directory, &codex_skills_dir()?);
    for root in opencode_skills_target_dirs()? {
        let _ = remove_skill_from_target_dir(&directory, &root);
    }

    let ssot_dir = ccswitch_ssot_skills_dir()?.join(&directory);
    let _ = remove_path_safe(&ssot_dir);
    let legacy_dir = legacy_switcher_skills_dir()?.join(&directory);
    let _ = remove_path_safe(&legacy_dir);

    let db_path = ccswitch_db_file()?;
    if db_path.exists() {
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
        let _ = conn.busy_timeout(Duration::from_millis(1500));
        if ccswitch_db_has_skills_table(&conn)? {
            conn.execute(
                "DELETE FROM skills WHERE lower(directory)=lower(?1)",
                params![directory],
            )
            .map_err(|e| format!("删除 CC Switch skill 记录失败: {e}"))?;
        }
    }

    load_skills_catalog_internal()
}

