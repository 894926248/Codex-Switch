fn mcp_read_opencode_config_root() -> CmdResult<Value> {
    let path = mcp_opencode_config_file()?;
    if !path.exists() {
        return Ok(json!({ "$schema": OPENCODE_CONFIG_SCHEMA_URL }));
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("读取 OpenCode 配置失败 ({}): {e}", path.display()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    if text.trim().is_empty() {
        return Ok(json!({ "$schema": OPENCODE_CONFIG_SCHEMA_URL }));
    }
    serde_json::from_str::<Value>(text)
        .map_err(|e| format!("解析 OpenCode 配置失败 ({}): {e}", path.display()))
}

fn mcp_write_opencode_config_root(root: &Value) -> CmdResult<()> {
    let path = mcp_opencode_config_file()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建 OpenCode 配置目录失败 ({}): {e}", parent.display()))?;
    }
    let text =
        serde_json::to_string_pretty(root).map_err(|e| format!("序列化 OpenCode 配置失败: {e}"))?;
    fs::write(&path, format!("{text}\n"))
        .map_err(|e| format!("写入 OpenCode 配置失败 ({}): {e}", path.display()))
}

fn mcp_parse_toml_document(text: &str) -> CmdResult<TomlEditDocument> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim().is_empty() {
        return Ok(TomlEditDocument::new());
    }
    text.parse::<TomlEditDocument>()
        .map_err(|e| format!("解析 Codex 配置失败: {e}"))
}

fn mcp_toml_value_to_json(value: &TomlEditValue) -> Value {
    if let Some(v) = value.as_bool() {
        return Value::Bool(v);
    }
    if let Some(v) = value.as_integer() {
        return Value::Number(v.into());
    }
    if let Some(v) = value.as_float() {
        return serde_json::Number::from_f64(v)
            .map(Value::Number)
            .unwrap_or(Value::Null);
    }
    if let Some(v) = value.as_str() {
        return Value::String(v.to_string());
    }
    if let Some(v) = value.as_datetime() {
        return Value::String(v.to_string());
    }
    if let Some(arr) = value.as_array() {
        return Value::Array(arr.iter().map(mcp_toml_value_to_json).collect());
    }
    if let Some(tbl) = value.as_inline_table() {
        let mut out = Map::new();
        for (k, v) in tbl.iter() {
            out.insert(k.to_string(), mcp_toml_value_to_json(v));
        }
        return Value::Object(out);
    }
    Value::String(value.to_string())
}

fn mcp_toml_table_to_json(table: &TomlEditTable) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, item) in table.iter() {
        if let Some(v) = mcp_toml_item_to_json(item) {
            out.insert(k.to_string(), v);
        }
    }
    out
}

fn mcp_toml_item_to_json(item: &TomlEditItem) -> Option<Value> {
    match item {
        TomlEditItem::None => None,
        TomlEditItem::Value(v) => Some(mcp_toml_value_to_json(v)),
        TomlEditItem::Table(t) => Some(Value::Object(mcp_toml_table_to_json(t))),
        TomlEditItem::ArrayOfTables(arr) => Some(Value::Array(
            arr.iter()
                .map(|table| Value::Object(mcp_toml_table_to_json(table)))
                .collect(),
        )),
    }
}

fn mcp_toml_item_to_object(item: &TomlEditItem) -> Option<Map<String, Value>> {
    if let Some(table) = item.as_table() {
        return Some(mcp_toml_table_to_json(table));
    }
    if let Some(value) = item.as_value() {
        if let Some(inline) = value.as_inline_table() {
            let mut out = Map::new();
            for (k, v) in inline.iter() {
                out.insert(k.to_string(), mcp_toml_value_to_json(v));
            }
            return Some(out);
        }
    }
    None
}

fn mcp_collect_codex_servers_from_table(
    table: &TomlEditTable,
    out: &mut BTreeMap<String, Value>,
    override_existing: bool,
) {
    for (server_id, item) in table.iter() {
        let id = server_id.trim();
        if id.is_empty() {
            continue;
        }
        if !override_existing && out.contains_key(id) {
            continue;
        }
        if let Some(obj) = mcp_toml_item_to_object(item) {
            out.insert(id.to_string(), Value::Object(obj));
        }
    }
}

