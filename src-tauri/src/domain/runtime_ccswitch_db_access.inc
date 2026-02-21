fn ccswitch_find_skill_by_directory(
    conn: &Connection,
    directory: &str,
) -> CmdResult<Option<CcSwitchSkillDbRow>> {
    conn.query_row(
        "SELECT id, directory, name, description, repo_owner, repo_name, repo_branch, readme_url,
                enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, installed_at
         FROM skills
         WHERE lower(directory)=lower(?1)
         ORDER BY installed_at DESC
         LIMIT 1",
        params![directory],
        |row| {
            Ok(CcSwitchSkillDbRow {
                id: row.get(0)?,
                directory: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                repo_owner: row.get(4)?,
                repo_name: row.get(5)?,
                repo_branch: row.get(6)?,
                readme_url: row.get(7)?,
                enabled_claude: row.get(8)?,
                enabled_codex: row.get(9)?,
                enabled_gemini: row.get(10)?,
                enabled_opencode: row.get(11)?,
                installed_at: row.get(12)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("查询 CC Switch skill 记录失败: {e}"))
}

fn ccswitch_find_skill_by_readme(
    conn: &Connection,
    repo_owner: &str,
    repo_name: &str,
    readme_url: &str,
) -> CmdResult<Option<CcSwitchSkillDbRow>> {
    conn.query_row(
        "SELECT id, directory, name, description, repo_owner, repo_name, repo_branch, readme_url,
                enabled_claude, enabled_codex, enabled_gemini, enabled_opencode, installed_at
         FROM skills
         WHERE lower(repo_owner)=lower(?1)
           AND lower(repo_name)=lower(?2)
           AND lower(readme_url)=lower(?3)
         ORDER BY installed_at DESC
         LIMIT 1",
        params![repo_owner, repo_name, readme_url],
        |row| {
            Ok(CcSwitchSkillDbRow {
                id: row.get(0)?,
                directory: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                repo_owner: row.get(4)?,
                repo_name: row.get(5)?,
                repo_branch: row.get(6)?,
                readme_url: row.get(7)?,
                enabled_claude: row.get(8)?,
                enabled_codex: row.get(9)?,
                enabled_gemini: row.get(10)?,
                enabled_opencode: row.get(11)?,
                installed_at: row.get(12)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("查询 CC Switch readme skill 记录失败: {e}"))
}

fn ccswitch_load_installed_readme_urls(conn: &Connection) -> CmdResult<HashSet<String>> {
    let mut stmt = conn
        .prepare(
            "SELECT lower(readme_url) FROM skills
             WHERE readme_url IS NOT NULL AND trim(readme_url) <> ''",
        )
        .map_err(|e| format!("读取 CC Switch readme 列失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("遍历 CC Switch readme 列失败: {e}"))?;
    let mut out = HashSet::new();
    for item in rows {
        let value = item.map_err(|e| format!("解析 CC Switch readme 值失败: {e}"))?;
        if !value.trim().is_empty() {
            out.insert(value);
        }
    }
    Ok(out)
}

fn ccswitch_load_skill_target_flags_map() -> CmdResult<HashMap<String, CcSwitchSkillTargetFlags>> {
    let db_path = ccswitch_db_file()?;
    if !db_path.exists() {
        return Ok(HashMap::new());
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    if !ccswitch_db_has_skills_table(&conn)? {
        return Ok(HashMap::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT directory, enabled_claude, enabled_codex, enabled_gemini, enabled_opencode
             FROM skills
             WHERE directory IS NOT NULL AND trim(directory) <> ''
             ORDER BY installed_at DESC",
        )
        .map_err(|e| format!("读取 CC Switch skills 开关状态失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, bool>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })
        .map_err(|e| format!("遍历 CC Switch skills 开关状态失败: {e}"))?;

    let mut out: HashMap<String, CcSwitchSkillTargetFlags> = HashMap::new();
    for item in rows {
        let (directory, claude_enabled, codex_enabled, gemini_enabled, opencode_enabled) =
            item.map_err(|e| format!("解析 CC Switch skills 开关状态失败: {e}"))?;
        let key = directory.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        out.entry(key).or_insert(CcSwitchSkillTargetFlags {
            claude_enabled,
            codex_enabled,
            gemini_enabled,
            opencode_enabled,
        });
    }
    Ok(out)
}

fn ccswitch_load_mcp_app_flags_map() -> CmdResult<HashMap<String, CcSwitchMcpAppFlags>> {
    let db_path = ccswitch_db_file()?;
    if !db_path.exists() {
        return Ok(HashMap::new());
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    if !ccswitch_db_has_mcp_servers_table(&conn)? {
        return Ok(HashMap::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT id, enabled_claude, enabled_gemini
             FROM mcp_servers
             WHERE id IS NOT NULL AND trim(id) <> ''",
        )
        .map_err(|e| format!("读取 CC Switch MCP 应用开关状态失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, bool>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .map_err(|e| format!("遍历 CC Switch MCP 应用开关状态失败: {e}"))?;

    let mut out: HashMap<String, CcSwitchMcpAppFlags> = HashMap::new();
    for item in rows {
        let (id, claude_enabled, gemini_enabled) =
            item.map_err(|e| format!("解析 CC Switch MCP 应用开关状态失败: {e}"))?;
        let key = id.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        out.entry(key).or_insert(CcSwitchMcpAppFlags {
            claude_enabled,
            gemini_enabled,
        });
    }
    Ok(out)
}

fn ccswitch_upsert_mcp_targets_row(
    server_id: &str,
    claude_enabled: Option<bool>,
    codex_enabled: bool,
    gemini_enabled: Option<bool>,
    opencode_enabled: bool,
    codex_spec: Option<&Value>,
) -> CmdResult<()> {
    let id = server_id.trim();
    if id.is_empty() {
        return Ok(());
    }

    let db_path = ccswitch_db_file()?;
    if !db_path.exists() {
        return Ok(());
    }
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    if !ccswitch_db_has_mcp_servers_table(&conn)? {
        return Ok(());
    }

    let server_config = codex_spec
        .and_then(|spec| serde_json::to_string(spec).ok())
        .unwrap_or_else(|| "{}".to_string());

    let updated = conn
        .execute(
            "UPDATE mcp_servers
             SET enabled_claude = COALESCE(?2, enabled_claude),
                 enabled_codex = ?3,
                 enabled_gemini = COALESCE(?4, enabled_gemini),
                 enabled_opencode = ?5
             WHERE lower(id)=lower(?1)",
            params![
                id,
                claude_enabled,
                codex_enabled,
                gemini_enabled,
                opencode_enabled
            ],
        )
        .map_err(|e| format!("更新 CC Switch MCP 开关失败 ({id}): {e}"))?;
    if updated > 0 {
        return Ok(());
    }

    conn.execute(
        "INSERT INTO mcp_servers
         (id, name, server_config, description, homepage, docs, tags,
          enabled_claude, enabled_codex, enabled_gemini, enabled_opencode)
         VALUES (?1, ?2, ?3, NULL, NULL, NULL, '[]', ?4, ?5, ?6, ?7)",
        params![
            id,
            id,
            server_config,
            claude_enabled.unwrap_or(false),
            codex_enabled,
            gemini_enabled.unwrap_or(false),
            opencode_enabled
        ],
    )
    .map_err(|e| format!("写入 CC Switch MCP 记录失败 ({id}): {e}"))?;
    Ok(())
}

fn ccswitch_delete_mcp_row(server_id: &str) -> CmdResult<()> {
    let id = server_id.trim();
    if id.is_empty() {
        return Ok(());
    }

    let db_path = ccswitch_db_file()?;
    if !db_path.exists() {
        return Ok(());
    }
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("打开 CC Switch 数据库失败 ({}): {e}", db_path.display()))?;
    let _ = conn.busy_timeout(Duration::from_millis(1500));
    if !ccswitch_db_has_mcp_servers_table(&conn)? {
        return Ok(());
    }

    conn.execute(
        "DELETE FROM mcp_servers WHERE lower(id)=lower(?1)",
        params![id],
    )
    .map_err(|e| format!("删除 CC Switch MCP 记录失败 ({id}): {e}"))?;
    Ok(())
}

