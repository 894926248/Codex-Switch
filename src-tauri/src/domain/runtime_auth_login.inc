fn safe_remove_dir(path: &Path) {
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
}

fn make_pending_login_dir() -> CmdResult<PathBuf> {
    let base = profiles_dir()?;
    let mut pending = base.join(format!("_login_{}", Local::now().format("%Y%m%d_%H%M%S")));
    let mut suffix = 2;
    while pending.exists() {
        pending = base.join(format!(
            "_login_{}_{}",
            Local::now().format("%Y%m%d_%H%M%S"),
            suffix
        ));
        suffix += 1;
    }
    fs::create_dir_all(&pending).map_err(|e| format!("创建登录临时目录失败: {e}"))?;
    Ok(pending)
}

fn is_tcp_port_bindable(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn try_cancel_local_login_server(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let mut stream = match TcpStream::connect(addr) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    let request = format!(
        "POST /cancel HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).is_ok()
}

fn login_port_busy_error(port: u16) -> String {
    format!(
        "登录失败：回调端口 {port} 被占用，无法启动内嵌登录。请先释放端口后重试。\
\n\
\nCMD 操作教程：\
\n1) 查占用 PID: netstat -ano | findstr :{port}\
\n2) 看进程名: tasklist /FI \"PID eq <PID>\"\
\n3) 结束进程: taskkill /F /PID <PID>\
\n\
\nPowerShell 操作教程：\
\n1) 查占用 PID: Get-NetTCPConnection -LocalPort {port} | Select-Object -ExpandProperty OwningProcess\
\n2) 结束进程: Stop-Process -Id <PID> -Force\
\n\
\n如果占用进程是 opencode.exe，请先退出 OpenCode。"
    )
}

fn ensure_login_callback_port_ready() -> CmdResult<()> {
    if is_tcp_port_bindable(LOGIN_CALLBACK_PORT) {
        return Ok(());
    }

    // Try to close a stale local login server left by a previous interrupted flow.
    let _ = try_cancel_local_login_server(LOGIN_CALLBACK_PORT);
    thread::sleep(Duration::from_millis(260));

    if is_tcp_port_bindable(LOGIN_CALLBACK_PORT) {
        return Ok(());
    }
    Err(login_port_busy_error(LOGIN_CALLBACK_PORT))
}

#[derive(Debug, Clone)]
struct DeviceAuthCode {
    verification_url: String,
    user_code: String,
    device_auth_id: String,
    interval_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct DeviceAuthTokenPollSuccess {
    authorization_code: String,
    code_challenge: String,
    code_verifier: String,
}

#[derive(Debug, Clone, Deserialize)]
struct OAuthTokenExchangeResponse {
    id_token: String,
    access_token: String,
    refresh_token: String,
    #[serde(default)]
    expires_in: Option<u64>,
}

fn request_chatgpt_device_auth_code() -> CmdResult<DeviceAuthCode> {
    let issuer = CHATGPT_DEVICE_AUTH_ISSUER.trim_end_matches('/');
    let client = reqwest::blocking::Client::new();
    let endpoint = format!("{issuer}/api/accounts/deviceauth/usercode");

    let resp = client
        .post(endpoint)
        .json(&json!({
            "client_id": CHATGPT_DEVICE_AUTH_CLIENT_ID
        }))
        .send()
        .map_err(|e| format!("请求设备码失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("请求设备码失败: HTTP {}", resp.status()));
    }

    let body = resp
        .json::<Value>()
        .map_err(|e| format!("解析设备码响应失败: {e}"))?;
    let device_auth_id = body
        .get("device_auth_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let user_code = body
        .get("user_code")
        .or_else(|| body.get("usercode"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let interval_secs = body
        .get("interval")
        .and_then(|v| {
            if let Some(n) = v.as_u64() {
                return Some(n);
            }
            v.as_str().and_then(|text| text.trim().parse::<u64>().ok())
        })
        .unwrap_or(5)
        .max(1);

    if device_auth_id.is_empty() || user_code.is_empty() {
        return Err("设备码响应缺少必要字段（device_auth_id / user_code）。".to_string());
    }

    Ok(DeviceAuthCode {
        verification_url: format!("{issuer}/codex/device"),
        user_code,
        device_auth_id,
        interval_secs,
    })
}

fn poll_chatgpt_device_auth_tokens(
    device_code: &DeviceAuthCode,
) -> CmdResult<DeviceAuthTokenPollSuccess> {
    let issuer = CHATGPT_DEVICE_AUTH_ISSUER.trim_end_matches('/');
    let client = reqwest::blocking::Client::new();
    let endpoint = format!("{issuer}/api/accounts/deviceauth/token");
    let deadline = Instant::now() + Duration::from_secs(CHATGPT_DEVICE_AUTH_TIMEOUT_SECS);

    loop {
        if Instant::now() >= deadline {
            return Err("设备码登录超时（15分钟），请重试。".to_string());
        }

        let resp = client
            .post(&endpoint)
            .json(&json!({
                "device_auth_id": device_code.device_auth_id,
                "user_code": device_code.user_code
            }))
            .send()
            .map_err(|e| format!("轮询设备码状态失败: {e}"))?;

        let status = resp.status();
        if status.is_success() {
            return resp
                .json::<DeviceAuthTokenPollSuccess>()
                .map_err(|e| format!("解析设备码轮询结果失败: {e}"));
        }

        if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::NOT_FOUND {
            let remain = deadline.saturating_duration_since(Instant::now());
            let wait_secs = device_code
                .interval_secs
                .min(remain.as_secs().max(1))
                .max(1);
            thread::sleep(Duration::from_secs(wait_secs));
            continue;
        }

        let detail = resp.text().unwrap_or_default();
        return Err(format!("设备码轮询失败: HTTP {} {}", status, detail));
    }
}

fn exchange_chatgpt_authorization_code_for_tokens(
    authorization_code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> CmdResult<OAuthTokenExchangeResponse> {
    let issuer = CHATGPT_DEVICE_AUTH_ISSUER.trim_end_matches('/');
    let client = reqwest::blocking::Client::new();
    let endpoint = format!("{issuer}/oauth/token");
    let form: [(&str, String); 5] = [
        ("grant_type", "authorization_code".to_string()),
        ("code", authorization_code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("client_id", CHATGPT_DEVICE_AUTH_CLIENT_ID.to_string()),
        ("code_verifier", code_verifier.to_string()),
    ];

    let resp = client
        .post(endpoint)
        .form(&form)
        .send()
        .map_err(|e| format!("交换 OAuth token 失败: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp.text().unwrap_or_default();
        return Err(format!("交换 OAuth token 失败: HTTP {} {}", status, detail));
    }

    resp.json::<OAuthTokenExchangeResponse>()
        .map_err(|e| format!("解析 OAuth token 响应失败: {e}"))
}

fn exchange_chatgpt_code_for_tokens(
    code_payload: &DeviceAuthTokenPollSuccess,
) -> CmdResult<OAuthTokenExchangeResponse> {
    let issuer = CHATGPT_DEVICE_AUTH_ISSUER.trim_end_matches('/');
    let redirect_uri = format!("{issuer}/deviceauth/callback");
    exchange_chatgpt_authorization_code_for_tokens(
        &code_payload.authorization_code,
        &redirect_uri,
        &code_payload.code_verifier,
    )
}

fn build_browser_oauth_state() -> String {
    let mut bytes = [0u8; 32];
    thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn build_pkce_code_verifier() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = thread_rng();
    let mut out = String::with_capacity(43);
    for _ in 0..43 {
        let idx = rng.gen_range(0..CHARS.len());
        out.push(CHARS[idx] as char);
    }
    out
}

fn build_pkce_code_challenge(code_verifier: &str) -> String {
    let digest = Sha256::digest(code_verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn build_chatgpt_browser_oauth_url(
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
) -> CmdResult<String> {
    let issuer = CHATGPT_DEVICE_AUTH_ISSUER.trim_end_matches('/');
    let mut url = tauri::Url::parse(&format!("{issuer}/oauth/authorize"))
        .map_err(|e| format!("构建登录地址失败: {e}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", CHATGPT_DEVICE_AUTH_CLIENT_ID);
        query.append_pair("redirect_uri", redirect_uri);
        query.append_pair("scope", "openid profile email offline_access");
        query.append_pair("code_challenge", code_challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("id_token_add_organizations", "true");
        query.append_pair("codex_cli_simplified_flow", "true");
        query.append_pair("state", state);
        query.append_pair("originator", "opencode");
    }
    Ok(url.to_string())
}

fn html_escape_min(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn write_http_response(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn write_http_html_response(stream: &mut TcpStream, status: &str, body: &str) {
    write_http_response(stream, status, "text/html", body);
}

fn write_http_text_response(stream: &mut TcpStream, status: &str, body: &str) {
    write_http_response(stream, status, "text/plain", body);
}

fn handle_browser_oauth_callback_request(
    stream: &mut TcpStream,
    expected_state: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Option<CmdResult<OAuthTokenExchangeResponse>> {
    let mut request_line = String::new();
    {
        let mut reader = BufReader::new(&mut *stream);
        if reader.read_line(&mut request_line).is_err() {
            return None;
        }
    }
    let mut parts = request_line.split_whitespace();
    let _method = parts.next().unwrap_or_default();
    let request_target = parts.next().unwrap_or("/");
    let parsed = match tauri::Url::parse(&format!("http://localhost{request_target}")) {
        Ok(v) => v,
        Err(_) => {
            write_http_text_response(stream, "400 Bad Request", "Invalid request");
            return Some(Err("登录回调请求无效。".to_string()));
        }
    };
    let path = parsed.path().to_string();
    if path == "/__codex_switch_ping" {
        write_http_text_response(stream, "200 OK", "ok");
        return None;
    }
    if path == "/cancel" {
        write_http_text_response(stream, "200 OK", "cancelled");
        return Some(Err("已取消登录。".to_string()));
    }
    if path != "/auth/callback" {
        write_http_text_response(stream, "404 Not Found", "not found");
        return None;
    }

    let mut code = String::new();
    let mut state = String::new();
    let mut error = String::new();
    let mut error_description = String::new();
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "code" => code = value.into_owned(),
            "state" => state = value.into_owned(),
            "error" => error = value.into_owned(),
            "error_description" => error_description = value.into_owned(),
            _ => {}
        }
    }

    const SUCCESS_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><title>Login Success</title></head><body style="font-family:system-ui;background:#111;color:#e8e8e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div><h2>Authorization successful</h2><p>You can close this window and return to Codex Switch.</p></div><script>setTimeout(()=>window.close(),1800)</script></body></html>"#;

    if !error.trim().is_empty() {
        let detail = if error_description.trim().is_empty() {
            error
        } else {
            error_description
        };
        let safe = html_escape_min(&detail);
        let html = format!(
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Login Failed</title></head><body style=\"font-family:system-ui;background:#111;color:#e8e8e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><div><h2>Authorization failed</h2><pre style=\"white-space:pre-wrap;color:#ffb4a5\">{safe}</pre></div></body></html>"
        );
        write_http_html_response(stream, "400 Bad Request", &html);
        return Some(Err(format!("登录失败: {detail}")));
    }
    if code.trim().is_empty() {
        write_http_html_response(stream, "400 Bad Request", "Missing authorization code");
        return Some(Err("登录回调缺少 code。".to_string()));
    }
    if state.trim().is_empty() || state != expected_state {
        write_http_html_response(stream, "400 Bad Request", "Invalid state");
        return Some(Err("登录回调 state 校验失败。".to_string()));
    }

    match exchange_chatgpt_authorization_code_for_tokens(&code, redirect_uri, code_verifier) {
        Ok(tokens) => {
            write_http_html_response(stream, "200 OK", SUCCESS_HTML);
            Some(Ok(tokens))
        }
        Err(err) => {
            let safe = html_escape_min(&err);
            let html = format!(
                "<!doctype html><html><head><meta charset=\"utf-8\"><title>Login Failed</title></head><body style=\"font-family:system-ui;background:#111;color:#e8e8e8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0\"><div><h2>Token exchange failed</h2><pre style=\"white-space:pre-wrap;color:#ffb4a5\">{safe}</pre></div></body></html>"
            );
            write_http_html_response(stream, "500 Internal Server Error", &html);
            Some(Err(err))
        }
    }
}

struct BrowserOAuthLoginSession {
    auth_url: String,
    rx: mpsc::Receiver<CmdResult<OAuthTokenExchangeResponse>>,
    stop: Arc<AtomicBool>,
    callback_port: u16,
    join_handle: Option<thread::JoinHandle<()>>,
}

fn start_browser_oauth_login_session() -> CmdResult<BrowserOAuthLoginSession> {
    ensure_login_callback_port_ready()?;
    let listener = TcpListener::bind(("127.0.0.1", LOGIN_CALLBACK_PORT))
        .map_err(|e| format!("启动本地回调服务失败: {e}"))?;
    let callback_port = LOGIN_CALLBACK_PORT;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置回调监听失败: {e}"))?;
    let redirect_uri = format!("http://localhost:{callback_port}/auth/callback");
    let code_verifier = build_pkce_code_verifier();
    let code_challenge = build_pkce_code_challenge(&code_verifier);
    let state = build_browser_oauth_state();
    let auth_url = build_chatgpt_browser_oauth_url(&redirect_uri, &code_challenge, &state)?;

    let (tx, rx) = mpsc::channel::<CmdResult<OAuthTokenExchangeResponse>>();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = Arc::clone(&stop);
    let join_handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(CHATGPT_BROWSER_OAUTH_TIMEOUT_SECS);
        while Instant::now() < deadline && !stop_thread.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(1200)));
                    let _ = stream.set_write_timeout(Some(Duration::from_millis(1600)));
                    if let Some(result) = handle_browser_oauth_callback_request(
                        &mut stream,
                        &state,
                        &redirect_uri,
                        &code_verifier,
                    ) {
                        let _ = tx.send(result);
                        return;
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(70));
                }
                Err(err) => {
                    let _ = tx.send(Err(format!("登录回调监听异常: {err}")));
                    return;
                }
            }
        }
        if !stop_thread.load(Ordering::Relaxed) {
            let _ = tx.send(Err("登录超时（15分钟），请重试。".to_string()));
        }
    });

    Ok(BrowserOAuthLoginSession {
        auth_url,
        rx,
        stop,
        callback_port,
        join_handle: Some(join_handle),
    })
}

fn shutdown_browser_oauth_login_session(session: &mut BrowserOAuthLoginSession) {
    session.stop.store(true, Ordering::Relaxed);
    if session.callback_port > 0 {
        let addr = format!("127.0.0.1:{}", session.callback_port);
        if let Ok(mut stream) = TcpStream::connect(addr) {
            let _ = stream.write_all(
                b"GET /__codex_switch_ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            );
            let _ = stream.flush();
        }
    }
    if let Some(join) = session.join_handle.take() {
        let _ = join.join();
    }
}

fn extract_account_id_from_id_token(id_token: &str) -> Option<String> {
    let decoded = decode_jwt_payload(id_token)?;
    let auth_claim = decoded
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object)?;
    pick_workspace_id_from_auth_claim(auth_claim)
}

fn persist_chatgpt_tokens_to_auth_file(
    codex_home: &Path,
    tokens: &OAuthTokenExchangeResponse,
) -> CmdResult<()> {
    fs::create_dir_all(codex_home).map_err(|e| format!("创建登录目录失败: {e}"))?;
    let account_id = extract_account_id_from_id_token(&tokens.id_token);
    let auth_json = json!({
        "auth_mode": "chatgpt",
        "OPENAI_API_KEY": Value::Null,
        "tokens": {
            "id_token": tokens.id_token,
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "account_id": account_id.map(Value::String).unwrap_or(Value::Null)
        },
        "last_refresh": Utc::now().to_rfc3339()
    });
    let serialized = serde_json::to_string_pretty(&auth_json)
        .map_err(|e| format!("序列化 auth.json 失败: {e}"))?;
    fs::write(codex_home.join(AUTH_FILE_NAME), format!("{serialized}\n"))
        .map_err(|e| format!("写入 auth.json 失败: {e}"))
}

fn run_device_auth_login_flow(app: &tauri::AppHandle, codex_home: &Path) -> CmdResult<()> {
    emit_login_progress(app, "device_code_prepare", "正在切换到设备码登录...");
    let device_code = request_chatgpt_device_auth_code()?;
    let login_tip = format!(
        "请在浏览器打开 {} 并输入验证码：{}",
        device_code.verification_url, device_code.user_code
    );
    emit_login_progress(app, "device_code", &login_tip);
    let _ = app
        .opener()
        .open_url(device_code.verification_url.clone(), None::<String>);
    emit_login_progress(app, "device_wait", "等待设备码授权完成...");

    let polled = poll_chatgpt_device_auth_tokens(&device_code)?;
    if polled.code_challenge.trim().is_empty() {
        return Err("设备码响应缺少 code_challenge。".to_string());
    }
    emit_login_progress(app, "device_exchange", "授权成功，正在交换登录 token...");
    let tokens = exchange_chatgpt_code_for_tokens(&polled)?;
    persist_chatgpt_tokens_to_auth_file(codex_home, &tokens)?;
    Ok(())
}

struct LoginFlowSession {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: mpsc::Receiver<String>,
    auth_url: String,
    login_id: String,
}

struct EmbeddedLoginWindow {
    label: String,
    page_loaded: Arc<AtomicBool>,
    selected_workspace_name: Arc<Mutex<Option<String>>>,
}

fn start_login_flow_session(codex_home: &Path) -> CmdResult<LoginFlowSession> {
    let mut cmd = build_codex_command(&["app-server"])?;
    let mut child = cmd
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动登录服务失败: {e}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "登录服务 stdin 不可用。".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "登录服务 stdout 不可用。".to_string())?;
    let stderr = child.stderr.take();

    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    if let Some(err_stream) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(err_stream);
            for _ in reader.lines().map_while(Result::ok) {}
        });
    }

    for req in [
        json!({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "codex-switch", "version": "1.0.0"}}
        }),
        json!({
            "id": 2,
            "method": "account/login/start",
            "params": {"type": "chatgpt"}
        }),
    ] {
        let line = serde_json::to_string(&req).map_err(|e| format!("登录请求序列化失败: {e}"))?;
        stdin
            .write_all(format!("{line}\n").as_bytes())
            .map_err(|e| format!("写入登录请求失败: {e}"))?;
    }
    stdin
        .flush()
        .map_err(|e| format!("刷新登录请求失败: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("登录服务提前退出: {status}"));
        }

        match rx.recv_timeout(Duration::from_millis(350)) {
            Ok(line) => {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };

                if msg.get("id").and_then(Value::as_i64) == Some(2) {
                    if let Some(err) = msg.get("error") {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("获取登录地址失败: {err}"));
                    }
                    let result = msg.get("result").cloned().unwrap_or(Value::Null);
                    let auth_url = result
                        .get("authUrl")
                        .or_else(|| result.get("auth_url"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("")
                        .to_string();
                    let login_id = result
                        .get("loginId")
                        .or_else(|| result.get("login_id"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .unwrap_or("")
                        .to_string();
                    if auth_url.is_empty() || login_id.is_empty() {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("登录服务返回缺少 authUrl / loginId。".to_string());
                    }
                    return Ok(LoginFlowSession {
                        child,
                        stdin: Some(stdin),
                        rx,
                        auth_url,
                        login_id,
                    });
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("登录服务输出通道已关闭。".to_string());
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    Err("获取登录地址超时，请重试。".to_string())
}

fn open_embedded_login_window(
    app: &tauri::AppHandle,
    label: &str,
    auth_url: &str,
) -> CmdResult<EmbeddedLoginWindow> {
    let webview_data_dir = switcher_home()?.join("webview_profile");
    fs::create_dir_all(&webview_data_dir)
        .map_err(|e| format!("创建内嵌浏览器数据目录失败: {e}"))?;

    let parsed = auth_url
        .parse::<tauri::Url>()
        .map_err(|e| format!("登录地址无效: {e}"))?;
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.close();
    }

    let page_loaded = Arc::new(AtomicBool::new(false));
    let page_loaded_marker = Arc::clone(&page_loaded);
    let selected_workspace_name = Arc::new(Mutex::new(None::<String>));
    let selected_workspace_name_marker = Arc::clone(&selected_workspace_name);
    let selected_workspace_name_capture = Arc::clone(&selected_workspace_name);

    WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
        .title("Codex 登录")
        .user_agent(LOGIN_WEBVIEW_USER_AGENT)
        .data_directory(webview_data_dir)
        .inner_size(1260.0, 1160.0)
        .min_inner_size(1080.0, 900.0)
        .resizable(true)
        .closable(true)
        .minimizable(true)
        .maximizable(true)
        .decorations(true)
        .focused(true)
        .visible(true)
        .on_navigation(|_| true)
        .on_page_load(move |window, payload| {
            page_loaded_marker.store(true, Ordering::Relaxed);
            let url_text = payload.url().as_str().to_string();
            if url_text.contains("/sign-in-with-chatgpt/codex/consent")
                || url_text.contains("auth.openai.com")
            {
                let _ = window.eval(WORKSPACE_CAPTURE_SCRIPT);
                let _ = window.eval(LOGIN_ERROR_CAPTURE_SCRIPT);
            }
        })
        .on_document_title_changed(move |_, title| {
            if let Some(text) = title.strip_prefix(WORKSPACE_CAPTURE_TITLE_PREFIX) {
                let clean = text.trim().replace('\n', " ");
                if !clean.is_empty() {
                    if let Ok(mut guard) = selected_workspace_name_marker.lock() {
                        *guard = Some(clean);
                    }
                }
            }
        })
        .build()
        .map_err(|e| format!("打开内嵌登录窗口失败: {e}"))?;
    Ok(EmbeddedLoginWindow {
        label: label.to_string(),
        page_loaded,
        selected_workspace_name: selected_workspace_name_capture,
    })
}

fn close_login_window(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
}

fn poll_login_completed(line: &str, expected_login_id: &str) -> Option<CmdResult<()>> {
    let msg: Value = serde_json::from_str(line).ok()?;
    let method = msg.get("method").and_then(Value::as_str)?;
    if method != "account/login/completed" && method != "loginChatGptComplete" {
        return None;
    }
    let params = msg.get("params").and_then(Value::as_object)?;
    let this_login_id = params
        .get("loginId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !this_login_id.is_empty()
        && !expected_login_id.is_empty()
        && this_login_id != expected_login_id
    {
        return None;
    }
    let success = params
        .get("success")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if success {
        Some(Ok(()))
    } else {
        let detail = params
            .get("error")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("登录失败，请重试。");
        Some(Err(detail.to_string()))
    }
}

fn shutdown_login_flow_session(session: &mut LoginFlowSession, send_cancel: bool) {
    if let Some(mut stdin) = session.stdin.take() {
        if send_cancel {
            let cancel_req = json!({
                "id": 90,
                "method": "account/login/cancel",
                "params": {"loginId": session.login_id}
            });
            if let Ok(line) = serde_json::to_string(&cancel_req) {
                let _ = stdin.write_all(format!("{line}\n").as_bytes());
                let _ = stdin.flush();
            }
        }
    }
    let _ = session.child.kill();
    let _ = session.child.wait();
}