fn read_codex_mcp_servers() -> CmdResult<BTreeMap<String, Value>> {
    let path = codex_home()?.join(CONFIG_FILE_NAME);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("读取 Codex 配置失败 ({}): {e}", path.display()))?;
    let doc = mcp_parse_toml_document(&text)?;
    let mut servers: BTreeMap<String, Value> = BTreeMap::new();

    if let Some(table) = doc.get("mcp_servers").and_then(TomlEditItem::as_table) {
        mcp_collect_codex_servers_from_table(table, &mut servers, true);
    }

    if let Some(mcp_table) = doc.get("mcp").and_then(TomlEditItem::as_table) {
        if let Some(legacy_servers) = mcp_table.get("servers").and_then(TomlEditItem::as_table) {
            mcp_collect_codex_servers_from_table(legacy_servers, &mut servers, false);
        }
    }

    Ok(servers)
}

fn mcp_json_value_to_toml_value(value: &Value) -> CmdResult<TomlEditValue> {
    match value {
        Value::Null => Err("MCP 配置不支持 null。".to_string()),
        Value::Bool(v) => Ok(TomlEditValue::from(*v)),
        Value::Number(v) => {
            if let Some(i) = v.as_i64() {
                return Ok(TomlEditValue::from(i));
            }
            if let Some(u) = v.as_u64() {
                if u <= i64::MAX as u64 {
                    return Ok(TomlEditValue::from(u as i64));
                }
                return Ok(TomlEditValue::from(u as f64));
            }
            if let Some(f) = v.as_f64() {
                return Ok(TomlEditValue::from(f));
            }
            Err("MCP 数字字段格式无效。".to_string())
        }
        Value::String(v) => Ok(TomlEditValue::from(v.as_str())),
        Value::Array(values) => {
            let mut arr = TomlEditArray::new();
            for item in values {
                arr.push(mcp_json_value_to_toml_value(item)?);
            }
            Ok(TomlEditValue::Array(arr))
        }
        Value::Object(values) => {
            let mut table = TomlEditInlineTable::new();
            for (k, v) in values {
                table.insert(k, mcp_json_value_to_toml_value(v)?);
            }
            Ok(TomlEditValue::InlineTable(table))
        }
    }
}

fn mcp_json_value_to_toml_item(value: &Value) -> CmdResult<TomlEditItem> {
    Ok(TomlEditItem::Value(mcp_json_value_to_toml_value(value)?))
}

fn mcp_json_object_to_server_table(obj: &Map<String, Value>) -> CmdResult<TomlEditTable> {
    let mut table = TomlEditTable::new();
    table.set_implicit(false);
    for (k, v) in obj {
        table.insert(k, mcp_json_value_to_toml_item(v)?);
    }
    Ok(table)
}

fn write_codex_mcp_servers(servers: &BTreeMap<String, Value>) -> CmdResult<()> {
    let path = codex_home()?.join(CONFIG_FILE_NAME);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建 Codex 配置目录失败 ({}): {e}", parent.display()))?;
    }
    let current_text = if path.exists() {
        fs::read_to_string(&path)
            .map_err(|e| format!("读取 Codex 配置失败 ({}): {e}", path.display()))?
    } else {
        String::new()
    };
    let mut doc = mcp_parse_toml_document(&current_text)?;

    if let Some(mcp_item) = doc.get_mut("mcp") {
        if let Some(mcp_table) = mcp_item.as_table_mut() {
            mcp_table.remove("servers");
            if mcp_table.is_empty() {
                doc.as_table_mut().remove("mcp");
            }
        }
    }

    if servers.is_empty() {
        doc.as_table_mut().remove("mcp_servers");
    } else {
        let mut mcp_servers_table = TomlEditTable::new();
        mcp_servers_table.set_implicit(false);
        for (id, spec) in servers {
            let obj = spec
                .as_object()
                .ok_or_else(|| format!("MCP 服务器 `{id}` 配置必须是对象。"))?;
            let server_table = mcp_json_object_to_server_table(obj)?;
            mcp_servers_table.insert(id, TomlEditItem::Table(server_table));
        }
        doc["mcp_servers"] = TomlEditItem::Table(mcp_servers_table);
    }

    let mut output = doc.to_string();
    if !output.ends_with('\n') {
        output.push('\n');
    }
    fs::write(&path, output).map_err(|e| format!("写入 Codex 配置失败 ({}): {e}", path.display()))
}

