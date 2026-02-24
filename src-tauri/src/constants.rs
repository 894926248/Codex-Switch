#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) const AUTH_FILE_NAME: &str = "auth.json";
pub(crate) const CAP_SID_FILE_NAME: &str = "cap_sid";
pub(crate) const CONFIG_FILE_NAME: &str = "config.toml";
pub(crate) const SWITCHER_HOME_DIR: &str = ".codex_account_switcher";
pub(crate) const CC_SWITCH_HOME_DIR: &str = ".cc-switch";
pub(crate) const CC_SWITCH_DB_FILE_NAME: &str = "cc-switch.db";
pub(crate) const PROFILES_FILE_NAME: &str = "profiles.json";
pub(crate) const PROFILES_DIR_NAME: &str = "profiles";
pub(crate) const BACKUPS_DIR_NAME: &str = "backups";
pub(crate) const APP_NAME: &str = "Codex Switch";
pub(crate) const BACKUP_MANIFEST_NAME: &str = "manifest.json";
pub(crate) const BACKUP_FORMAT_NAME: &str = "codex-switch-backup";
pub(crate) const BACKUP_SCHEMA_VERSION: u32 = 1;
pub(crate) const BACKUP_SWITCHER_PREFIX: &str = "switcher";
pub(crate) const BACKUP_CODEX_PREFIX: &str = "codex";
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
pub(crate) const TRAY_ICON_ID: &str = "main";
pub(crate) const TRAY_MENU_SHOW_ID: &str = "tray_show_main_window";
pub(crate) const TRAY_MENU_EXIT_ID: &str = "tray_exit_app";
pub(crate) const PROFILE_SUPPORT_GPT_KEY: &str = "gpt";
pub(crate) const PROFILE_SUPPORT_OPENCODE_KEY: &str = "opencode";
pub(crate) const OPENCODE_PROVIDER_ID: &str = "openai";
pub(crate) const OPENCODE_OPENAI_SNAPSHOT_FILE_NAME: &str = "opencode.openai.json";
pub(crate) const OPENCODE_AUTH_BACKUP_FILE_NAME: &str = "opencode.auth.json";
pub(crate) const OPENCODE_CONFIG_FILE_NAME: &str = "opencode.json";
pub(crate) const OPENCODE_CONFIG_SCHEMA_URL: &str = "https://opencode.ai/config.json";
pub(crate) const AGENTS_HOME_DIR: &str = ".agents";
pub(crate) const SKILLS_DIR_NAME: &str = "skills";
pub(crate) const SKILL_MANIFEST_FILE_NAME: &str = "SKILL.md";
pub(crate) const SKILL_DISCOVERY_COMPARE_MIN_INTERVAL_SECS: i64 = 20;
pub(crate) const LOGIN_WEBVIEW_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
pub(crate) const WORKSPACE_CAPTURE_TITLE_PREFIX: &str = "__CODEX_WS__";
pub(crate) const LOGIN_ERROR_CAPTURE_TITLE_PREFIX: &str = "__CODEX_ERR__";
pub(crate) const LOGIN_CALLBACK_PORT: u16 = 1455;
pub(crate) const CHATGPT_DEVICE_AUTH_ISSUER: &str = "https://auth.openai.com";
pub(crate) const CHATGPT_DEVICE_AUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub(crate) const CHATGPT_DEVICE_AUTH_TIMEOUT_SECS: u64 = 15 * 60;
pub(crate) const CHATGPT_BROWSER_OAUTH_TIMEOUT_SECS: u64 = 15 * 60;
pub(crate) const WORKSPACE_CAPTURE_SCRIPT: &str = r#"
(() => {
  try {
    if (window.__codexSwitchWsHooked) return;
    window.__codexSwitchWsHooked = true;
    const PREFIX = "__CODEX_WS__";
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const blocked = /(选择一个工作空间|choose a workspace)/i;
    const fromCheckedRadio = () => {
      const checked = document.querySelector('input[name="workspace_id"]:checked');
      if (!checked) return "";
      const label = checked.closest('label');
      if (!label) return "";
      const preferred = [
        'span[class*="primary"]',
        'span[class*="medium"]',
        'span[title]',
        'span'
      ];
      for (const sel of preferred) {
        const node = label.querySelector(sel);
        if (!node) continue;
        const text = norm(node.textContent || node.getAttribute('title'));
        if (text && !blocked.test(text)) return text;
      }
      const text = norm(label.textContent);
      return blocked.test(text) ? "" : text;
    };
    const pick = () => {
      const byRadio = fromCheckedRadio();
      if (byRadio) return byRadio;
      const selectors = [
        '[aria-selected="true"] [class*="primary"]',
        '[aria-selected="true"] span',
        '[aria-selected="true"]',
        'option:checked'
      ];
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        for (const n of nodes) {
          const text = norm(n.textContent);
          if (text && !blocked.test(text)) return text;
        }
      }
      return "";
    };
    const push = () => {
      const text = pick();
      if (!text) return;
      const tagged = PREFIX + text;
      if (document.title !== tagged) document.title = tagged;
    };
    push();
    const root = document.documentElement || document.body;
    if (root) {
      const obs = new MutationObserver(push);
      obs.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["aria-selected", "class"]
      });
    }
    setInterval(push, 700);
  } catch (_) {}
})();
"#;
pub(crate) const LOGIN_ERROR_CAPTURE_SCRIPT: &str = r#"
(() => {
  try {
    if (window.__codexSwitchErrHooked) return;
    window.__codexSwitchErrHooked = true;
    const PREFIX = "__CODEX_ERR__";
    const shouldMark = () => {
      const body = (document.body && (document.body.innerText || document.body.textContent)) || "";
      const text = String(body).toLowerCase();
      return (
        text.includes("unknown_error") ||
        text.includes("authentication error") ||
        text.includes("身份验证错误") ||
        text.includes("验证过程中出错")
      );
    };
    const push = () => {
      if (!shouldMark()) return;
      if (!document.title.startsWith(PREFIX)) {
        document.title = PREFIX + "unknown_error";
      }
    };
    push();
    const root = document.documentElement || document.body;
    if (root) {
      const obs = new MutationObserver(push);
      obs.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }
    setInterval(push, 700);
  } catch (_) {}
})();
"#;
pub(crate) const AUTH_ERROR_KEYWORDS: [&str; 11] = [
    "not logged in",
    "unauthorized",
    "forbidden",
    "invalid_grant",
    "invalid token",
    "login required",
    "authentication",
    "401",
    "402",
    "403",
    "deactivated_workspace",
];
pub(crate) const HARD_QUOTA_ERROR_KEYWORDS: [&str; 10] = [
    "usage_limit_exceeded",
    "usage limit has been reached",
    "usage limit",
    "insufficient_quota",
    "rate_limit_exceeded",
    "rate limit",
    "no quota",
    "quota exhausted",
    "额度",
    "429",
];
pub(crate) const SOFT_TRIGGER_FIVE_HOUR_THRESHOLD: i64 = 5;
pub(crate) const SOFT_TRIGGER_ONE_WEEK_THRESHOLD: i64 = 2;
pub(crate) const CANDIDATE_MIN_FIVE_HOUR: i64 = 10;
pub(crate) const CANDIDATE_MIN_ONE_WEEK: i64 = 5;
pub(crate) const AUTO_SWITCH_GUARD_WAIT_MS: u64 = 250;
pub(crate) const AUTO_SWITCH_SWITCH_COOLDOWN_MS: i64 = 2_000;
pub(crate) const AUTO_SWITCH_POST_SWITCH_SOFT_COOLDOWN_MS: i64 = 20_000;
pub(crate) const AUTO_SWITCH_NO_CANDIDATE_COOLDOWN_MS: i64 = 20_000;
pub(crate) const AUTO_SWITCH_SESSION_SCAN_INTERVAL_MS: i64 = 3_000;
pub(crate) const AUTO_SWITCH_SESSION_QUOTA_MAX_AGE_MS: i64 = 120_000;
pub(crate) const AUTO_SWITCH_CODEX_LOG_SCAN_INTERVAL_MS: i64 = 3_000;
pub(crate) const AUTO_SWITCH_OPENCODE_LOG_SCAN_INTERVAL_MS: i64 = 3_000;
pub(crate) const AUTO_SWITCH_LIVE_QUOTA_SYNC_INTERVAL_MS: i64 = 2_500;
pub(crate) const AUTO_SWITCH_LIVE_QUOTA_ERROR_COOLDOWN_MS: i64 = 12_000;
pub(crate) const AUTO_SWITCH_LIVE_QUOTA_TIMEOUT_SECONDS: u64 = 8;
pub(crate) const AUTO_SWITCH_CANDIDATE_REFRESH_TIMEOUT_SECONDS: u64 = 3;
pub(crate) const AUTO_SWITCH_CANDIDATE_REFRESH_PARALLELISM: usize = 3;
pub(crate) const OPENCODE_LOG_RECENT_WINDOW_MS: i64 = 120_000;
pub(crate) const CURRENT_QUOTA_CACHE_FRESH_MS: i64 = 500;
pub(crate) const GPT_CURRENT_QUOTA_CACHE_FRESH_MS: i64 = 5_000;
pub(crate) const CURRENT_QUOTA_CACHE_MAX_AGE_MS: i64 = 30 * 60 * 1000;
pub(crate) const CURRENT_QUOTA_ERROR_COOLDOWN_MS: i64 = 8_000;
pub(crate) const LIVE_QUOTA_STORE_SYNC_INTERVAL_MS: i64 = 5_000;
pub(crate) const APP_SERVER_TIMEOUT_DEFAULT_SECONDS: u64 = 14;
pub(crate) const APP_SERVER_TIMEOUT_POLL_SECONDS: u64 = 3;
pub(crate) const APP_SERVER_OPENCODE_POLL_TIMEOUT_SECONDS: u64 = 8;
pub(crate) const GPT_RATE_LIMIT_PUSH_READ_INTERVAL_MS: i64 = 20_000;
pub(crate) const GPT_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS: i64 = 3_000;
pub(crate) const OPENCODE_RATE_LIMIT_PUSH_READ_INTERVAL_MS: i64 = 20_000;
pub(crate) const OPENCODE_RATE_LIMIT_PUSH_RESTART_BACKOFF_MS: i64 = 3_000;
pub(crate) const APP_SERVER_DEBUG_ENV: &str = "CODEX_SWITCH_APP_SERVER_LOG";
pub(crate) const AUTO_SWITCH_THREAD_RECOVER_COOLDOWN_MS: i64 = 5_000;
pub(crate) const AUTO_SWITCH_THREAD_RECOVER_HARD_COOLDOWN_MS: i64 = 12_000;
pub(crate) const AUTO_SWITCH_NEW_CHAT_RESET_COOLDOWN_MS: i64 = 30_000;
pub(crate) const AUTO_SWITCH_STALE_RECOVER_WINDOW_MS: i64 = 45_000;
pub(crate) const AUTO_SWITCH_STALE_RECOVER_ESCALATE_COUNT: u32 = 2;
pub(crate) const AUTO_SWITCH_STATE_INDEX_PURGE_COOLDOWN_MS: i64 = 90_000;
pub(crate) const AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES: usize = 4;
pub(crate) const OPENAI_STATE_WINDOWS_SANDBOX_KEY: &str = "windows-sandbox-enabled";
pub(crate) const CODEX_SWITCH_HOOK_COMMAND_ID: &str = "chatgpt.codexSwitchRestartRuntime";
pub(crate) const CODEX_SWITCH_HOOK_ANCHOR: &str = r#"e.push(at.commands.registerCommand("chatgpt.dumpNuxState",()=>{l.dumpNuxState()}),at.commands.registerCommand("chatgpt.resetNuxState",()=>{l.resetNuxState()}))"#;
pub(crate) const CODEX_SWITCH_HOOK_FRAGMENT_V1: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",()=>{try{f.teardownProcess()}catch{};let ge=f.startCodexProcess();!ge.success&&ge.errorMessage&&K().error(ge.errorMessage)})"#;
pub(crate) const CODEX_SWITCH_HOOK_FRAGMENT_V2: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",async()=>{let ge;try{let ye=f.teardownProcess();ye&&typeof ye.then=="function"&&await ye}catch{};await new Promise(ye=>setTimeout(ye,120));ge=f.startCodexProcess();if(!ge.success){try{let ye=f.teardownProcess();ye&&typeof ye.then=="function"&&await ye}catch{};await new Promise(ye=>setTimeout(ye,220));ge=f.startCodexProcess()}!ge.success&&ge.errorMessage&&K().error(ge.errorMessage)})"#;
pub(crate) const CODEX_SWITCH_HOOK_WATCH_MARKER: &str = "codexSwitchAuthWatchV1";
pub(crate) const CODEX_SWITCH_HOOK_SIGNAL_MARKER: &str = "codexSwitchSignalWatchV1";
pub(crate) const CODEX_SWITCH_HOOK_KIRO_SIGNAL_MARKER: &str = "codexSwitchKiroSignalWatchV1";
pub(crate) const CODEX_SWITCH_HOOK_SIGNAL_FILE_NAME: &str = "hook-restart.signal";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER: &str = "codexSwitchNewChatWatchV9";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V8: &str = "codexSwitchNewChatWatchV8";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V7: &str = "codexSwitchNewChatWatchV7";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V6: &str = "codexSwitchNewChatWatchV6";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V5: &str = "codexSwitchNewChatWatchV5";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V4: &str = "codexSwitchNewChatWatchV4";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V3: &str = "codexSwitchNewChatWatchV3";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V2: &str = "codexSwitchNewChatWatchV2";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_LEGACY: &str = "codexSwitchNewChatWatchV1";
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_SIGNAL_FILE_NAME: &str = "hook-newchat.signal";
pub(crate) const CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT: &str = r#"(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Le=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Le)return;if(Se&&Le!==Se){let Pe;try{let ke=f.teardownProcess();ke&&typeof ke.then=="function"&&await ke}catch{};await new Promise(ke=>setTimeout(ke,120));Pe=f.startCodexProcess();if(!Pe.success){try{let ke=f.teardownProcess();ke&&typeof ke.then=="function"&&await ke}catch{};await new Promise(ke=>setTimeout(ke,220));Pe=f.startCodexProcess()}!Pe.success&&Pe.errorMessage&&K().error(Pe.errorMessage)}Se=Le}catch{}};Me();let Te=setInterval(()=>{Me()},1200);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT: &str = r#"(()=>{let ge=null;try{let codexSwitchSignalWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchSignalWatchV1.homedir(),".codex_account_switcher","hook-restart.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){let Le;try{let Pe=f.teardownProcess();Pe&&typeof Pe.then=="function"&&await Pe}catch{};await new Promise(Pe=>setTimeout(Pe,120));Le=f.startCodexProcess();if(!Le.success){try{let Pe=f.teardownProcess();Pe&&typeof Pe.then=="function"&&await Pe}catch{};await new Promise(Pe=>setTimeout(Pe,220));Le=f.startCodexProcess()}!Le.success&&Le.errorMessage&&K().error(Le.errorMessage)}Se=Te}catch{}};Me();let Te=setInterval(()=>{Me()},700);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_LEGACY: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV1.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){try{let Le=at.commands.executeCommand("chatgpt.newChat");Le&&typeof Le.then=="function"&&Le.catch(()=>{})}catch{}}Se=Te}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V2: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV2=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV2.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Te===Se)return;let Le=Se,Pe=Number(String(Te).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Te;if(!Ve)return;try{let qe=at.commands.executeCommand("chatgpt.openSidebar");qe&&typeof qe.then=="function"&&await qe.catch(()=>{});let Ue=at.commands.executeCommand("chatgpt.newChat");Ue&&typeof Ue.then=="function"&&await Ue.catch(()=>{});await new Promise(Ne=>setTimeout(Ne,80));let je=at.commands.executeCommand("chatgpt.newCodexPanel");je&&typeof je.then=="function"&&je.catch(()=>{})}catch{}}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V3: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV3=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV3.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Te===Se)return;let Le=Se,Pe=Number(String(Te).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Te;if(!Ve)return;try{let qe=at.commands.executeCommand("chatgpt.openSidebar");qe&&typeof qe.then=="function"&&await qe.catch(()=>{});let Ue=at.commands.executeCommand("chatgpt.newChat");Ue&&typeof Ue.then=="function"&&await Ue.catch(()=>{})}catch{}}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP: &str = r#"(()=>({dispose(){}}))()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V4: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV4=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV4.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Te===Se)return;let Le=Se,Pe=Number(String(Te).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Te;if(!Ve)return;try{let Ue=typeof pe!="undefined"&&pe&&typeof pe.triggerNewChatViaWebview=="function"?pe.triggerNewChatViaWebview():at.commands.executeCommand("chatgpt.newChat");Ue&&typeof Ue.then=="function"&&await Ue.catch(()=>{})}catch{}}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V5: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV5=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV5.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Te===Se)return;let Le=Se,Pe=Number(String(Te).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Te;if(!Ve)return;try{if(typeof pe!="undefined"&&pe&&pe.newConversationFactory&&typeof pe.newConversationFactory.createNewConversation=="function"&&typeof pe.navigateToRoute=="function"){let qe=await pe.newConversationFactory.createNewConversation(),Ue=qe&&qe.response&&qe.response.thread&&qe.response.thread.id?String(qe.response.thread.id):"";if(Ue){let je=pe.navigateToRoute("/local/"+Ue);je&&typeof je.then=="function"&&await je.catch(()=>{})}}}catch{}}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V6: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV6=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV6.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Xe=0,Me=ms=>new Promise(Ne=>setTimeout(Ne,ms)),Te=async()=>{try{let Le=Date.now();if(Le-Xe<15000)return;Xe=Le;await Me(450);if(typeof pe!="undefined"&&pe&&pe.newConversationFactory&&typeof pe.newConversationFactory.createNewConversation=="function"&&typeof pe.navigateToRoute=="function"){let Pe="",ke=!1;try{let Ve=await pe.newConversationFactory.createNewConversation();Pe=Ve&&Ve.response&&Ve.response.thread&&Ve.response.thread.id?String(Ve.response.thread.id):""}catch{}if(Pe){for(let Ve=0;Ve<3;Ve++){try{let qe=pe.navigateToRoute("/local/"+Pe);qe&&typeof qe.then=="function"&&await qe;ke=!0;break}catch{}await Me(250)}}if(ke)return}let Ue=typeof pe!="undefined"&&pe&&typeof pe.triggerNewChatViaWebview=="function"?pe.triggerNewChatViaWebview():at.commands.executeCommand("chatgpt.newChat");Ue&&typeof Ue.then=="function"&&await Ue.catch(()=>{})}catch{}},je=async()=>{try{if(!be.existsSync(Ee))return;let Ne=be.readFileSync(Ee,"utf8").trim();if(!Ne)return;if(Ne===Se)return;let Le=Se,Pe=Number(String(Ne).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Ne;if(!Ve)return;await Te()}catch{}};je();let Ne=setInterval(()=>{je()},450);ge={dispose(){try{clearInterval(Ne)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V7: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV7=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV7.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Xe=0,Me=ms=>new Promise(Ne=>setTimeout(Ne,ms)),Te=async()=>{try{let Le=Date.now();if(Le-Xe<15000)return;Xe=Le;await Me(450);if(typeof pe!="undefined"&&pe&&pe.newConversationFactory&&typeof pe.newConversationFactory.createNewConversation=="function"&&typeof pe.navigateToRoute=="function"){let Pe="",ke=!1;try{let Ve=await pe.newConversationFactory.createNewConversation();Pe=Ve&&Ve.response&&Ve.response.thread&&Ve.response.thread.id?String(Ve.response.thread.id):""}catch{}if(Pe){for(let Ve=0;Ve<3;Ve++){try{let qe=pe.navigateToRoute("/local/"+Pe);qe&&typeof qe.then=="function"&&await qe;ke=!0;break}catch{}await Me(250)}}if(ke)return}}catch{}},je=async()=>{try{if(!be.existsSync(Ee))return;let Ne=be.readFileSync(Ee,"utf8").trim();if(!Ne)return;if(Ne===Se)return;let Le=Se,Pe=Number(String(Ne).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Ne;if(!Ve)return;await Te()}catch{}};je();let Ne=setInterval(()=>{je()},450);ge={dispose(){try{clearInterval(Ne)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V8: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV8=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV8.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Xe=0,Me=ms=>new Promise(Ne=>setTimeout(Ne,ms)),Te=async()=>{try{let Le=Date.now();if(Le-Xe<15000)return;Xe=Le;await Me(250);if(typeof pe!="undefined"&&pe&&typeof pe.triggerNewChatViaWebview=="function"){let Pe=pe.triggerNewChatViaWebview();Pe&&typeof Pe.then=="function"&&await Pe.catch(()=>{})}}catch{}},je=async()=>{try{if(!be.existsSync(Ee))return;let Ne=be.readFileSync(Ee,"utf8").trim();if(!Ne)return;if(Ne===Se)return;let Le=Se,Pe=Number(String(Ne).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Ne;if(!Ve)return;await Te()}catch{}};je();let Ne=setInterval(()=>{je()},450);ge={dispose(){try{clearInterval(Ne)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV9=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV9.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Xe=0,Me=ms=>new Promise(Ne=>setTimeout(Ne,ms)),Te=async()=>{try{let Le=Date.now();if(Le-Xe<15000)return;Xe=Le;await Me(250);let Pe=at.commands.executeCommand("chatgpt.newChat");Pe&&typeof Pe.then=="function"&&await Pe.catch(()=>{})}catch{}},je=async()=>{try{if(!be.existsSync(Ee))return;let Ne=be.readFileSync(Ee,"utf8").trim();if(!Ne)return;if(Ne===Se)return;let Le=Se,Pe=Number(String(Ne).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Ne;if(!Ve)return;await Te()}catch{}};je();let Ne=setInterval(()=>{je()},450);ge={dispose(){try{clearInterval(Ne)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_FRAGMENT_V3: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",async()=>{let ge;try{let ye=f.teardownProcess();ye&&typeof ye.then=="function"&&await ye}catch{};await new Promise(ye=>setTimeout(ye,120));ge=f.startCodexProcess();if(!ge.success){try{let ye=f.teardownProcess();ye&&typeof ye.then=="function"&&await ye}catch{};await new Promise(ye=>setTimeout(ye,220));ge=f.startCodexProcess()}!ge.success&&ge.errorMessage&&K().error(ge.errorMessage)}),(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Le=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Le)return;if(Se&&Le!==Se){let Pe;try{let ke=f.teardownProcess();ke&&typeof ke.then=="function"&&await ke}catch{};await new Promise(ke=>setTimeout(ke,120));Pe=f.startCodexProcess();if(!Pe.success){try{let ke=f.teardownProcess();ke&&typeof ke.then=="function"&&await ke}catch{};await new Promise(ke=>setTimeout(ke,220));Pe=f.startCodexProcess()}!Pe.success&&Pe.errorMessage&&K().error(Pe.errorMessage)}Se=Le}catch{}};Me();let Te=setInterval(()=>{Me()},1200);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_ACCEL_MARKER: &str = "codexSwitchRestartExtHostV1";
pub(crate) const CODEX_SWITCH_HOOK_TOAST_MARKER: &str = "codexSwitchToastV1";
pub(crate) const CODEX_SWITCH_HOOK_FRAGMENT_ACCEL_V1: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}})"#;
pub(crate) const CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL_V1: &str = r#"(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Pe=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Pe)return;if(Se&&Pe!==Se){await Me()}Se=Pe}catch{}};Le();let Te=setInterval(()=>{Le()},1200);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL_V2: &str = r#"(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Pe=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Pe)return;if(Se&&Pe!==Se){await Me()}Se=Pe}catch{}};Le();let Te=setInterval(()=>{Le()},500);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL_V1: &str = r#"(()=>{let ge=null;try{let codexSwitchSignalWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchSignalWatchV1.homedir(),".codex_account_switcher","hook-restart.signal"),Se="",Me=async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){await Me()}Se=Te}catch{}};Le();let Te=setInterval(()=>{Le()},700);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL_V2: &str = r#"(()=>{let ge=null;try{let codexSwitchSignalWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchSignalWatchV1.homedir(),".codex_account_switcher","hook-restart.signal"),Se="",Me=async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){await Me()}Se=Te}catch{}};Le();let Te=setInterval(()=>{Le()},300);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_FRAGMENT_ACCEL: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",async()=>{try{try{let codexSwitchToastV1=at&&at.window&&typeof at.window.showInformationMessage=="function"?at.window.showInformationMessage("Codex Switch: Account switched, reconnecting Codex..."):null;codexSwitchToastV1&&typeof codexSwitchToastV1.then=="function"&&codexSwitchToastV1.catch(()=>{})}catch{}await new Promise(codexSwitchToastDelay=>setTimeout(codexSwitchToastDelay,260));let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}})"#;
pub(crate) const CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL: &str = r#"(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{try{let codexSwitchToastV1=at&&at.window&&typeof at.window.showInformationMessage=="function"?at.window.showInformationMessage("Codex Switch: Account switched, reconnecting Codex..."):null;codexSwitchToastV1&&typeof codexSwitchToastV1.then=="function"&&codexSwitchToastV1.catch(()=>{})}catch{}await new Promise(codexSwitchToastDelay=>setTimeout(codexSwitchToastDelay,260));let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Pe=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Pe)return;if(Se&&Pe!==Se){await Me()}Se=Pe}catch{}};Le();let Te=setInterval(()=>{Le()},500);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL: &str = r#"(()=>{let ge=null;try{let codexSwitchSignalWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchSignalWatchV1.homedir(),".codex_account_switcher","hook-restart.signal"),Se="",Me=async()=>{try{try{let codexSwitchToastV1=at&&at.window&&typeof at.window.showInformationMessage=="function"?at.window.showInformationMessage("Codex Switch: Account switched, reconnecting Codex..."):null;codexSwitchToastV1&&typeof codexSwitchToastV1.then=="function"&&codexSwitchToastV1.catch(()=>{})}catch{}await new Promise(codexSwitchToastDelay=>setTimeout(codexSwitchToastDelay,260));let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){await Me()}Se=Te}catch{}};Le();let Te=setInterval(()=>{Le()},300);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_KIRO_SIGNAL_WATCH_FRAGMENT: &str = r#"(()=>{let codexSwitchKiroSignalWatchV1=null;try{const vscode=require("vscode"),os=require("os"),path=require("path"),fs=require("fs"),signalPath=path.join(os.homedir(),".codex_account_switcher","hook-restart.signal");let previous="";const restart=async()=>{try{await vscode.commands.executeCommand("workbench.action.restartExtensionHost")}catch{try{await vscode.commands.executeCommand("workbench.action.reloadWindow")}catch{}}},tick=async()=>{try{if(!fs.existsSync(signalPath))return;const token=String(fs.readFileSync(signalPath,"utf8")||"").trim();if(!token)return;if(previous&&token!==previous)await restart();previous=token}catch{}};void tick();const timer=setInterval(()=>{void tick()},300);codexSwitchKiroSignalWatchV1={dispose(){try{clearInterval(timer)}catch{}}}}catch{}return codexSwitchKiroSignalWatchV1||{dispose(){}}})()"#;
pub(crate) const CODEX_SWITCH_HOOK_BACKUP_SUFFIX: &str = ".codex-switch.bak";
