fn ccswitch_load_repo_cache_meta(
    conn: &Connection,
    repo: &DiscoverSkillRepoView,
) -> CmdResult<Option<SkillRepoCacheMeta>> {
    conn.query_row(
        "SELECT head_sha, skill_count, checked_at
         FROM skill_repo_cache
         WHERE owner = ?1 AND name = ?2 AND branch = ?3
         LIMIT 1",
        params![repo.owner, repo.name, repo.branch],
        |row| {
            let skill_count_raw: i64 = row.get(1)?;
            Ok(SkillRepoCacheMeta {
                head_sha: row.get(0)?,
                skill_count: if skill_count_raw < 0 {
                    0
                } else {
                    skill_count_raw as usize
                },
                checked_at: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("读取仓库缓存元数据失败 {}/{}: {e}", repo.owner, repo.name))
}

fn ccswitch_touch_repo_cache_checked(
    conn: &Connection,
    repo: &DiscoverSkillRepoView,
    head_sha: Option<&str>,
    skill_count: usize,
) -> CmdResult<()> {
    let now_ts = Local::now().timestamp();
    conn.execute(
        "INSERT INTO skill_repo_cache (owner, name, branch, head_sha, skill_count, checked_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(owner, name, branch)
         DO UPDATE SET
             head_sha = COALESCE(excluded.head_sha, skill_repo_cache.head_sha),
             skill_count = excluded.skill_count,
             checked_at = excluded.checked_at",
        params![
            repo.owner,
            repo.name,
            repo.branch,
            head_sha.map(|v| v.to_string()),
            skill_count as i64,
            now_ts,
            now_ts,
        ],
    )
    .map_err(|e| format!("更新仓库缓存检测时间失败 {}/{}: {e}", repo.owner, repo.name))?;
    Ok(())
}

fn ccswitch_replace_repo_cache(
    conn: &Connection,
    repo: &DiscoverSkillRepoView,
    head_sha: Option<&str>,
    skills: &[DiscoverSkillEntryView],
) -> CmdResult<()> {
    let now_ts = Local::now().timestamp();
    let mut keep_dirs: HashSet<String> = HashSet::new();
    for skill in skills {
        keep_dirs.insert(skill.repo_directory.to_lowercase());
        conn.execute(
            "INSERT INTO skill_repo_skill_cache
             (owner, name, branch, repo_directory, local_directory, skill_id, skill_name, skill_description, readme_url, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(owner, name, branch, repo_directory)
             DO UPDATE SET
                 local_directory = excluded.local_directory,
                 skill_id = excluded.skill_id,
                 skill_name = excluded.skill_name,
                 skill_description = excluded.skill_description,
                 readme_url = excluded.readme_url,
                 updated_at = excluded.updated_at",
            params![
                repo.owner,
                repo.name,
                repo.branch,
                skill.repo_directory,
                skill.directory,
                skill.id,
                skill.name,
                skill.description,
                skill.readme_url,
                now_ts,
            ],
        )
        .map_err(|e| format!("写入仓库技能缓存失败 {}/{}: {e}", repo.owner, repo.name))?;
    }

    let mut stmt = conn
        .prepare(
            "SELECT repo_directory
             FROM skill_repo_skill_cache
             WHERE owner = ?1 AND name = ?2 AND branch = ?3",
        )
        .map_err(|e| format!("读取仓库技能缓存目录失败 {}/{}: {e}", repo.owner, repo.name))?;
    let rows = stmt
        .query_map(params![repo.owner, repo.name, repo.branch], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("遍历仓库技能缓存目录失败 {}/{}: {e}", repo.owner, repo.name))?;
    let mut stale_dirs: Vec<String> = Vec::new();
    for item in rows {
        let old_dir = item
            .map_err(|e| format!("解析仓库技能缓存目录失败 {}/{}: {e}", repo.owner, repo.name))?;
        if !keep_dirs.contains(&old_dir.to_lowercase()) {
            stale_dirs.push(old_dir);
        }
    }
    for stale in stale_dirs {
        conn.execute(
            "DELETE FROM skill_repo_skill_cache
             WHERE owner = ?1 AND name = ?2 AND branch = ?3 AND repo_directory = ?4",
            params![repo.owner, repo.name, repo.branch, stale],
        )
        .map_err(|e| format!("删除仓库过期技能缓存失败 {}/{}: {e}", repo.owner, repo.name))?;
    }

    conn.execute(
        "INSERT INTO skill_repo_cache (owner, name, branch, head_sha, skill_count, checked_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(owner, name, branch)
         DO UPDATE SET
             head_sha = excluded.head_sha,
             skill_count = excluded.skill_count,
             checked_at = excluded.checked_at,
             updated_at = excluded.updated_at",
        params![
            repo.owner,
            repo.name,
            repo.branch,
            head_sha.map(|v| v.to_string()),
            skills.len() as i64,
            now_ts,
            now_ts,
        ],
    )
    .map_err(|e| format!("写入仓库缓存元数据失败 {}/{}: {e}", repo.owner, repo.name))?;
    Ok(())
}

fn ccswitch_load_repo_cached_skills(
    conn: &Connection,
    repo: &DiscoverSkillRepoView,
) -> CmdResult<Vec<DiscoverSkillEntryView>> {
    let mut stmt = conn
        .prepare(
            "SELECT skill_id, skill_name, skill_description, local_directory, repo_directory, readme_url
             FROM skill_repo_skill_cache
             WHERE owner = ?1 AND name = ?2 AND branch = ?3
             ORDER BY lower(skill_name) ASC",
        )
        .map_err(|e| format!("读取仓库技能缓存失败 {}/{}: {e}", repo.owner, repo.name))?;
    let rows = stmt
        .query_map(params![repo.owner, repo.name, repo.branch], |row| {
            Ok(DiscoverSkillEntryView {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                directory: row.get(3)?,
                repo_directory: row.get(4)?,
                repo_owner: repo.owner.clone(),
                repo_name: repo.name.clone(),
                repo_branch: repo.branch.clone(),
                readme_url: row.get(5)?,
                installed: false,
            })
        })
        .map_err(|e| format!("遍历仓库技能缓存失败 {}/{}: {e}", repo.owner, repo.name))?;
    let mut out = Vec::new();
    for item in rows {
        out.push(
            item.map_err(|e| format!("解析仓库技能缓存行失败 {}/{}: {e}", repo.owner, repo.name))?,
        );
    }
    Ok(out)
}

fn ccswitch_remove_repo_cache(conn: &Connection, owner: &str, name: &str) -> CmdResult<()> {
    conn.execute(
        "DELETE FROM skill_repo_skill_cache WHERE lower(owner)=lower(?1) AND lower(name)=lower(?2)",
        params![owner, name],
    )
    .map_err(|e| format!("删除仓库技能缓存失败 {owner}/{name}: {e}"))?;
    conn.execute(
        "DELETE FROM skill_repo_cache WHERE lower(owner)=lower(?1) AND lower(name)=lower(?2)",
        params![owner, name],
    )
    .map_err(|e| format!("删除仓库缓存元数据失败 {owner}/{name}: {e}"))?;
    Ok(())
}