fn read_opencode_mcp_servers() -> CmdResult<BTreeMap<String, Value>> {
    let root = mcp_read_opencode_config_root()?;
    let mut servers = BTreeMap::new();
    if let Some(map) = root.get("mcp").and_then(Value::as_object) {
        for (id, spec) in map {
            let key = id.trim();
            if key.is_empty() || !spec.is_object() {
                continue;
            }
            servers.insert(key.to_string(), spec.clone());
        }
    }
    Ok(servers)
}

fn write_opencode_mcp_servers(servers: &BTreeMap<String, Value>) -> CmdResult<()> {
    let mut root = mcp_read_opencode_config_root()?;
    if !root.is_object() {
        root = Value::Object(Map::new());
    }
    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| "OpenCode 配置根对象格式无效。".to_string())?;

    if !root_obj.contains_key("$schema") {
        root_obj.insert(
            "$schema".to_string(),
            Value::String(OPENCODE_CONFIG_SCHEMA_URL.to_string()),
        );
    }

    if servers.is_empty() {
        root_obj.remove("mcp");
    } else {
        let mut mcp_obj = Map::new();
        for (id, spec) in servers {
            mcp_obj.insert(id.clone(), spec.clone());
        }
        root_obj.insert("mcp".to_string(), Value::Object(mcp_obj));
    }

    mcp_write_opencode_config_root(&root)
}

fn mcp_find_key_case_insensitive(map: &BTreeMap<String, Value>, needle: &str) -> Option<String> {
    map.keys().find(|k| k.eq_ignore_ascii_case(needle)).cloned()
}

fn mcp_source_label(codex_enabled: bool, opencode_enabled: bool) -> String {
    match (codex_enabled, opencode_enabled) {
        (true, true) => "Codex+OpenCode".to_string(),
        (true, false) => "Codex".to_string(),
        (false, true) => "OpenCode".to_string(),
        (false, false) => "-".to_string(),
    }
}

fn mcp_summarize_args(args: &[Value], limit: usize) -> String {
    let mut out: Vec<String> = Vec::new();
    for arg in args {
        if let Some(text) = arg.as_str() {
            out.push(text.to_string());
        } else {
            out.push(arg.to_string());
        }
        if out.len() >= limit {
            break;
        }
    }
    if args.len() > limit {
        out.push("...".to_string());
    }
    out.join(" ")
}

fn mcp_normalize_http_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Some(trimmed.to_string());
    }
    None
}

