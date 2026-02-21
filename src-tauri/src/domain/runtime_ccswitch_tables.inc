fn ccswitch_db_has_skills_table(conn: &Connection) -> CmdResult<bool> {
    let exists = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='skills'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("读取 CC Switch skills 表失败: {e}"))?;
    Ok(exists > 0)
}

fn ccswitch_db_has_mcp_servers_table(conn: &Connection) -> CmdResult<bool> {
    let exists = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='mcp_servers'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("读取 CC Switch mcp_servers 表失败: {e}"))?;
    Ok(exists > 0)
}

fn ccswitch_db_has_skill_repos_table(conn: &Connection) -> CmdResult<bool> {
    let exists = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='skill_repos'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("读取 CC Switch skill_repos 表失败: {e}"))?;
    Ok(exists > 0)
}

fn ccswitch_ensure_skill_repos_table(conn: &Connection) -> CmdResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS skill_repos (
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            branch TEXT NOT NULL DEFAULT 'main',
            enabled BOOLEAN NOT NULL DEFAULT 1,
            PRIMARY KEY (owner, name)
        )",
        [],
    )
    .map_err(|e| format!("创建 CC Switch skill_repos 表失败: {e}"))?;
    Ok(())
}

fn ccswitch_ensure_skill_repo_cache_tables(conn: &Connection) -> CmdResult<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS skill_repo_cache (
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            branch TEXT NOT NULL,
            head_sha TEXT,
            skill_count INTEGER NOT NULL DEFAULT 0,
            checked_at INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (owner, name, branch)
        )",
        [],
    )
    .map_err(|e| format!("创建 CC Switch skill_repo_cache 表失败: {e}"))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS skill_repo_skill_cache (
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            branch TEXT NOT NULL,
            repo_directory TEXT NOT NULL,
            local_directory TEXT NOT NULL,
            skill_id TEXT NOT NULL,
            skill_name TEXT NOT NULL,
            skill_description TEXT NOT NULL,
            readme_url TEXT NOT NULL,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (owner, name, branch, repo_directory)
        )",
        [],
    )
    .map_err(|e| format!("创建 CC Switch skill_repo_skill_cache 表失败: {e}"))?;
    Ok(())
}