fn mcp_extract_url_from_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => mcp_normalize_http_url(text),
        Value::Array(items) => {
            for item in items {
                if let Some(url) = mcp_extract_url_from_value(item) {
                    return Some(url);
                }
            }
            None
        }
        Value::Object(obj) => {
            for key in ["url", "href"] {
                if let Some(found) = obj.get(key).and_then(mcp_extract_url_from_value) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn mcp_extract_url_by_keys(obj: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some((_, value)) = obj
            .iter()
            .find(|(entry_key, _)| entry_key.eq_ignore_ascii_case(key))
        {
            if let Some(url) = mcp_extract_url_from_value(value) {
                return Some(url);
            }
        }
    }
    None
}

fn mcp_extract_endpoint_url(spec: &Value, kind: &str) -> Option<String> {
    if !matches!(kind, "sse" | "http") {
        return None;
    }
    let obj = spec.as_object()?;
    mcp_extract_url_by_keys(obj, &["url"])
}

fn mcp_guess_doc_url_from_endpoint(endpoint_url: &str) -> Option<String> {
    let parsed = tauri::Url::parse(endpoint_url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host == "mcp.context7.com" {
        return Some("https://github.com/upstash/context7/blob/master/README.md".to_string());
    }

    let mut candidate = parsed.clone();
    let raw_segments: Vec<&str> = parsed
        .path_segments()
        .map(|items| items.filter(|seg| !seg.is_empty()).collect())
        .unwrap_or_else(Vec::new);
    let mut segments: Vec<&str> = raw_segments.clone();

    fn is_version_segment(seg: &str) -> bool {
        let text = seg.trim().to_ascii_lowercase();
        if text.len() < 2 || !text.starts_with('v') {
            return false;
        }
        text[1..].chars().all(|ch| ch.is_ascii_digit())
    }

    fn is_endpoint_segment(seg: &str) -> bool {
        matches!(
            seg.trim().to_ascii_lowercase().as_str(),
            "mcp"
                | "sse"
                | "event"
                | "events"
                | "event-stream"
                | "stream"
                | "rpc"
                | "jsonrpc"
                | "transport"
                | "gateway"
                | "api"
                | "invoke"
        )
    }

    let has_docs_segment = segments.iter().any(|seg| {
        matches!(
            seg.trim().to_ascii_lowercase().as_str(),
            "docs" | "doc" | "documentation" | "readme" | "guide" | "manual" | "help"
        )
    });

    if !has_docs_segment {
        while let Some(last) = segments.last().copied() {
            if is_endpoint_segment(last) || is_version_segment(last) {
                segments.pop();
            } else {
                break;
            }
        }
    }

    if has_docs_segment && !segments.is_empty() {
        candidate.set_path(&format!("/{}", segments.join("/")));
    } else {
        candidate.set_path("/");
    }
    candidate.set_query(None);
    candidate.set_fragment(None);
    Some(candidate.to_string())
}

fn mcp_normalize_known_doc_url(
    server_id: &str,
    doc_url: Option<String>,
    endpoint_url: Option<&str>,
) -> Option<String> {
    let context7_readme = "https://github.com/upstash/context7/blob/master/README.md";
    let is_context7_id = server_id.eq_ignore_ascii_case("context7");
    let is_context7_endpoint = endpoint_url
        .and_then(|raw| tauri::Url::parse(raw).ok())
        .and_then(|url| {
            url.host_str()
                .map(|h| h.eq_ignore_ascii_case("mcp.context7.com"))
        })
        .unwrap_or(false);
    let is_context7_doc = doc_url
        .as_deref()
        .map(|raw| {
            raw.to_ascii_lowercase()
                .contains("github.com/upstash/context7")
        })
        .unwrap_or(false);

    if is_context7_id || is_context7_endpoint || is_context7_doc {
        return Some(context7_readme.to_string());
    }
    doc_url
}

fn mcp_extract_doc_url(spec: &Value, endpoint_url: Option<&str>) -> Option<String> {
    let obj = spec.as_object()?;
    let explicit = mcp_extract_url_by_keys(
        obj,
        &[
            "doc_url",
            "docUrl",
            "docs_url",
            "docsUrl",
            "documentation_url",
            "documentationUrl",
            "docs",
            "doc",
            "documentation",
            "readme",
            "readme_url",
            "readmeUrl",
            "homepage",
            "website",
            "site",
            "help",
            "manual",
        ],
    );
    if explicit.is_some() {
        return explicit;
    }
    endpoint_url.and_then(mcp_guess_doc_url_from_endpoint)
}

fn mcp_describe_codex_spec(spec: &Value) -> (String, String) {
    let Some(obj) = spec.as_object() else {
        return ("unknown".to_string(), "无效配置".to_string());
    };
    let raw_type = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let kind = if raw_type.is_empty() {
        if obj
            .get("url")
            .and_then(Value::as_str)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            "sse".to_string()
        } else {
            "stdio".to_string()
        }
    } else {
        raw_type
    };

    if matches!(kind.as_str(), "sse" | "http") {
        let url = obj
            .get("url")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if url.is_empty() {
            return (kind, "远程 MCP（未配置 URL）".to_string());
        }
        return (kind, format!("远程 MCP · {url}"));
    }

    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let args = obj
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| mcp_summarize_args(arr, 8))
        .unwrap_or_default();
    if command.is_empty() {
        return (kind, "本地 MCP（未配置 command）".to_string());
    }
    if args.is_empty() {
        return (kind, format!("本地 MCP · {command}"));
    }
    (kind, format!("本地 MCP · {command} {args}"))
}

fn convert_opencode_spec_to_codex(spec: &Value) -> Value {
    let Some(obj) = spec.as_object() else {
        return spec.clone();
    };
    let mut out = obj.clone();
    let typ = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let is_remote = typ == "remote";
    if is_remote {
        out.insert("type".to_string(), Value::String("sse".to_string()));
        out.remove("enabled");
        out.remove("environment");
        out.remove("command");
        out.remove("args");
        return Value::Object(out);
    }

    out.insert("type".to_string(), Value::String("stdio".to_string()));
    if let Some(command_arr) = obj.get("command").and_then(Value::as_array) {
        if let Some(first) = command_arr.first().and_then(Value::as_str) {
            out.insert("command".to_string(), Value::String(first.to_string()));
            if command_arr.len() > 1 {
                out.insert("args".to_string(), Value::Array(command_arr[1..].to_vec()));
            } else {
                out.remove("args");
            }
        }
    }
    if let Some(env) = out.remove("environment") {
        out.insert("env".to_string(), env);
    }
    out.remove("enabled");
    Value::Object(out)
}

fn convert_codex_spec_to_opencode(spec: &Value) -> Value {
    let Some(obj) = spec.as_object() else {
        return spec.clone();
    };
    let mut out = obj.clone();
    let typ = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let is_remote = typ == "sse"
        || typ == "http"
        || obj
            .get("url")
            .and_then(Value::as_str)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
    if is_remote {
        out.insert("type".to_string(), Value::String("remote".to_string()));
        out.remove("command");
        out.remove("args");
        out.remove("env");
        out.remove("environment");
        out.insert("enabled".to_string(), Value::Bool(true));
        return Value::Object(out);
    }

    out.insert("type".to_string(), Value::String("local".to_string()));
    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let mut command_arr: Vec<Value> = Vec::new();
    if !command.is_empty() {
        command_arr.push(Value::String(command.to_string()));
    }
    if let Some(args) = obj.get("args").and_then(Value::as_array) {
        for arg in args {
            command_arr.push(arg.clone());
        }
    }
    if !command_arr.is_empty() {
        out.insert("command".to_string(), Value::Array(command_arr));
    }
    out.remove("args");
    if let Some(env) = out.remove("env") {
        out.insert("environment".to_string(), env);
    }
    out.insert("enabled".to_string(), Value::Bool(true));
    Value::Object(out)
}

fn normalize_new_mcp_spec_to_codex(spec: &Value) -> CmdResult<Value> {
    let Some(obj) = spec.as_object() else {
        return Err("MCP 配置必须是对象。".to_string());
    };
    let typ = obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();

    let mut normalized = if typ == "local" || typ == "remote" || obj.get("environment").is_some() {
        convert_opencode_spec_to_codex(spec)
    } else {
        spec.clone()
    };
    let normalized_obj = normalized
        .as_object_mut()
        .ok_or_else(|| "MCP 配置必须是对象。".to_string())?;
    let mut normalized_type = normalized_obj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if normalized_type.is_empty() {
        if normalized_obj
            .get("url")
            .and_then(Value::as_str)
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false)
        {
            normalized_type = "sse".to_string();
        } else {
            normalized_type = "stdio".to_string();
        }
        normalized_obj.insert("type".to_string(), Value::String(normalized_type.clone()));
    }

    match normalized_type.as_str() {
        "stdio" => {
            let command = normalized_obj
                .get("command")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if command.is_empty() {
                return Err("stdio 类型 MCP 缺少 command。".to_string());
            }
        }
        "sse" | "http" => {
            let url = normalized_obj
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if url.is_empty() {
                return Err("远程 MCP 缺少 url。".to_string());
            }
        }
        _ => {
            return Err(format!("不支持的 MCP 类型: {normalized_type}"));
        }
    }

    Ok(Value::Object(normalized_obj.clone()))
}

fn merge_mcp_maps(
    codex_map: &BTreeMap<String, Value>,
    opencode_map: &BTreeMap<String, Value>,
) -> Vec<UnifiedMcpEntry> {
    let mut merged: BTreeMap<String, UnifiedMcpEntry> = BTreeMap::new();
    for (id, spec) in codex_map {
        let key = id.to_lowercase();
        let entry = merged.entry(key).or_default();
        if entry.id.is_empty() {
            entry.id = id.clone();
        }
        entry.codex_spec = Some(spec.clone());
    }
    for (id, spec) in opencode_map {
        let key = id.to_lowercase();
        let entry = merged.entry(key).or_default();
        if entry.id.is_empty() {
            entry.id = id.clone();
        }
        entry.opencode_spec = Some(spec.clone());
    }
    merged.into_values().collect()
}

fn load_mcp_manage_internal() -> CmdResult<McpManageView> {
    let codex_map = read_codex_mcp_servers()?;
    let opencode_map = read_opencode_mcp_servers()?;
    let app_flags_map = ccswitch_load_mcp_app_flags_map()?;
    let merged = merge_mcp_maps(&codex_map, &opencode_map);
    let mut servers: Vec<McpServerView> = Vec::new();

    for entry in merged {
        let codex_enabled = entry.codex_spec.is_some();
        let opencode_enabled = entry.opencode_spec.is_some();
        let (claude_enabled, gemini_enabled) = app_flags_map
            .get(&entry.id.to_lowercase())
            .map(|flags| (flags.claude_enabled, flags.gemini_enabled))
            .unwrap_or((false, false));
        let codex_available = codex_enabled || opencode_enabled;
        let opencode_available = codex_enabled || opencode_enabled;
        let source = mcp_source_label(codex_enabled, opencode_enabled);
        let normalized_spec = entry.codex_spec.clone().or_else(|| {
            entry
                .opencode_spec
                .as_ref()
                .map(convert_opencode_spec_to_codex)
        });
        let (kind, description, endpoint_url, doc_url) = if let Some(ref spec) = normalized_spec {
            let (kind, description) = mcp_describe_codex_spec(&spec);
            let endpoint_url = mcp_extract_endpoint_url(&spec, &kind);
            let doc_url = mcp_extract_doc_url(&spec, endpoint_url.as_deref());
            let doc_url = mcp_normalize_known_doc_url(&entry.id, doc_url, endpoint_url.as_deref());
            (kind, description, endpoint_url, doc_url)
        } else {
            ("unknown".to_string(), "未提供配置".to_string(), None, None)
        };

        servers.push(McpServerView {
            id: entry.id.clone(),
            name: entry.id.clone(),
            description,
            doc_url,
            endpoint_url,
            source,
            kind,
            claude_enabled,
            codex_enabled,
            gemini_enabled,
            opencode_enabled,
            codex_available,
            opencode_available,
        });

        ccswitch_upsert_mcp_targets_row(
            &entry.id,
            None,
            codex_enabled,
            None,
            opencode_enabled,
            normalized_spec.as_ref(),
        )?;
    }

    servers.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    let claude_enabled_count = servers.iter().filter(|s| s.claude_enabled).count();
    let codex_enabled_count = servers.iter().filter(|s| s.codex_enabled).count();
    let gemini_enabled_count = servers.iter().filter(|s| s.gemini_enabled).count();
    let opencode_enabled_count = servers.iter().filter(|s| s.opencode_enabled).count();
    Ok(McpManageView {
        total: servers.len(),
        claude_enabled_count,
        codex_enabled_count,
        gemini_enabled_count,
        opencode_enabled_count,
        servers,
    })
}

fn set_mcp_targets_internal(
    server_id: &str,
    claude_enabled: Option<bool>,
    codex_enabled: bool,
    gemini_enabled: Option<bool>,
    opencode_enabled: bool,
) -> CmdResult<McpManageView> {
    let id = server_id.trim();
    if id.is_empty() {
        return Err("MCP 服务器 ID 不能为空。".to_string());
    }

    let mut codex_map = read_codex_mcp_servers()?;
    let mut opencode_map = read_opencode_mcp_servers()?;

    let codex_key = mcp_find_key_case_insensitive(&codex_map, id);
    let opencode_key = mcp_find_key_case_insensitive(&opencode_map, id);

    let codex_spec = codex_key
        .as_ref()
        .and_then(|key| codex_map.get(key))
        .cloned();
    let opencode_spec = opencode_key
        .as_ref()
        .and_then(|key| opencode_map.get(key))
        .cloned();

    if codex_spec.is_none() && opencode_spec.is_none() {
        return Err(format!("未找到 MCP 服务器: {id}"));
    }

    if codex_enabled {
        let next_spec = codex_spec
            .clone()
            .or_else(|| opencode_spec.as_ref().map(convert_opencode_spec_to_codex))
            .ok_or_else(|| format!("MCP `{id}` 缺少可写入 Codex 的配置。"))?;
        codex_map.insert(id.to_string(), next_spec);
        if let Some(old_key) = codex_key {
            if !old_key.eq_ignore_ascii_case(id) {
                codex_map.remove(&old_key);
            }
        }
    } else if let Some(old_key) = codex_key {
        codex_map.remove(&old_key);
    }

    if opencode_enabled {
        let next_spec = opencode_spec
            .clone()
            .or_else(|| codex_spec.as_ref().map(convert_codex_spec_to_opencode))
            .ok_or_else(|| format!("MCP `{id}` 缺少可写入 OpenCode 的配置。"))?;
        opencode_map.insert(id.to_string(), next_spec);
        if let Some(old_key) = opencode_key {
            if !old_key.eq_ignore_ascii_case(id) {
                opencode_map.remove(&old_key);
            }
        }
    } else if let Some(old_key) = opencode_key {
        opencode_map.remove(&old_key);
    }

    write_codex_mcp_servers(&codex_map)?;
    write_opencode_mcp_servers(&opencode_map)?;

    let sync_spec = mcp_find_key_case_insensitive(&codex_map, id)
        .and_then(|key| codex_map.get(&key).cloned())
        .or_else(|| {
            mcp_find_key_case_insensitive(&opencode_map, id)
                .and_then(|key| opencode_map.get(&key))
                .map(convert_opencode_spec_to_codex)
        });
    ccswitch_upsert_mcp_targets_row(
        id,
        claude_enabled,
        codex_enabled,
        gemini_enabled,
        opencode_enabled,
        sync_spec.as_ref(),
    )?;

    load_mcp_manage_internal()
}

fn add_mcp_server_internal(
    server_id: &str,
    spec: &Value,
    claude_enabled: bool,
    codex_enabled: bool,
    gemini_enabled: bool,
    opencode_enabled: bool,
) -> CmdResult<McpManageView> {
    let id = server_id.trim();
    if id.is_empty() {
        return Err("MCP 服务器 ID 不能为空。".to_string());
    }
    if !codex_enabled && !opencode_enabled {
        return Err("请至少启用 Codex 或 OpenCode 之一。".to_string());
    }

    let codex_spec = normalize_new_mcp_spec_to_codex(spec)?;
    let opencode_spec = convert_codex_spec_to_opencode(&codex_spec);

    let mut codex_map = read_codex_mcp_servers()?;
    let mut opencode_map = read_opencode_mcp_servers()?;

    if codex_enabled {
        codex_map.insert(id.to_string(), codex_spec.clone());
    } else if let Some(key) = mcp_find_key_case_insensitive(&codex_map, id) {
        codex_map.remove(&key);
    }

    if opencode_enabled {
        opencode_map.insert(id.to_string(), opencode_spec);
    } else if let Some(key) = mcp_find_key_case_insensitive(&opencode_map, id) {
        opencode_map.remove(&key);
    }

    write_codex_mcp_servers(&codex_map)?;
    write_opencode_mcp_servers(&opencode_map)?;
    ccswitch_upsert_mcp_targets_row(
        id,
        Some(claude_enabled),
        codex_enabled,
        Some(gemini_enabled),
        opencode_enabled,
        Some(&codex_spec),
    )?;
    load_mcp_manage_internal()
}

fn remove_mcp_server_internal(server_id: &str) -> CmdResult<McpManageView> {
    let id = server_id.trim();
    if id.is_empty() {
        return Err("MCP 服务器 ID 不能为空。".to_string());
    }

    let mut codex_map = read_codex_mcp_servers()?;
    let mut opencode_map = read_opencode_mcp_servers()?;

    if let Some(key) = mcp_find_key_case_insensitive(&codex_map, id) {
        codex_map.remove(&key);
    }
    if let Some(key) = mcp_find_key_case_insensitive(&opencode_map, id) {
        opencode_map.remove(&key);
    }

    write_codex_mcp_servers(&codex_map)?;
    write_opencode_mcp_servers(&opencode_map)?;
    ccswitch_delete_mcp_row(id)?;
    load_mcp_manage_internal()
}

fn import_existing_mcp_internal() -> CmdResult<McpManageView> {
    load_mcp_manage_internal()
}

