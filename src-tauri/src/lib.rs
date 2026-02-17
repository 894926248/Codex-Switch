use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine as _;
use chrono::{Local, TimeZone, Utc};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rand::{thread_rng, Rng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering as CmpOrdering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tar::{Archive, Builder, Header};
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn command_no_window<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

const AUTH_FILE_NAME: &str = "auth.json";
const CAP_SID_FILE_NAME: &str = "cap_sid";
const CONFIG_FILE_NAME: &str = "config.toml";
const SWITCHER_HOME_DIR: &str = ".codex_account_switcher";
const PROFILES_FILE_NAME: &str = "profiles.json";
const PROFILES_DIR_NAME: &str = "profiles";
const BACKUPS_DIR_NAME: &str = "backups";
const APP_NAME: &str = "Codex Switch";
const BACKUP_MANIFEST_NAME: &str = "manifest.json";
const BACKUP_FORMAT_NAME: &str = "codex-switch-backup";
const BACKUP_SCHEMA_VERSION: u32 = 1;
const BACKUP_SWITCHER_PREFIX: &str = "switcher";
const BACKUP_CODEX_PREFIX: &str = "codex";
const PROFILE_SUPPORT_GPT_KEY: &str = "gpt";
const PROFILE_SUPPORT_OPENCODE_KEY: &str = "opencode";
const OPENCODE_PROVIDER_ID: &str = "openai";
const OPENCODE_OPENAI_SNAPSHOT_FILE_NAME: &str = "opencode.openai.json";
const OPENCODE_AUTH_BACKUP_FILE_NAME: &str = "opencode.auth.json";
const AGENTS_HOME_DIR: &str = ".agents";
const SKILLS_DIR_NAME: &str = "skills";
const SKILL_MANIFEST_FILE_NAME: &str = "SKILL.md";
const SKILL_TARGETS_FILE_NAME: &str = "skill-targets.json";
const LOGIN_WEBVIEW_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";
const WORKSPACE_CAPTURE_TITLE_PREFIX: &str = "__CODEX_WS__";
const LOGIN_ERROR_CAPTURE_TITLE_PREFIX: &str = "__CODEX_ERR__";
const LOGIN_CALLBACK_PORT: u16 = 1455;
const CHATGPT_DEVICE_AUTH_ISSUER: &str = "https://auth.openai.com";
const CHATGPT_DEVICE_AUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_DEVICE_AUTH_TIMEOUT_SECS: u64 = 15 * 60;
const CHATGPT_BROWSER_OAUTH_TIMEOUT_SECS: u64 = 15 * 60;
const WORKSPACE_CAPTURE_SCRIPT: &str = r#"
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
const LOGIN_ERROR_CAPTURE_SCRIPT: &str = r#"
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
const AUTH_ERROR_KEYWORDS: [&str; 9] = [
    "not logged in",
    "unauthorized",
    "forbidden",
    "invalid_grant",
    "invalid token",
    "login required",
    "authentication",
    "401",
    "403",
];
const HARD_QUOTA_ERROR_KEYWORDS: [&str; 8] = [
    "usage_limit_exceeded",
    "insufficient_quota",
    "rate_limit_exceeded",
    "rate limit",
    "no quota",
    "quota exhausted",
    "额度",
    "429",
];
const SOFT_TRIGGER_FIVE_HOUR_THRESHOLD: i64 = 5;
const SOFT_TRIGGER_ONE_WEEK_THRESHOLD: i64 = 2;
const CANDIDATE_MIN_FIVE_HOUR: i64 = 10;
const CANDIDATE_MIN_ONE_WEEK: i64 = 5;
const AUTO_SWITCH_GUARD_WAIT_MS: u64 = 250;
const AUTO_SWITCH_SWITCH_COOLDOWN_MS: i64 = 2_000;
const AUTO_SWITCH_NO_CANDIDATE_COOLDOWN_MS: i64 = 20_000;
const AUTO_SWITCH_SESSION_SCAN_INTERVAL_MS: i64 = 3_000;
const AUTO_SWITCH_SESSION_QUOTA_MAX_AGE_MS: i64 = 120_000;
const AUTO_SWITCH_CODEX_LOG_SCAN_INTERVAL_MS: i64 = 3_000;
const AUTO_SWITCH_OPENCODE_LOG_SCAN_INTERVAL_MS: i64 = 3_000;
const OPENCODE_LOG_RECENT_WINDOW_MS: i64 = 120_000;
const CURRENT_QUOTA_CACHE_FRESH_MS: i64 = 15_000;
const CURRENT_QUOTA_CACHE_MAX_AGE_MS: i64 = 30 * 60 * 1000;
const AUTO_SWITCH_THREAD_RECOVER_COOLDOWN_MS: i64 = 5_000;
const AUTO_SWITCH_THREAD_RECOVER_HARD_COOLDOWN_MS: i64 = 12_000;
const AUTO_SWITCH_NEW_CHAT_RESET_COOLDOWN_MS: i64 = 30_000;
const AUTO_SWITCH_STALE_RECOVER_WINDOW_MS: i64 = 45_000;
const AUTO_SWITCH_STALE_RECOVER_ESCALATE_COUNT: u32 = 2;
const AUTO_SWITCH_STATE_INDEX_PURGE_COOLDOWN_MS: i64 = 90_000;
const AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES: usize = 4;
const OPENAI_STATE_WINDOWS_SANDBOX_KEY: &str = "windows-sandbox-enabled";
const CODEX_SWITCH_HOOK_COMMAND_ID: &str = "chatgpt.codexSwitchRestartRuntime";
const CODEX_SWITCH_HOOK_ANCHOR: &str = r#"e.push(at.commands.registerCommand("chatgpt.dumpNuxState",()=>{l.dumpNuxState()}),at.commands.registerCommand("chatgpt.resetNuxState",()=>{l.resetNuxState()}))"#;
const CODEX_SWITCH_HOOK_FRAGMENT_V1: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",()=>{try{f.teardownProcess()}catch{};let ge=f.startCodexProcess();!ge.success&&ge.errorMessage&&K().error(ge.errorMessage)})"#;
const CODEX_SWITCH_HOOK_FRAGMENT_V2: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",async()=>{let ge;try{let ye=f.teardownProcess();ye&&typeof ye.then=="function"&&await ye}catch{};await new Promise(ye=>setTimeout(ye,120));ge=f.startCodexProcess();if(!ge.success){try{let ye=f.teardownProcess();ye&&typeof ye.then=="function"&&await ye}catch{};await new Promise(ye=>setTimeout(ye,220));ge=f.startCodexProcess()}!ge.success&&ge.errorMessage&&K().error(ge.errorMessage)})"#;
const CODEX_SWITCH_HOOK_WATCH_MARKER: &str = "codexSwitchAuthWatchV1";
const CODEX_SWITCH_HOOK_SIGNAL_MARKER: &str = "codexSwitchSignalWatchV1";
const CODEX_SWITCH_HOOK_SIGNAL_FILE_NAME: &str = "hook-restart.signal";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER: &str = "codexSwitchNewChatWatchV9";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V8: &str = "codexSwitchNewChatWatchV8";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V7: &str = "codexSwitchNewChatWatchV7";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V6: &str = "codexSwitchNewChatWatchV6";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V5: &str = "codexSwitchNewChatWatchV5";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V4: &str = "codexSwitchNewChatWatchV4";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V3: &str = "codexSwitchNewChatWatchV3";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V2: &str = "codexSwitchNewChatWatchV2";
const CODEX_SWITCH_HOOK_NEWCHAT_MARKER_LEGACY: &str = "codexSwitchNewChatWatchV1";
const CODEX_SWITCH_HOOK_NEWCHAT_SIGNAL_FILE_NAME: &str = "hook-newchat.signal";
const CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT: &str = r#"(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Le=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Le)return;if(Se&&Le!==Se){let Pe;try{let ke=f.teardownProcess();ke&&typeof ke.then=="function"&&await ke}catch{};await new Promise(ke=>setTimeout(ke,120));Pe=f.startCodexProcess();if(!Pe.success){try{let ke=f.teardownProcess();ke&&typeof ke.then=="function"&&await ke}catch{};await new Promise(ke=>setTimeout(ke,220));Pe=f.startCodexProcess()}!Pe.success&&Pe.errorMessage&&K().error(Pe.errorMessage)}Se=Le}catch{}};Me();let Te=setInterval(()=>{Me()},1200);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT: &str = r#"(()=>{let ge=null;try{let codexSwitchSignalWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchSignalWatchV1.homedir(),".codex_account_switcher","hook-restart.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){let Le;try{let Pe=f.teardownProcess();Pe&&typeof Pe.then=="function"&&await Pe}catch{};await new Promise(Pe=>setTimeout(Pe,120));Le=f.startCodexProcess();if(!Le.success){try{let Pe=f.teardownProcess();Pe&&typeof Pe.then=="function"&&await Pe}catch{};await new Promise(Pe=>setTimeout(Pe,220));Le=f.startCodexProcess()}!Le.success&&Le.errorMessage&&K().error(Le.errorMessage)}Se=Te}catch{}};Me();let Te=setInterval(()=>{Me()},700);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_LEGACY: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV1.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){try{let Le=at.commands.executeCommand("chatgpt.newChat");Le&&typeof Le.then=="function"&&Le.catch(()=>{})}catch{}}Se=Te}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V2: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV2=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV2.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Te===Se)return;let Le=Se,Pe=Number(String(Te).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Te;if(!Ve)return;try{let qe=at.commands.executeCommand("chatgpt.openSidebar");qe&&typeof qe.then=="function"&&await qe.catch(()=>{});let Ue=at.commands.executeCommand("chatgpt.newChat");Ue&&typeof Ue.then=="function"&&await Ue.catch(()=>{});await new Promise(Ne=>setTimeout(Ne,80));let je=at.commands.executeCommand("chatgpt.newCodexPanel");je&&typeof je.then=="function"&&je.catch(()=>{})}catch{}}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V3: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV3=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV3.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Te===Se)return;let Le=Se,Pe=Number(String(Te).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Te;if(!Ve)return;try{let qe=at.commands.executeCommand("chatgpt.openSidebar");qe&&typeof qe.then=="function"&&await qe.catch(()=>{});let Ue=at.commands.executeCommand("chatgpt.newChat");Ue&&typeof Ue.then=="function"&&await Ue.catch(()=>{})}catch{}}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP: &str = r#"(()=>({dispose(){}}))()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V4: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV4=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV4.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Te===Se)return;let Le=Se,Pe=Number(String(Te).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Te;if(!Ve)return;try{let Ue=typeof pe!="undefined"&&pe&&typeof pe.triggerNewChatViaWebview=="function"?pe.triggerNewChatViaWebview():at.commands.executeCommand("chatgpt.newChat");Ue&&typeof Ue.then=="function"&&await Ue.catch(()=>{})}catch{}}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V5: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV5=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV5.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Te===Se)return;let Le=Se,Pe=Number(String(Te).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Te;if(!Ve)return;try{if(typeof pe!="undefined"&&pe&&pe.newConversationFactory&&typeof pe.newConversationFactory.createNewConversation=="function"&&typeof pe.navigateToRoute=="function"){let qe=await pe.newConversationFactory.createNewConversation(),Ue=qe&&qe.response&&qe.response.thread&&qe.response.thread.id?String(qe.response.thread.id):"";if(Ue){let je=pe.navigateToRoute("/local/"+Ue);je&&typeof je.then=="function"&&await je.catch(()=>{})}}}catch{}}catch{}};Me();let Te=setInterval(()=>{Me()},450);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V6: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV6=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV6.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Xe=0,Me=ms=>new Promise(Ne=>setTimeout(Ne,ms)),Te=async()=>{try{let Le=Date.now();if(Le-Xe<15000)return;Xe=Le;await Me(450);if(typeof pe!="undefined"&&pe&&pe.newConversationFactory&&typeof pe.newConversationFactory.createNewConversation=="function"&&typeof pe.navigateToRoute=="function"){let Pe="",ke=!1;try{let Ve=await pe.newConversationFactory.createNewConversation();Pe=Ve&&Ve.response&&Ve.response.thread&&Ve.response.thread.id?String(Ve.response.thread.id):""}catch{}if(Pe){for(let Ve=0;Ve<3;Ve++){try{let qe=pe.navigateToRoute("/local/"+Pe);qe&&typeof qe.then=="function"&&await qe;ke=!0;break}catch{}await Me(250)}}if(ke)return}let Ue=typeof pe!="undefined"&&pe&&typeof pe.triggerNewChatViaWebview=="function"?pe.triggerNewChatViaWebview():at.commands.executeCommand("chatgpt.newChat");Ue&&typeof Ue.then=="function"&&await Ue.catch(()=>{})}catch{}},je=async()=>{try{if(!be.existsSync(Ee))return;let Ne=be.readFileSync(Ee,"utf8").trim();if(!Ne)return;if(Ne===Se)return;let Le=Se,Pe=Number(String(Ne).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Ne;if(!Ve)return;await Te()}catch{}};je();let Ne=setInterval(()=>{je()},450);ge={dispose(){try{clearInterval(Ne)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V7: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV7=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV7.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Xe=0,Me=ms=>new Promise(Ne=>setTimeout(Ne,ms)),Te=async()=>{try{let Le=Date.now();if(Le-Xe<15000)return;Xe=Le;await Me(450);if(typeof pe!="undefined"&&pe&&pe.newConversationFactory&&typeof pe.newConversationFactory.createNewConversation=="function"&&typeof pe.navigateToRoute=="function"){let Pe="",ke=!1;try{let Ve=await pe.newConversationFactory.createNewConversation();Pe=Ve&&Ve.response&&Ve.response.thread&&Ve.response.thread.id?String(Ve.response.thread.id):""}catch{}if(Pe){for(let Ve=0;Ve<3;Ve++){try{let qe=pe.navigateToRoute("/local/"+Pe);qe&&typeof qe.then=="function"&&await qe;ke=!0;break}catch{}await Me(250)}}if(ke)return}}catch{}},je=async()=>{try{if(!be.existsSync(Ee))return;let Ne=be.readFileSync(Ee,"utf8").trim();if(!Ne)return;if(Ne===Se)return;let Le=Se,Pe=Number(String(Ne).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Ne;if(!Ve)return;await Te()}catch{}};je();let Ne=setInterval(()=>{je()},450);ge={dispose(){try{clearInterval(Ne)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V8: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV8=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV8.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Xe=0,Me=ms=>new Promise(Ne=>setTimeout(Ne,ms)),Te=async()=>{try{let Le=Date.now();if(Le-Xe<15000)return;Xe=Le;await Me(250);if(typeof pe!="undefined"&&pe&&typeof pe.triggerNewChatViaWebview=="function"){let Pe=pe.triggerNewChatViaWebview();Pe&&typeof Pe.then=="function"&&await Pe.catch(()=>{})}}catch{}},je=async()=>{try{if(!be.existsSync(Ee))return;let Ne=be.readFileSync(Ee,"utf8").trim();if(!Ne)return;if(Ne===Se)return;let Le=Se,Pe=Number(String(Ne).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Ne;if(!Ve)return;await Te()}catch{}};je();let Ne=setInterval(()=>{je()},450);ge={dispose(){try{clearInterval(Ne)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT: &str = r#"(()=>{let ge=null;try{let codexSwitchNewChatWatchV9=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchNewChatWatchV9.homedir(),".codex_account_switcher","hook-newchat.signal"),Se="",Xe=0,Me=ms=>new Promise(Ne=>setTimeout(Ne,ms)),Te=async()=>{try{let Le=Date.now();if(Le-Xe<15000)return;Xe=Le;await Me(250);let Pe=at.commands.executeCommand("chatgpt.newChat");Pe&&typeof Pe.then=="function"&&await Pe.catch(()=>{})}catch{}},je=async()=>{try{if(!be.existsSync(Ee))return;let Ne=be.readFileSync(Ee,"utf8").trim();if(!Ne)return;if(Ne===Se)return;let Le=Se,Pe=Number(String(Ne).split("-")[0]),ke=Number.isFinite(Pe)?Date.now()-Pe:1/0,Ve=!!Le||ke>=0&&ke<=15000;Se=Ne;if(!Ve)return;await Te()}catch{}};je();let Ne=setInterval(()=>{je()},450);ge={dispose(){try{clearInterval(Ne)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_FRAGMENT_V3: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",async()=>{let ge;try{let ye=f.teardownProcess();ye&&typeof ye.then=="function"&&await ye}catch{};await new Promise(ye=>setTimeout(ye,120));ge=f.startCodexProcess();if(!ge.success){try{let ye=f.teardownProcess();ye&&typeof ye.then=="function"&&await ye}catch{};await new Promise(ye=>setTimeout(ye,220));ge=f.startCodexProcess()}!ge.success&&ge.errorMessage&&K().error(ge.errorMessage)}),(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Le=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Le)return;if(Se&&Le!==Se){let Pe;try{let ke=f.teardownProcess();ke&&typeof ke.then=="function"&&await ke}catch{};await new Promise(ke=>setTimeout(ke,120));Pe=f.startCodexProcess();if(!Pe.success){try{let ke=f.teardownProcess();ke&&typeof ke.then=="function"&&await ke}catch{};await new Promise(ke=>setTimeout(ke,220));Pe=f.startCodexProcess()}!Pe.success&&Pe.errorMessage&&K().error(Pe.errorMessage)}Se=Le}catch{}};Me();let Te=setInterval(()=>{Me()},1200);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_ACCEL_MARKER: &str = "codexSwitchRestartExtHostV1";
const CODEX_SWITCH_HOOK_TOAST_MARKER: &str = "codexSwitchToastV1";
const CODEX_SWITCH_HOOK_FRAGMENT_ACCEL_V1: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}})"#;
const CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL_V1: &str = r#"(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Pe=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Pe)return;if(Se&&Pe!==Se){await Me()}Se=Pe}catch{}};Le();let Te=setInterval(()=>{Le()},1200);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL_V2: &str = r#"(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Pe=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Pe)return;if(Se&&Pe!==Se){await Me()}Se=Pe}catch{}};Le();let Te=setInterval(()=>{Le()},500);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL_V1: &str = r#"(()=>{let ge=null;try{let codexSwitchSignalWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchSignalWatchV1.homedir(),".codex_account_switcher","hook-restart.signal"),Se="",Me=async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){await Me()}Se=Te}catch{}};Le();let Te=setInterval(()=>{Le()},700);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL_V2: &str = r#"(()=>{let ge=null;try{let codexSwitchSignalWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchSignalWatchV1.homedir(),".codex_account_switcher","hook-restart.signal"),Se="",Me=async()=>{try{let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){await Me()}Se=Te}catch{}};Le();let Te=setInterval(()=>{Le()},300);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_FRAGMENT_ACCEL: &str = r#"at.commands.registerCommand("chatgpt.codexSwitchRestartRuntime",async()=>{try{try{let codexSwitchToastV1=at&&at.window&&typeof at.window.showInformationMessage=="function"?at.window.showInformationMessage("Codex Switch: Account switched, reconnecting Codex..."):null;codexSwitchToastV1&&typeof codexSwitchToastV1.then=="function"&&codexSwitchToastV1.catch(()=>{})}catch{}await new Promise(codexSwitchToastDelay=>setTimeout(codexSwitchToastDelay,260));let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}})"#;
const CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL: &str = r#"(()=>{let ge=null;try{let codexSwitchAuthWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchAuthWatchV1.homedir(),".codex","auth.json"),Se="",Me=async()=>{try{try{let codexSwitchToastV1=at&&at.window&&typeof at.window.showInformationMessage=="function"?at.window.showInformationMessage("Codex Switch: Account switched, reconnecting Codex..."):null;codexSwitchToastV1&&typeof codexSwitchToastV1.then=="function"&&codexSwitchToastV1.catch(()=>{})}catch{}await new Promise(codexSwitchToastDelay=>setTimeout(codexSwitchToastDelay,260));let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=JSON.parse(be.readFileSync(Ee,"utf8")),Pe=Te&&Te.tokens&&Te.tokens.account_id?String(Te.tokens.account_id):"";if(!Pe)return;if(Se&&Pe!==Se){await Me()}Se=Pe}catch{}};Le();let Te=setInterval(()=>{Le()},500);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL: &str = r#"(()=>{let ge=null;try{let codexSwitchSignalWatchV1=require("os"),ye=require("path"),be=require("fs"),Ee=ye.join(codexSwitchSignalWatchV1.homedir(),".codex_account_switcher","hook-restart.signal"),Se="",Me=async()=>{try{try{let codexSwitchToastV1=at&&at.window&&typeof at.window.showInformationMessage=="function"?at.window.showInformationMessage("Codex Switch: Account switched, reconnecting Codex..."):null;codexSwitchToastV1&&typeof codexSwitchToastV1.then=="function"&&codexSwitchToastV1.catch(()=>{})}catch{}await new Promise(codexSwitchToastDelay=>setTimeout(codexSwitchToastDelay,260));let codexSwitchRestartExtHostV1=at.commands.executeCommand("workbench.action.restartExtensionHost");codexSwitchRestartExtHostV1&&typeof codexSwitchRestartExtHostV1.then=="function"&&await codexSwitchRestartExtHostV1.catch(()=>{})}catch{}},Le=async()=>{try{if(!be.existsSync(Ee))return;let Te=be.readFileSync(Ee,"utf8").trim();if(!Te)return;if(Se&&Te!==Se){await Me()}Se=Te}catch{}};Le();let Te=setInterval(()=>{Le()},300);ge={dispose(){try{clearInterval(Te)}catch{}}}}catch{}return ge||{dispose(){}}})()"#;
const CODEX_SWITCH_HOOK_BACKUP_SUFFIX: &str = ".codex-switch.bak";

type CmdResult<T> = Result<T, String>;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WindowQuota {
    window_minutes: Option<i64>,
    used_percent: Option<i64>,
    remaining_percent: Option<i64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AccountQuota {
    email: Option<String>,
    workspace_name: Option<String>,
    workspace_id: Option<String>,
    plan_type: Option<String>,
    five_hour: Option<WindowQuota>,
    one_week: Option<WindowQuota>,
}

#[derive(Debug, Clone, Default)]
struct CurrentQuotaRuntimeCache {
    quota: Option<AccountQuota>,
    fetched_at_ms: i64,
    last_error: Option<String>,
    last_error_at_ms: i64,
}

static CURRENT_QUOTA_RUNTIME_CACHE: OnceLock<Mutex<CurrentQuotaRuntimeCache>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoreData {
    #[serde(default)]
    active_profile: Option<String>,
    #[serde(default)]
    profiles: BTreeMap<String, Value>,
    #[serde(default)]
    profile_order: Vec<String>,
    #[serde(default)]
    last_keepalive_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CurrentStatusView {
    email: Option<String>,
    workspace_name: Option<String>,
    workspace_id: Option<String>,
    display_workspace: String,
    five_hour_remaining_percent: Option<i64>,
    five_hour_resets_at: Option<i64>,
    one_week_remaining_percent: Option<i64>,
    one_week_resets_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileSupportView {
    gpt: bool,
    opencode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileView {
    name: String,
    email: Option<String>,
    workspace_name: Option<String>,
    workspace_id: Option<String>,
    workspace_alias: Option<String>,
    support: ProfileSupportView,
    display_workspace: String,
    five_hour_remaining_percent: Option<i64>,
    five_hour_resets_at: Option<i64>,
    one_week_remaining_percent: Option<i64>,
    one_week_resets_at: Option<i64>,
    last_checked_at: Option<String>,
    last_error: Option<String>,
    status: String,
    is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardData {
    app_name: String,
    active_profile: Option<String>,
    current: Option<CurrentStatusView>,
    current_error: Option<String>,
    last_keepalive_at: Option<i64>,
    profiles: Vec<ProfileView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AutoSwitchTickResult {
    action: String,
    message: Option<String>,
    switched_to: Option<String>,
    reload_triggered: bool,
    pending_reason: Option<String>,
    dashboard: Option<DashboardData>,
}

impl AutoSwitchTickResult {
    fn new(action: &str) -> Self {
        Self {
            action: action.to_string(),
            message: None,
            switched_to: None,
            reload_triggered: false,
            pending_reason: None,
            dashboard: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VsCodeStatusView {
    running: bool,
    process_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexExtensionInfoView {
    current_version: Option<String>,
    all_versions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeMonitorStatusView {
    auth_ready: bool,
    log_ready: bool,
    log_recent: bool,
    last_log_age_ms: Option<i64>,
    activity_recent: bool,
    last_activity_age_ms: Option<i64>,
    activity_source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillEntryView {
    id: String,
    name: String,
    description: String,
    codex_enabled: bool,
    opencode_enabled: bool,
    source: String,
    locations: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillsCatalogView {
    total: usize,
    codex_enabled_count: usize,
    opencode_enabled_count: usize,
    skills: Vec<SkillEntryView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillTargets {
    codex: bool,
    opencode: bool,
}

impl Default for SkillTargets {
    fn default() -> Self {
        Self {
            codex: true,
            opencode: true,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct SkillScanEntry {
    id: String,
    name: String,
    description: String,
    codex_source: bool,
    opencode_source: bool,
    locations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    format: String,
    schema_version: u32,
    created_at: String,
    file_count: usize,
    estimated_total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupExportResult {
    archive_path: String,
    file_count: usize,
    estimated_total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupImportResult {
    source_file_name: String,
    safeguard_archive_path: String,
    restored_count: usize,
    dashboard: DashboardData,
}

#[derive(Debug, Default)]
struct ParsedBackupPayload {
    switcher_entries: Vec<(PathBuf, Vec<u8>)>,
    codex_entries: Vec<(PathBuf, Vec<u8>)>,
    has_switcher_payload: bool,
    has_profiles_file_payload: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TriggerReason {
    Soft,
    Hard,
}

impl TriggerReason {
    fn as_str(self) -> &'static str {
        match self {
            TriggerReason::Soft => "soft",
            TriggerReason::Hard => "hard",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StaleRecoverReason {
    RolloutMissing,
    ThreadNotFound,
    RuntimeUnavailable,
    TurnMetadataTimeout,
}

impl StaleRecoverReason {
    fn message(self) -> &'static str {
        match self {
            StaleRecoverReason::RolloutMissing => "会话索引失效（no rollout found）",
            StaleRecoverReason::ThreadNotFound => "当前会话线程已失效（thread not found）",
            StaleRecoverReason::RuntimeUnavailable => {
                "Codex 运行时不可用（process is not available）"
            }
            StaleRecoverReason::TurnMetadataTimeout => {
                "Codex 元数据构建超时（turn_metadata timeout）"
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AutoSwitchMode {
    Gpt,
    OpenCode,
}

#[derive(Debug, Clone, Default)]
struct SessionQuotaSnapshot {
    five_hour_remaining_percent: Option<i64>,
    one_week_remaining_percent: Option<i64>,
    updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AutoSwitchSignature {
    event_seq: u64,
    user_seq: u64,
    open_turn_count: usize,
}

#[derive(Debug, Clone)]
struct SessionTailState {
    current_file: Option<PathBuf>,
    offset: u64,
    open_turns: HashSet<String>,
    event_seq: u64,
    user_seq: u64,
    quota: SessionQuotaSnapshot,
    hard_trigger_seq: u64,
    last_hard_trigger_reason: Option<String>,
    last_scan_at_ms: i64,
}

impl Default for SessionTailState {
    fn default() -> Self {
        Self {
            current_file: None,
            offset: 0,
            open_turns: HashSet::new(),
            event_seq: 0,
            user_seq: 0,
            quota: SessionQuotaSnapshot::default(),
            hard_trigger_seq: 0,
            last_hard_trigger_reason: None,
            last_scan_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct CodexLogTailState {
    current_file: Option<PathBuf>,
    offset: u64,
    thread_not_found_seq: u64,
    rollout_missing_seq: u64,
    runtime_unavailable_seq: u64,
    turn_metadata_timeout_seq: u64,
    runtime_restart_seq: u64,
    last_scan_at_ms: i64,
}

impl Default for CodexLogTailState {
    fn default() -> Self {
        Self {
            current_file: None,
            offset: 0,
            thread_not_found_seq: 0,
            rollout_missing_seq: 0,
            runtime_unavailable_seq: 0,
            turn_metadata_timeout_seq: 0,
            runtime_restart_seq: 0,
            last_scan_at_ms: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct OpenCodeLogTailState {
    current_file: Option<PathBuf>,
    offset: u64,
    session_error_seq: u64,
    last_scan_at_ms: i64,
}

impl Default for OpenCodeLogTailState {
    fn default() -> Self {
        Self {
            current_file: None,
            offset: 0,
            session_error_seq: 0,
            last_scan_at_ms: 0,
        }
    }
}

#[derive(Debug, Default)]
struct AutoSwitchRuntime {
    session: SessionTailState,
    codex_log: CodexLogTailState,
    opencode_log: OpenCodeLogTailState,
    monitor_mode: Option<AutoSwitchMode>,
    pending_reason: Option<TriggerReason>,
    last_observed_hard_trigger_seq: u64,
    last_observed_thread_not_found_seq: u64,
    last_observed_rollout_missing_seq: u64,
    last_observed_runtime_unavailable_seq: u64,
    last_observed_turn_metadata_timeout_seq: u64,
    last_observed_opencode_session_error_seq: u64,
    last_runtime_unavailable_recover_restart_seq: Option<u64>,
    last_thread_recover_user_seq: u64,
    last_stale_recover_reason: Option<StaleRecoverReason>,
    last_stale_recover_at_ms: i64,
    stale_recover_repeat_count: u32,
    last_new_chat_reset_at_ms: i64,
    last_new_chat_reset_user_seq: u64,
    switch_cooldown_until_ms: i64,
    no_candidate_until_ms: i64,
    thread_recover_cooldown_until_ms: i64,
    state_index_purge_cooldown_until_ms: i64,
    last_switch_applied_at_ms: i64,
}

#[derive(Debug, Default)]
struct AutoSwitchRuntimeState {
    inner: Mutex<AutoSwitchRuntime>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginProgressEvent {
    phase: String,
    message: String,
}

fn emit_login_progress(app: &tauri::AppHandle, phase: &str, message: &str) {
    let payload = LoginProgressEvent {
        phase: phase.to_string(),
        message: message.to_string(),
    };
    let _ = app.emit("codex-switch://login-progress", payload);
}

#[derive(Debug, Clone)]
struct TokenHealth {
    exists: bool,
    has_refresh: bool,
    access_exp: Option<i64>,
}

fn home_dir() -> CmdResult<PathBuf> {
    dirs::home_dir().ok_or_else(|| "无法定位用户目录。".to_string())
}

fn codex_home() -> CmdResult<PathBuf> {
    Ok(home_dir()?.join(".codex"))
}

fn opencode_data_dir() -> CmdResult<PathBuf> {
    Ok(home_dir()?.join(".local").join("share").join("opencode"))
}

fn opencode_auth_file() -> CmdResult<PathBuf> {
    Ok(opencode_data_dir()?.join(AUTH_FILE_NAME))
}

fn agents_home() -> CmdResult<PathBuf> {
    Ok(home_dir()?.join(AGENTS_HOME_DIR))
}

fn codex_skills_dir() -> CmdResult<PathBuf> {
    Ok(codex_home()?.join(SKILLS_DIR_NAME))
}

fn opencode_skills_dir() -> CmdResult<PathBuf> {
    Ok(agents_home()?.join(SKILLS_DIR_NAME))
}

fn skill_targets_file() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(SKILL_TARGETS_FILE_NAME))
}

fn normalize_skill_id(raw: &str) -> String {
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

fn trim_wrapping_quotes(raw: &str) -> String {
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

fn parse_skill_manifest(skill_dir: &Path) -> (String, String) {
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

fn read_skill_targets_map() -> CmdResult<BTreeMap<String, SkillTargets>> {
    let file = skill_targets_file()?;
    if !file.exists() {
        return Ok(BTreeMap::new());
    }
    let text = fs::read_to_string(&file)
        .map_err(|e| format!("读取技能开关配置失败 {}: {e}", file.display()))?;
    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str::<BTreeMap<String, SkillTargets>>(&text)
        .map_err(|e| format!("解析技能开关配置失败 {}: {e}", file.display()))
}

fn write_skill_targets_map(map: &BTreeMap<String, SkillTargets>) -> CmdResult<()> {
    fs::create_dir_all(switcher_home()?).map_err(|e| format!("创建目录失败: {e}"))?;
    let file = skill_targets_file()?;
    let text =
        serde_json::to_string_pretty(map).map_err(|e| format!("序列化技能开关配置失败: {e}"))?;
    fs::write(&file, format!("{text}\n"))
        .map_err(|e| format!("写入技能开关配置失败 {}: {e}", file.display()))
}

fn scan_skill_root(
    root: &Path,
    source: &str,
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
        if !path.join(SKILL_MANIFEST_FILE_NAME).exists() {
            continue;
        }
        let (name, description) = parse_skill_manifest(&path);
        let base_id = if name.trim().is_empty() {
            dir_name.to_string()
        } else {
            name.clone()
        };
        let id = normalize_skill_id(&base_id);
        if id.is_empty() {
            continue;
        }

        let row = merged.entry(id.clone()).or_insert_with(|| SkillScanEntry {
            id: id.clone(),
            name: name.clone(),
            description: description.clone(),
            codex_source: false,
            opencode_source: false,
            locations: Vec::new(),
        });
        if row.name.trim().is_empty() {
            row.name = name.clone();
        }
        if row.description.trim().is_empty() {
            row.description = description.clone();
        }
        if source == "codex" {
            row.codex_source = true;
        }
        if source == "opencode" {
            row.opencode_source = true;
        }

        let location = path.to_string_lossy().to_string();
        if !row.locations.iter().any(|item| item == &location) {
            row.locations.push(location);
        }
    }
    Ok(())
}

fn skill_source_label(entry: &SkillScanEntry) -> String {
    match (entry.codex_source, entry.opencode_source) {
        (true, true) => "Codex+OpenCode".to_string(),
        (true, false) => "Codex".to_string(),
        (false, true) => "OpenCode".to_string(),
        _ => "Local".to_string(),
    }
}

fn load_skills_catalog_internal() -> CmdResult<SkillsCatalogView> {
    let mut merged: BTreeMap<String, SkillScanEntry> = BTreeMap::new();
    scan_skill_root(&codex_skills_dir()?, "codex", &mut merged)?;
    scan_skill_root(&opencode_skills_dir()?, "opencode", &mut merged)?;

    let targets_map = read_skill_targets_map()?;
    let mut skills: Vec<SkillEntryView> = merged
        .into_values()
        .map(|entry| {
            let targets = targets_map
                .get(&entry.id)
                .cloned()
                .unwrap_or_else(SkillTargets::default);
            let source = skill_source_label(&entry);
            SkillEntryView {
                id: entry.id,
                name: entry.name,
                description: entry.description,
                codex_enabled: targets.codex,
                opencode_enabled: targets.opencode,
                source,
                locations: entry.locations,
            }
        })
        .collect();

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let codex_enabled_count = skills.iter().filter(|s| s.codex_enabled).count();
    let opencode_enabled_count = skills.iter().filter(|s| s.opencode_enabled).count();
    let total = skills.len();

    Ok(SkillsCatalogView {
        total,
        codex_enabled_count,
        opencode_enabled_count,
        skills,
    })
}

fn set_skill_targets_internal(
    skill_id: &str,
    codex: bool,
    opencode: bool,
) -> CmdResult<SkillsCatalogView> {
    let normalized = normalize_skill_id(skill_id);
    if normalized.is_empty() {
        return Err("skillId 不能为空。".to_string());
    }
    let mut map = read_skill_targets_map()?;
    if codex && opencode {
        map.remove(&normalized);
    } else {
        map.insert(normalized, SkillTargets { codex, opencode });
    }
    write_skill_targets_map(&map)?;
    load_skills_catalog_internal()
}

fn parse_auto_switch_mode(mode: Option<&str>) -> AutoSwitchMode {
    match mode.unwrap_or("gpt").trim().to_lowercase().as_str() {
        "opencode" => AutoSwitchMode::OpenCode,
        _ => AutoSwitchMode::Gpt,
    }
}

fn ensure_auto_switch_mode(runtime: &mut AutoSwitchRuntime, mode: AutoSwitchMode) {
    if runtime.monitor_mode == Some(mode) {
        return;
    }
    *runtime = AutoSwitchRuntime::default();
    runtime.monitor_mode = Some(mode);
}

fn switcher_home() -> CmdResult<PathBuf> {
    Ok(home_dir()?.join(SWITCHER_HOME_DIR))
}

fn profiles_dir() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(PROFILES_DIR_NAME))
}

fn backups_dir() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(BACKUPS_DIR_NAME))
}

fn profiles_file() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(PROFILES_FILE_NAME))
}

fn codex_hook_signal_file() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(CODEX_SWITCH_HOOK_SIGNAL_FILE_NAME))
}

fn codex_hook_newchat_signal_file() -> CmdResult<PathBuf> {
    Ok(switcher_home()?.join(CODEX_SWITCH_HOOK_NEWCHAT_SIGNAL_FILE_NAME))
}

fn now_iso() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn dedupe_push_path(paths: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf) {
    let key = path.to_string_lossy().to_lowercase();
    if key.is_empty() || seen.contains(&key) {
        return;
    }
    seen.insert(key);
    paths.push(path);
}

fn candidate_codex_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    if let Some(bin) = env::var_os("CODEX_BIN") {
        dedupe_push_path(&mut paths, &mut seen, PathBuf::from(bin));
    }

    let env_path = env::var_os("PATH").unwrap_or_default();
    for dir in env::split_paths(&env_path) {
        for name in ["codex.exe", "codex.cmd", "codex.bat", "codex.ps1", "codex"] {
            dedupe_push_path(&mut paths, &mut seen, dir.join(name));
        }
    }

    if let Ok(home) = home_dir() {
        let appdata_npm = home.join("AppData").join("Roaming").join("npm");
        for name in ["codex.exe", "codex.cmd", "codex.ps1", "codex.bat", "codex"] {
            dedupe_push_path(&mut paths, &mut seen, appdata_npm.join(name));
        }

        for ext_base in [
            home.join(".vscode").join("extensions"),
            home.join(".cursor").join("extensions"),
            home.join(".windsurf").join("extensions"),
        ] {
            if !ext_base.exists() {
                continue;
            }
            if let Ok(entries) = fs::read_dir(ext_base) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let file_name = entry.file_name().to_string_lossy().to_string();
                    if !file_name.starts_with("openai.chatgpt-") {
                        continue;
                    }
                    dedupe_push_path(
                        &mut paths,
                        &mut seen,
                        path.join("bin").join("windows-x86_64").join("codex.exe"),
                    );
                }
            }
        }
    }

    paths
}

fn resolve_codex_binary() -> CmdResult<PathBuf> {
    let candidates = candidate_codex_paths();
    for candidate in &candidates {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }
    let preview: Vec<String> = candidates
        .iter()
        .take(6)
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    Err(format!(
        "未找到 codex 可执行文件。可尝试设置环境变量 CODEX_BIN 指向 codex.exe。已尝试: {}",
        preview.join(" | ")
    ))
}

fn candidate_chatgpt_extension_js_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let Ok(home) = home_dir() else {
        return paths;
    };
    let ext_roots = [
        home.join(".vscode").join("extensions"),
        home.join(".vscode-insiders").join("extensions"),
        home.join(".cursor").join("extensions"),
        home.join(".windsurf").join("extensions"),
    ];

    for ext_root in ext_roots {
        if !ext_root.exists() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&ext_root) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            if !file_name.starts_with("openai.chatgpt-") {
                continue;
            }
            let js_path = entry.path().join("out").join("extension.js");
            if !js_path.exists() {
                continue;
            }
            dedupe_push_path(&mut paths, &mut seen, js_path);
        }
    }

    paths
}

fn extract_chatgpt_extension_version(dir_name: &str) -> Option<String> {
    let prefix = "openai.chatgpt-";
    if !dir_name.starts_with(prefix) {
        return None;
    }
    let rest = &dir_name[prefix.len()..];
    let mut version = String::new();
    for ch in rest.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            version.push(ch);
            continue;
        }
        if ch == '-' {
            break;
        }
        break;
    }
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn compare_semver_like(a: &str, b: &str) -> CmpOrdering {
    let pa: Vec<u64> = a
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    let pb: Vec<u64> = b
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect();
    let max_len = pa.len().max(pb.len());
    for idx in 0..max_len {
        let av = *pa.get(idx).unwrap_or(&0);
        let bv = *pb.get(idx).unwrap_or(&0);
        match av.cmp(&bv) {
            CmpOrdering::Equal => continue,
            ord => return ord,
        }
    }
    CmpOrdering::Equal
}

fn collect_chatgpt_extension_versions_internal() -> Vec<String> {
    let mut set: HashSet<String> = HashSet::new();
    for path in candidate_chatgpt_extension_js_paths() {
        let Some(ext_dir) = path.parent().and_then(Path::parent) else {
            continue;
        };
        let Some(dir_name) = ext_dir.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if let Some(version) = extract_chatgpt_extension_version(dir_name) {
            set.insert(version);
        }
    }
    let mut versions: Vec<String> = set.into_iter().collect();
    versions.sort_by(|a, b| compare_semver_like(b, a));
    versions
}

fn get_codex_extension_info_internal() -> CodexExtensionInfoView {
    let all_versions = collect_chatgpt_extension_versions_internal();
    let current_version = all_versions.first().cloned();
    CodexExtensionInfoView {
        current_version,
        all_versions,
    }
}

fn hook_has_auth_watch(content: &str) -> bool {
    content.contains(CODEX_SWITCH_HOOK_WATCH_MARKER)
        || content.contains(CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL)
        || content.contains(CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT)
}

fn hook_has_signal_watch(content: &str) -> bool {
    content.contains(CODEX_SWITCH_HOOK_SIGNAL_MARKER)
        || content.contains(CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL)
        || content.contains(CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT)
}

fn hook_has_newchat_watch(content: &str) -> bool {
    content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT)
}

fn hook_has_legacy_newchat_watch(content: &str) -> bool {
    content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V8)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V8)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V7)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V7)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V6)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V6)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V5)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V5)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V4)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V4)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V3)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V3)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_V2)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V2)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_MARKER_LEGACY)
        || content.contains(CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_LEGACY)
}

fn replace_all_legacy_newchat_watch_fragments(content: &str) -> String {
    content
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V8,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V7,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V6,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V5,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V4,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V3,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_V2,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
        .replace(
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_LEGACY,
            CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
        )
}

fn append_newchat_watch_fragment(content: &str) -> Option<String> {
    for fragment in [
        CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT,
        CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT,
    ] {
        if content.contains(fragment) {
            return Some(content.replacen(
                fragment,
                &format!("{fragment},{}", CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT),
                1,
            ));
        }
    }
    None
}

fn build_codex_hook_fragment_v4() -> String {
    format!(
        "{},{},{},{}",
        CODEX_SWITCH_HOOK_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
        CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT
    )
}

fn build_codex_hook_inject_v4() -> String {
    let hook_fragment = build_codex_hook_fragment_v4();
    if let Some(prefix) = CODEX_SWITCH_HOOK_ANCHOR.strip_suffix("))") {
        format!("{prefix},{hook_fragment}))")
    } else {
        CODEX_SWITCH_HOOK_ANCHOR.replacen("))", &format!(",{hook_fragment}))"), 1)
    }
}

fn hook_backup_path_for(extension_js: &Path) -> PathBuf {
    let file_name = extension_js
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("extension.js");
    extension_js.with_file_name(format!("{file_name}{CODEX_SWITCH_HOOK_BACKUP_SUFFIX}"))
}

fn has_codex_hook_installed_internal() -> bool {
    let paths = candidate_chatgpt_extension_js_paths();
    for path in paths {
        if let Ok(content) = fs::read_to_string(&path) {
            if content.contains(CODEX_SWITCH_HOOK_COMMAND_ID)
                && content.contains(CODEX_SWITCH_HOOK_ACCEL_MARKER)
                && hook_has_auth_watch(&content)
                && hook_has_signal_watch(&content)
                && hook_has_newchat_watch(&content)
            {
                return true;
            }
        }
    }
    false
}

fn has_codex_hook_watch_installed_internal() -> bool {
    let paths = candidate_chatgpt_extension_js_paths();
    for path in paths {
        if let Ok(content) = fs::read_to_string(&path) {
            if hook_has_auth_watch(&content) || hook_has_signal_watch(&content) {
                return true;
            }
        }
    }
    false
}

fn has_codex_hook_signal_watch_installed_internal() -> bool {
    let paths = candidate_chatgpt_extension_js_paths();
    for path in paths {
        if let Ok(content) = fs::read_to_string(&path) {
            if hook_has_signal_watch(&content) {
                return true;
            }
        }
    }
    false
}

fn has_codex_hook_newchat_watch_installed_internal() -> bool {
    let paths = candidate_chatgpt_extension_js_paths();
    for path in paths {
        if let Ok(content) = fs::read_to_string(&path) {
            if hook_has_newchat_watch(&content) {
                return true;
            }
        }
    }
    false
}

fn install_codex_hook_internal() -> CmdResult<String> {
    let paths = candidate_chatgpt_extension_js_paths();
    if paths.is_empty() {
        return Err("未找到 openai.chatgpt 扩展文件，请先安装官方 Codex 扩展。".to_string());
    }

    let mut patched: Vec<String> = Vec::new();
    let mut already: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    let hook_fragment_v4 = build_codex_hook_fragment_v4();
    let hook_inject_v4 = build_codex_hook_inject_v4();

    for path in paths {
        let display = path.to_string_lossy().to_string();
        let content = match fs::read_to_string(&path) {
            Ok(v) => v,
            Err(err) => {
                failed.push(format!("{display}: 读取失败 {err}"));
                continue;
            }
        };

        let replaced = if hook_has_legacy_newchat_watch(&content) {
            let mut normalized = replace_all_legacy_newchat_watch_fragments(&content);
            if !hook_has_newchat_watch(&normalized) {
                if let Some(updated) = append_newchat_watch_fragment(&normalized) {
                    normalized = updated;
                } else {
                    failed.push(format!(
                        "{display}: 检测到旧版新对话 Hook，但未命中可升级片段，请先恢复扩展后重试"
                    ));
                    continue;
                }
            }
            normalized
        } else if content.contains(CODEX_SWITCH_HOOK_COMMAND_ID)
            && content.contains(CODEX_SWITCH_HOOK_ACCEL_MARKER)
            && hook_has_auth_watch(&content)
            && hook_has_signal_watch(&content)
            && hook_has_newchat_watch(&content)
        {
            let has_accel_auth_watch =
                content.contains(CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL);
            let has_accel_signal_watch =
                content.contains(CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL);
            let mut refreshed = content
                .replace(
                    CODEX_SWITCH_HOOK_FRAGMENT_ACCEL_V1,
                    CODEX_SWITCH_HOOK_FRAGMENT_ACCEL,
                )
                .replace(
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL_V1,
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
                )
                .replace(
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL_V2,
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
                )
                .replace(
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL_V1,
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
                )
                .replace(
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL_V2,
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
                )
                .replace(
                    "setInterval(()=>{Le()},1200);",
                    "setInterval(()=>{Le()},500);",
                )
                .replace(
                    "setInterval(()=>{Le()},700);",
                    "setInterval(()=>{Le()},300);",
                );
            refreshed = if has_accel_auth_watch {
                refreshed.replace(
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT,
                    CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
                )
            } else {
                refreshed.replace(
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT,
                    CODEX_SWITCH_HOOK_AUTH_WATCH_FRAGMENT_ACCEL,
                )
            };
            refreshed = if has_accel_signal_watch {
                refreshed.replace(
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT,
                    CODEX_SWITCH_HOOK_NEWCHAT_WATCH_FRAGMENT_NOOP,
                )
            } else {
                refreshed.replace(
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT,
                    CODEX_SWITCH_HOOK_SIGNAL_WATCH_FRAGMENT_ACCEL,
                )
            };
            if refreshed == content {
                already.push(display);
                continue;
            }
            refreshed
        } else if content.contains(&hook_fragment_v4) {
            already.push(display);
            continue;
        } else if content.contains(CODEX_SWITCH_HOOK_COMMAND_ID)
            && hook_has_auth_watch(&content)
            && hook_has_signal_watch(&content)
            && !hook_has_newchat_watch(&content)
        {
            if let Some(updated) = append_newchat_watch_fragment(&content) {
                updated
            } else {
                failed.push(format!(
                    "{display}: 检测到旧版 Hook（缺少新对话监听），但未命中可升级片段，请先恢复扩展后重试"
                ));
                continue;
            }
        } else if content.contains(CODEX_SWITCH_HOOK_FRAGMENT_V3) {
            content.replacen(CODEX_SWITCH_HOOK_FRAGMENT_V3, &hook_fragment_v4, 1)
        } else if content.contains(CODEX_SWITCH_HOOK_FRAGMENT_V2) {
            content.replacen(CODEX_SWITCH_HOOK_FRAGMENT_V2, &hook_fragment_v4, 1)
        } else if content.contains(CODEX_SWITCH_HOOK_FRAGMENT_V1) {
            content.replacen(CODEX_SWITCH_HOOK_FRAGMENT_V1, &hook_fragment_v4, 1)
        } else if content.contains(CODEX_SWITCH_HOOK_COMMAND_ID) {
            // A non-standard old patch exists; ask user to reinstall cleanly.
            failed.push(format!(
                "{display}: 检测到旧版/自定义 Hook 片段，无法自动升级，请先恢复扩展后重试"
            ));
            continue;
        } else {
            if !content.contains(CODEX_SWITCH_HOOK_ANCHOR) {
                failed.push(format!("{display}: 未匹配到 Hook 注入锚点"));
                continue;
            }
            content.replacen(CODEX_SWITCH_HOOK_ANCHOR, &hook_inject_v4, 1)
        };

        if replaced == content {
            failed.push(format!("{display}: Hook 注入失败（内容未变化）"));
            continue;
        }

        let backup_path = hook_backup_path_for(&path);
        if !backup_path.exists() {
            if let Err(err) = fs::write(&backup_path, &content) {
                failed.push(format!(
                    "{display}: 创建备份失败 {} -> {err}",
                    backup_path.display()
                ));
                continue;
            }
        }

        if let Err(err) = fs::write(&path, replaced) {
            failed.push(format!("{display}: 写入失败 {err}"));
            continue;
        }
        patched.push(display);
    }

    let mut summary_parts: Vec<String> = Vec::new();
    if !patched.is_empty() {
        summary_parts.push(format!("已安装 Hook {} 处", patched.len()));
    }
    if !already.is_empty() {
        summary_parts.push(format!("已存在 Hook {} 处", already.len()));
    }
    if !failed.is_empty() {
        summary_parts.push(format!("失败 {} 处", failed.len()));
    }
    if summary_parts.is_empty() {
        summary_parts.push("未做任何变更".to_string());
    }

    let mut summary = summary_parts.join("，");
    if !patched.is_empty() {
        summary.push_str(
            "。首次安装后请执行一次“方案2：Hook 提速版”或“方案1：重启 Extension Host”以加载 Hook（含账号变更监听）。",
        );
    }
    if !failed.is_empty() {
        summary.push_str("。失败详情: ");
        summary.push_str(&failed.join(" | "));
    }
    Ok(summary)
}

fn build_codex_command(args: &[&str]) -> CmdResult<Command> {
    let bin = resolve_codex_binary()?;
    #[cfg(target_os = "windows")]
    {
        let ext = bin
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ext == "cmd" || ext == "bat" {
            let mut cmd = command_no_window("cmd");
            cmd.arg("/C").arg(&bin).args(args);
            return Ok(cmd);
        }
        if ext == "ps1" {
            let mut cmd = command_no_window("powershell");
            cmd.args(["-NoLogo", "-NoProfile", "-File"])
                .arg(&bin)
                .args(args);
            return Ok(cmd);
        }
        let mut cmd = command_no_window(&bin);
        cmd.args(args);
        return Ok(cmd);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = command_no_window(&bin);
        cmd.args(args);
        Ok(cmd)
    }
}

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

fn load_store() -> CmdResult<StoreData> {
    ensure_dirs()?;
    let path = profiles_file()?;
    if !path.exists() {
        return Ok(StoreData::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取 profiles.json 失败: {e}"))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut data: StoreData =
        serde_json::from_str(&text).map_err(|e| format!("解析 profiles.json 失败: {e}"))?;
    if data.profiles.is_empty() {
        data.profiles = BTreeMap::new();
    }
    normalize_profile_order(&mut data);
    normalize_profile_support_in_store(&mut data);
    if dedupe_profiles_by_identity(&mut data) {
        save_store(&data)?;
    }
    Ok(data)
}

fn save_store(store: &StoreData) -> CmdResult<()> {
    ensure_dirs()?;
    let path = profiles_file()?;
    let mut normalized = store.clone();
    normalize_profile_order(&mut normalized);
    normalize_profile_support_in_store(&mut normalized);
    let text = serde_json::to_string_pretty(&normalized)
        .map_err(|e| format!("序列化 profiles.json 失败: {e}"))?;
    fs::write(path, format!("{text}\n")).map_err(|e| format!("写入 profiles.json 失败: {e}"))
}

fn list_profile_names(store: &StoreData) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for name in &store.profile_order {
        if store.profiles.contains_key(name) && seen.insert(name.clone()) {
            names.push(name.clone());
        }
    }

    let mut remaining: Vec<String> = store
        .profiles
        .keys()
        .filter(|name| !seen.contains(*name))
        .cloned()
        .collect();
    remaining.sort_by_key(|s| s.to_lowercase());
    names.extend(remaining);
    names
}

fn normalize_profile_order(store: &mut StoreData) {
    let mut normalized: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for name in &store.profile_order {
        if store.profiles.contains_key(name) && seen.insert(name.clone()) {
            normalized.push(name.clone());
        }
    }

    let mut missing: Vec<String> = store
        .profiles
        .keys()
        .filter(|name| !seen.contains(*name))
        .cloned()
        .collect();
    missing.sort_by_key(|s| s.to_lowercase());
    normalized.extend(missing);

    store.profile_order = normalized;
}

fn default_profile_support() -> ProfileSupportView {
    ProfileSupportView {
        gpt: true,
        opencode: false,
    }
}

fn profile_support_from_value(raw: Option<&Value>) -> ProfileSupportView {
    let mut support = default_profile_support();
    match raw {
        Some(Value::Object(map)) => {
            if let Some(v) = map.get(PROFILE_SUPPORT_GPT_KEY).and_then(Value::as_bool) {
                support.gpt = v;
            }
            if let Some(v) = map
                .get(PROFILE_SUPPORT_OPENCODE_KEY)
                .and_then(Value::as_bool)
            {
                support.opencode = v;
            }
        }
        Some(Value::String(v)) => {
            let token = v.trim().to_ascii_lowercase();
            match token.as_str() {
                "gpt" | "codex" | "chatgpt" => {
                    support.gpt = true;
                    support.opencode = false;
                }
                "opencode" => {
                    support.gpt = false;
                    support.opencode = true;
                }
                "both" | "all" | "gpt+opencode" | "gpt/opencode" => {
                    support.gpt = true;
                    support.opencode = true;
                }
                _ => {}
            }
        }
        Some(Value::Array(values)) => {
            let mut has_gpt = false;
            let mut has_opencode = false;
            for item in values {
                let Some(text) = item.as_str() else {
                    continue;
                };
                let token = text.trim().to_ascii_lowercase();
                if token.is_empty() {
                    continue;
                }
                if matches!(token.as_str(), "gpt" | "codex" | "chatgpt") {
                    has_gpt = true;
                }
                if token == "opencode" {
                    has_opencode = true;
                }
            }
            if has_gpt || has_opencode {
                support.gpt = has_gpt;
                support.opencode = has_opencode;
            }
        }
        _ => {}
    }
    support
}

fn profile_support_json(support: ProfileSupportView) -> Value {
    json!({
        PROFILE_SUPPORT_GPT_KEY: support.gpt,
        PROFILE_SUPPORT_OPENCODE_KEY: support.opencode
    })
}

fn normalize_profile_support_in_record(record: &mut Map<String, Value>) {
    let support = profile_support_from_value(record.get("support"));
    record.insert("support".to_string(), profile_support_json(support));
}

fn normalize_profile_support_in_store(store: &mut StoreData) {
    for record_value in store.profiles.values_mut() {
        let Some(record) = record_value.as_object_mut() else {
            continue;
        };
        normalize_profile_support_in_record(record);
    }
}

fn profile_snapshot_dir(profile_name: &str) -> CmdResult<PathBuf> {
    Ok(profiles_dir()?.join(profile_name))
}

fn sanitize_profile_name(raw: &str) -> String {
    let invalid = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let mut cleaned = String::new();
    for ch in raw.chars() {
        if invalid.contains(&ch) {
            cleaned.push('_');
        } else {
            cleaned.push(ch);
        }
    }
    let trimmed = cleaned.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        "current-account".to_string()
    } else {
        trimmed
    }
}

fn next_auto_profile_name(store: &StoreData, base_name: Option<&str>) -> String {
    let base = sanitize_profile_name(base_name.unwrap_or("current-account"));
    let names: HashSet<String> = list_profile_names(store).into_iter().collect();
    if !names.contains(&base) {
        return base;
    }
    let mut index = 2;
    loop {
        let candidate = format!("{base}-{index}");
        if !names.contains(&candidate) {
            return candidate;
        }
        index += 1;
    }
}

fn normalize_identity_value(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn read_email_from_record(record: &Map<String, Value>) -> Option<String> {
    normalize_identity_value(record.get("email").and_then(Value::as_str))
}

fn read_workspace_id_from_record_or_auth(
    name: &str,
    record: &Map<String, Value>,
) -> Option<String> {
    if let Some(wid) = record.get("workspace_id").and_then(Value::as_str) {
        let value = wid.trim().to_string();
        if !value.is_empty() {
            return Some(value);
        }
    }
    let snapshot_dir = record_snapshot_dir(name, record).ok()?;
    let (_, wid) = read_workspace_info_from_auth_file(&snapshot_dir.join(AUTH_FILE_NAME));
    wid
}

fn find_profile_candidates_by_identity(
    store: &StoreData,
    workspace_id: Option<&str>,
    email: Option<&str>,
) -> Vec<String> {
    let target_workspace = normalize_identity_value(workspace_id);
    let target_email = normalize_identity_value(email);
    if target_workspace.is_none() && target_email.is_none() {
        return Vec::new();
    }

    let mut exact_matches: Vec<String> = Vec::new();
    let mut workspace_only_with_missing_email_matches: Vec<String> = Vec::new();
    let mut workspace_matches: Vec<String> = Vec::new();
    let mut email_matches: Vec<String> = Vec::new();

    for name in list_profile_names(store) {
        let record = match store.profiles.get(&name).and_then(Value::as_object) {
            Some(v) => v,
            None => continue,
        };

        let rec_workspace = normalize_identity_value(
            read_workspace_id_from_record_or_auth(&name, record).as_deref(),
        );
        let rec_email = read_email_from_record(record);

        if let (Some(target_w), Some(target_e)) =
            (target_workspace.as_deref(), target_email.as_deref())
        {
            if rec_workspace.as_deref() == Some(target_w) && rec_email.as_deref() == Some(target_e)
            {
                exact_matches.push(name);
                continue;
            }
            // Backward compatibility: allow matching legacy records without stored email,
            // but never overwrite another email under the same workspace.
            if rec_workspace.as_deref() == Some(target_w) && rec_email.is_none() {
                workspace_only_with_missing_email_matches.push(name);
            }
            continue;
        }

        if let Some(target_w) = target_workspace.as_deref() {
            if rec_workspace.as_deref() == Some(target_w) {
                workspace_matches.push(name);
            }
            continue;
        }

        if let Some(target_e) = target_email.as_deref() {
            if rec_email.as_deref() == Some(target_e) {
                email_matches.push(name);
            }
        }
    }

    if target_workspace.is_some() && target_email.is_some() {
        if !exact_matches.is_empty() {
            return exact_matches;
        }
        if !workspace_only_with_missing_email_matches.is_empty() {
            return workspace_only_with_missing_email_matches;
        }
        return Vec::new();
    }

    if target_workspace.is_some() {
        return workspace_matches;
    }

    email_matches
}

fn find_profile_name_by_identity(
    store: &StoreData,
    workspace_id: Option<&str>,
    email: Option<&str>,
) -> Option<String> {
    let matches = find_profile_candidates_by_identity(store, workspace_id, email);
    if matches.len() == 1 {
        return matches.into_iter().next();
    }
    None
}

fn find_profile_name_by_identity_prefer_existing(
    store: &StoreData,
    workspace_id: Option<&str>,
    email: Option<&str>,
) -> Option<String> {
    let candidates = find_profile_candidates_by_identity(store, workspace_id, email);
    if candidates.is_empty() {
        return None;
    }
    if candidates.len() == 1 {
        return candidates.into_iter().next();
    }

    if let Some(active) = store.active_profile.as_deref() {
        if candidates.iter().any(|name| name == active) {
            return Some(active.to_string());
        }
    }

    let has_alias = |name: &str| -> bool {
        store
            .profiles
            .get(name)
            .and_then(Value::as_object)
            .and_then(|record| record.get("workspace_alias").and_then(Value::as_str))
            .map(str::trim)
            .map(|text| !text.is_empty())
            .unwrap_or(false)
    };
    let sort_stamp = |name: &str| -> String {
        store
            .profiles
            .get(name)
            .and_then(Value::as_object)
            .and_then(|record| {
                record
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .or_else(|| record.get("last_checked_at").and_then(Value::as_str))
            })
            .map(str::trim)
            .unwrap_or("")
            .to_string()
    };

    let mut best = candidates[0].clone();
    for name in candidates.iter().skip(1) {
        let best_alias = has_alias(&best);
        let name_alias = has_alias(name);
        if name_alias && !best_alias {
            best = name.clone();
            continue;
        }
        if best_alias == name_alias && sort_stamp(name) > sort_stamp(&best) {
            best = name.clone();
        }
    }
    Some(best)
}

fn profile_identity_key(name: &str, record: &Map<String, Value>) -> Option<String> {
    let workspace =
        normalize_identity_value(read_workspace_id_from_record_or_auth(name, record).as_deref())?;
    let email = read_email_from_record(record)?;
    Some(format!("{workspace}|{email}"))
}

fn dedupe_profiles_by_identity(store: &mut StoreData) -> bool {
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for name in list_profile_names(store) {
        let Some(record) = store.profiles.get(&name).and_then(Value::as_object) else {
            continue;
        };
        let Some(key) = profile_identity_key(&name, record) else {
            continue;
        };
        groups.entry(key).or_default().push(name);
    }

    let mut changed = false;
    for names in groups.values() {
        if names.len() <= 1 {
            continue;
        }

        let Some(record) = store.profiles.get(&names[0]).and_then(Value::as_object) else {
            continue;
        };
        let workspace_id = read_workspace_id_from_record_or_auth(&names[0], record);
        let email = read_email_from_record(record);
        let keep = find_profile_name_by_identity_prefer_existing(
            store,
            workspace_id.as_deref(),
            email.as_deref(),
        )
        .unwrap_or_else(|| names[0].clone());

        for name in names {
            if name == &keep {
                continue;
            }
            let removed = store.profiles.remove(name);
            if let Some(record_value) = removed {
                if let Some(record_obj) = record_value.as_object() {
                    if let Ok(snapshot_dir) = record_snapshot_dir(name, record_obj) {
                        safe_remove_dir(&snapshot_dir);
                    }
                }
                store.profile_order.retain(|item| item != name);
                if store.active_profile.as_deref() == Some(name.as_str()) {
                    store.active_profile = Some(keep.clone());
                }
                changed = true;
            }
        }
    }

    if changed {
        normalize_profile_order(store);
    }
    changed
}

fn find_workspace_alias_by_identity(
    store: &StoreData,
    workspace_id: Option<&str>,
    email: Option<&str>,
) -> Option<String> {
    let name = find_profile_name_by_identity(store, workspace_id, email)?;
    let record = store.profiles.get(&name).and_then(Value::as_object)?;
    let alias = record
        .get("workspace_alias")
        .and_then(Value::as_str)?
        .trim()
        .to_string();
    if alias.is_empty() {
        None
    } else {
        Some(alias)
    }
}

fn format_workspace_display(
    workspace_name: Option<&str>,
    _workspace_id: Option<&str>,
    workspace_alias: Option<&str>,
) -> String {
    let alias = workspace_alias.map(str::trim).filter(|s| !s.is_empty());
    let name = workspace_name.map(str::trim).filter(|s| !s.is_empty());
    alias.or(name).unwrap_or("未命名空间").to_string()
}

fn decode_jwt_payload(token: &str) -> Option<Value> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let payload = parts[1];
    let decoded = URL_SAFE_NO_PAD.decode(payload).ok().or_else(|| {
        let mut padded = payload.to_string();
        while padded.len() % 4 != 0 {
            padded.push('=');
        }
        URL_SAFE.decode(padded).ok()
    })?;
    serde_json::from_slice::<Value>(&decoded).ok()
}

fn read_non_empty_string(map: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = map.get(*key).and_then(Value::as_str) {
            let v = value.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn workspace_id_from_org(org_map: &Map<String, Value>) -> Option<String> {
    read_non_empty_string(
        org_map,
        &[
            "id",
            "org_id",
            "organization_id",
            "account_id",
            "chatgpt_account_id",
            "workspace_id",
            "workspaceId",
        ],
    )
}

fn pick_workspace_name_from_auth_claim(
    auth_claim: &Map<String, Value>,
    preferred_workspace_id: Option<&str>,
    allow_fallback: bool,
) -> Option<String> {
    if let Some(orgs) = auth_claim.get("organizations").and_then(Value::as_array) {
        if let Some(target) = preferred_workspace_id.map(|v| v.trim().to_lowercase()) {
            for org in orgs {
                let Some(org_map) = org.as_object() else {
                    continue;
                };
                let Some(org_id) = workspace_id_from_org(org_map) else {
                    continue;
                };
                if org_id.trim().to_lowercase() != target {
                    continue;
                }
                if let Some(title) = org_map.get("title").and_then(Value::as_str) {
                    let t = title.trim().to_string();
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
        }

        if allow_fallback {
            for org in orgs {
                let Some(org_map) = org.as_object() else {
                    continue;
                };
                let is_default = org_map
                    .get("is_default")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !is_default {
                    continue;
                }
                if let Some(title) = org_map.get("title").and_then(Value::as_str) {
                    let t = title.trim().to_string();
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
            for org in orgs {
                let Some(org_map) = org.as_object() else {
                    continue;
                };
                if let Some(title) = org_map.get("title").and_then(Value::as_str) {
                    let t = title.trim().to_string();
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
        }
    }

    if allow_fallback {
        return read_non_empty_string(
            auth_claim,
            &[
                "workspace_name",
                "chatgpt_workspace_name",
                "organization_name",
                "org_name",
            ],
        );
    }
    None
}

fn pick_workspace_id_from_auth_claim(auth_claim: &Map<String, Value>) -> Option<String> {
    for key in [
        "chatgpt_account_id",
        "chatgptAccountId",
        "workspace_id",
        "workspaceId",
    ] {
        if let Some(value) = auth_claim.get(key).and_then(Value::as_str) {
            let v = value.trim().to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

fn read_workspace_info_from_auth_file(auth_file: &Path) -> (Option<String>, Option<String>) {
    if !auth_file.exists() {
        return (None, None);
    }
    let payload: Value = match fs::read_to_string(auth_file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        Some(v) => v,
        None => return (None, None),
    };
    let Some(tokens) = payload.get("tokens").and_then(Value::as_object) else {
        return (None, None);
    };

    let mut workspace_name_exact: Option<String> = None;
    let mut workspace_name_fallback: Option<String> = None;
    let mut workspace_id = tokens
        .get("account_id")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    for key in ["id_token", "access_token"] {
        let Some(token) = tokens.get(key).and_then(Value::as_str) else {
            continue;
        };
        let Some(decoded) = decode_jwt_payload(token) else {
            continue;
        };
        let Some(auth_claim) = decoded
            .get("https://api.openai.com/auth")
            .and_then(Value::as_object)
        else {
            continue;
        };
        if workspace_id.is_none() {
            workspace_id = pick_workspace_id_from_auth_claim(auth_claim);
        }
        if workspace_name_fallback.is_none() {
            workspace_name_fallback = pick_workspace_name_from_auth_claim(auth_claim, None, true);
        }
        if workspace_name_exact.is_none() {
            workspace_name_exact =
                pick_workspace_name_from_auth_claim(auth_claim, workspace_id.as_deref(), false);
        }
        if workspace_name_exact.is_some() && workspace_id.is_some() {
            break;
        }
    }
    if workspace_id.as_deref().unwrap_or("").trim().is_empty() {
        (
            workspace_name_exact.or(workspace_name_fallback),
            workspace_id,
        )
    } else {
        // When workspace id is known, avoid falling back to an unrelated org title.
        (workspace_name_exact, workspace_id)
    }
}

fn read_auth_token_health(auth_file: &Path) -> TokenHealth {
    if !auth_file.exists() {
        return TokenHealth {
            exists: false,
            has_refresh: false,
            access_exp: None,
        };
    }
    let payload: Value = match fs::read_to_string(auth_file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    {
        Some(v) => v,
        None => {
            return TokenHealth {
                exists: false,
                has_refresh: false,
                access_exp: None,
            }
        }
    };
    let Some(tokens) = payload.get("tokens").and_then(Value::as_object) else {
        return TokenHealth {
            exists: true,
            has_refresh: false,
            access_exp: None,
        };
    };

    let has_refresh = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    let access_exp = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .and_then(decode_jwt_payload)
        .and_then(|v| v.get("exp").and_then(Value::as_i64));

    TokenHealth {
        exists: true,
        has_refresh,
        access_exp,
    }
}

fn is_auth_error(error_text: Option<&str>) -> bool {
    let lowered = error_text.unwrap_or("").to_lowercase();
    if lowered.is_empty() {
        return false;
    }
    AUTH_ERROR_KEYWORDS.iter().any(|kw| lowered.contains(kw))
}

fn profile_validity(record: &Map<String, Value>, snapshot_dir: &Path) -> String {
    let token_health = read_auth_token_health(&snapshot_dir.join(AUTH_FILE_NAME));
    if !token_health.exists {
        return "已失效".to_string();
    }

    let last_error = record.get("last_error").and_then(Value::as_str);
    if is_auth_error(last_error) {
        return "已失效".to_string();
    }

    let now_ts = Local::now().timestamp();
    if let Some(exp) = token_health.access_exp {
        if exp <= now_ts && !token_health.has_refresh {
            return "已失效".to_string();
        }
    }
    let plan_type = record
        .get("plan_type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if plan_type == "free" && !record_has_window_duration(record, 300, 30) {
        return "受限(仅周额度)".to_string();
    }
    "正常".to_string()
}

fn record_snapshot_dir(name: &str, record: &Map<String, Value>) -> CmdResult<PathBuf> {
    if let Some(path_text) = record.get("snapshot_dir").and_then(Value::as_str) {
        let path = PathBuf::from(path_text);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }
    profile_snapshot_dir(name)
}

fn window_quota_from_payload(payload: Option<&Value>) -> Option<WindowQuota> {
    let map = payload?.as_object()?;
    let used = map.get("usedPercent").and_then(Value::as_i64)?;
    let win = map.get("windowDurationMins").and_then(Value::as_i64);
    let resets_at = map.get("resetsAt").and_then(Value::as_i64);
    let remaining = (100 - used).clamp(0, 100);
    Some(WindowQuota {
        window_minutes: win,
        used_percent: Some(used),
        remaining_percent: Some(remaining),
        resets_at,
    })
}

fn pick_window(
    windows: &[WindowQuota],
    target_minutes: i64,
    tolerance_minutes: i64,
) -> Option<WindowQuota> {
    if windows.is_empty() {
        return None;
    }
    if let Some(exact) = windows
        .iter()
        .find(|w| w.window_minutes == Some(target_minutes))
        .cloned()
    {
        return Some(exact);
    }
    windows
        .iter()
        .filter_map(|w| {
            let mins = w.window_minutes?;
            let diff = (mins - target_minutes).abs();
            if diff <= tolerance_minutes {
                Some((w.clone(), diff))
            } else {
                None
            }
        })
        .min_by_key(|(_, diff)| *diff)
        .map(|(w, _)| w)
}

fn record_has_window_duration(
    record: &Map<String, Value>,
    target_minutes: i64,
    tolerance_minutes: i64,
) -> bool {
    let quota = record.get("quota").and_then(Value::as_object);
    let five = quota
        .and_then(|q| q.get("five_hour").or_else(|| q.get("fiveHour")))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let week = quota
        .and_then(|q| q.get("one_week").or_else(|| q.get("oneWeek")))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mins_from = |obj: &Map<String, Value>| -> Option<i64> {
        obj.get("window_minutes")
            .or_else(|| obj.get("windowMinutes"))
            .and_then(Value::as_i64)
    };
    [mins_from(&five), mins_from(&week)]
        .into_iter()
        .flatten()
        .any(|mins| (mins - target_minutes).abs() <= tolerance_minutes)
}

fn app_server_request(
    codex_home: &Path,
    requests: &[Value],
    timeout_seconds: u64,
) -> CmdResult<HashMap<i64, Value>> {
    let mut cmd = build_codex_command(&["app-server"])?;
    let mut child = cmd
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 codex app-server 失败: {e}"))?;

    {
        let stdin = child
            .stdin
            .as_mut()
            .ok_or_else(|| "app-server stdin 不可用。".to_string())?;
        for req in requests {
            let line = serde_json::to_string(req).map_err(|e| format!("请求序列化失败: {e}"))?;
            stdin
                .write_all(format!("{line}\n").as_bytes())
                .map_err(|e| format!("向 app-server 写入请求失败: {e}"))?;
        }
        stdin
            .flush()
            .map_err(|e| format!("刷新 app-server stdin 失败: {e}"))?;
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "app-server stdout 不可用。".to_string())?;
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });

    let wanted_ids: HashSet<i64> = requests
        .iter()
        .filter_map(|req| req.get("id").and_then(Value::as_i64))
        .collect();
    let mut got: HashMap<i64, Value> = HashMap::new();
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);

    while Instant::now() < deadline && got.len() < wanted_ids.len() {
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(line) => {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(msg_id) = msg.get("id").and_then(Value::as_i64) else {
                    continue;
                };
                if !wanted_ids.contains(&msg_id) {
                    continue;
                }
                if let Some(error) = msg.get("error") {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("app-server 请求 {msg_id} 返回错误: {error}"));
                }
                got.insert(msg_id, msg);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = child.kill();
    let _ = child.wait();

    if got.len() != wanted_ids.len() {
        let mut missing: Vec<i64> = wanted_ids
            .into_iter()
            .filter(|id| !got.contains_key(id))
            .collect();
        missing.sort_unstable();
        return Err(format!("app-server 响应超时，缺少 id: {missing:?}"));
    }
    Ok(got)
}

fn fetch_quota_from_codex_home(codex_home: &Path, refresh_token: bool) -> CmdResult<AccountQuota> {
    let requests = vec![
        json!({
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "codex-switch", "version": "1.0.0"}}
        }),
        json!({
            "id": 2,
            "method": "account/read",
            "params": {"refreshToken": refresh_token}
        }),
        json!({
            "id": 3,
            "method": "account/rateLimits/read",
            "params": Value::Null
        }),
    ];

    let responses = app_server_request(codex_home, &requests, 14)?;
    let account = responses
        .get(&2)
        .and_then(|v| v.get("result"))
        .and_then(|v| v.get("account"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let email = account
        .get("email")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let plan_type = account
        .get("planType")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let (workspace_name, workspace_id) =
        read_workspace_info_from_auth_file(&codex_home.join(AUTH_FILE_NAME));

    let result = responses
        .get(&3)
        .and_then(|v| v.get("result"))
        .cloned()
        .unwrap_or(Value::Null);

    let mut snapshot: Option<Value> = None;
    if let Some(by_limit) = result.get("rateLimitsByLimitId").and_then(Value::as_object) {
        if let Some(codex_limits) = by_limit.get("codex").and_then(Value::as_object) {
            snapshot = Some(Value::Object(codex_limits.clone()));
        } else if let Some((_, first)) = by_limit.iter().next() {
            if first.is_object() {
                snapshot = Some(first.clone());
            }
        }
    }
    if snapshot.is_none() {
        if let Some(rate_limits) = result.get("rateLimits").and_then(Value::as_object) {
            snapshot = Some(Value::Object(rate_limits.clone()));
        }
    }
    let snapshot = snapshot.ok_or_else(|| "未在 app-server 响应中找到额度信息。".to_string())?;
    let snapshot_map = snapshot
        .as_object()
        .ok_or_else(|| "额度快照格式不正确。".to_string())?;

    let primary = window_quota_from_payload(snapshot_map.get("primary"));
    let secondary = window_quota_from_payload(snapshot_map.get("secondary"));
    let windows: Vec<WindowQuota> = [primary, secondary].into_iter().flatten().collect();
    if windows.is_empty() {
        return Err("额度窗口为空。".to_string());
    }

    let five_hour = pick_window(&windows, 300, 30);
    let one_week = pick_window(&windows, 10080, 12 * 60);
    if five_hour.is_none() && one_week.is_none() {
        return Err("未识别到可用额度窗口。".to_string());
    }
    Ok(AccountQuota {
        email,
        workspace_name,
        workspace_id,
        plan_type,
        five_hour,
        one_week,
    })
}

fn extract_opencode_account_id_from_jwt(token: &str) -> Option<String> {
    let decoded = decode_jwt_payload(token)?;
    let root = decoded.as_object()?;
    if let Some(id) = read_non_empty_string(
        root,
        &[
            "chatgpt_account_id",
            "chatgptAccountId",
            "account_id",
            "accountId",
        ],
    ) {
        return Some(id);
    }
    let auth_claim = root
        .get("https://api.openai.com/auth")
        .and_then(Value::as_object)?;
    if let Some(id) = read_non_empty_string(
        auth_claim,
        &[
            "chatgpt_account_id",
            "chatgptAccountId",
            "account_id",
            "accountId",
            "workspace_id",
            "workspaceId",
        ],
    ) {
        return Some(id);
    }
    if let Some(orgs) = auth_claim.get("organizations").and_then(Value::as_array) {
        for org in orgs {
            let Some(org_map) = org.as_object() else {
                continue;
            };
            if let Some(id) = workspace_id_from_org(org_map) {
                return Some(id);
            }
        }
    }
    None
}

fn extract_opencode_account_id(tokens: &OAuthTokenExchangeResponse) -> Option<String> {
    extract_opencode_account_id_from_jwt(&tokens.id_token)
        .or_else(|| extract_opencode_account_id_from_jwt(&tokens.access_token))
}

fn resolve_opencode_expires_ms(tokens: &OAuthTokenExchangeResponse) -> i64 {
    if let Some(exp) =
        decode_jwt_payload(&tokens.access_token).and_then(|v| v.get("exp").and_then(Value::as_i64))
    {
        return exp.saturating_mul(1000);
    }
    let now_ms = Utc::now().timestamp_millis();
    if let Some(expires_in) = tokens.expires_in {
        let delta_ms = (expires_in.min(i64::MAX as u64) as i64).saturating_mul(1000);
        return now_ms.saturating_add(delta_ms);
    }
    now_ms.saturating_add(3600 * 1000)
}

fn build_opencode_openai_entry(tokens: &OAuthTokenExchangeResponse) -> Value {
    let mut entry = json!({
        "type": "oauth",
        "refresh": tokens.refresh_token,
        "access": tokens.access_token,
        "expires": resolve_opencode_expires_ms(tokens),
    });
    if let Some(account_id) = extract_opencode_account_id(tokens) {
        if let Some(map) = entry.as_object_mut() {
            map.insert("accountId".to_string(), Value::String(account_id));
        }
    }
    entry
}

fn write_opencode_openai_snapshot(
    target_dir: &Path,
    tokens: &OAuthTokenExchangeResponse,
) -> CmdResult<()> {
    fs::create_dir_all(target_dir).map_err(|e| format!("创建 OpenCode 快照目录失败: {e}"))?;
    let entry = build_opencode_openai_entry(tokens);
    let text = serde_json::to_string_pretty(&entry)
        .map_err(|e| format!("序列化 OpenCode 快照失败: {e}"))?;
    fs::write(
        target_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME),
        format!("{text}\n"),
    )
    .map_err(|e| format!("写入 OpenCode 快照失败: {e}"))
}

fn parse_codex_tokens_from_auth_file(auth_file: &Path) -> CmdResult<OAuthTokenExchangeResponse> {
    let raw = fs::read_to_string(auth_file)
        .map_err(|e| format!("读取登录态文件失败 {}: {e}", auth_file.display()))?;
    let payload: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("解析登录态文件失败 {}: {e}", auth_file.display()))?;
    let tokens = payload
        .get("tokens")
        .and_then(Value::as_object)
        .ok_or_else(|| "登录态文件缺少 tokens。".to_string())?;
    let id_token = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let access_token = tokens
        .get("access_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let refresh_token = tokens
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if id_token.is_empty() || access_token.is_empty() || refresh_token.is_empty() {
        return Err("登录态文件 tokens 字段不完整。".to_string());
    }
    Ok(OAuthTokenExchangeResponse {
        id_token,
        access_token,
        refresh_token,
        expires_in: None,
    })
}

fn ensure_opencode_snapshot_from_codex_auth(target_dir: &Path) -> CmdResult<()> {
    let tokens = parse_codex_tokens_from_auth_file(&target_dir.join(AUTH_FILE_NAME))?;
    write_opencode_openai_snapshot(target_dir, &tokens)
}

fn read_openai_entry_from_opencode_auth_file(auth_path: &Path) -> Option<Value> {
    let text = fs::read_to_string(auth_path).ok()?;
    let payload = serde_json::from_str::<Value>(&text).ok()?;
    let obj = payload.as_object()?;
    let entry = obj.get(OPENCODE_PROVIDER_ID)?.clone();
    if entry.is_object() {
        Some(entry)
    } else {
        None
    }
}

fn opencode_workspace_id_from_openai_entry(entry: &Value) -> Option<String> {
    let obj = entry.as_object()?;
    for key in ["accountId", "account_id", "workspace_id", "workspaceId"] {
        if let Some(value) = obj.get(key).and_then(Value::as_str) {
            let text = value.trim().to_string();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn live_opencode_workspace_id_internal() -> Option<String> {
    let auth_path = opencode_auth_file().ok()?;
    let entry = read_openai_entry_from_opencode_auth_file(&auth_path)?;
    opencode_workspace_id_from_openai_entry(&entry)
}

fn sync_opencode_snapshot_from_live_auth_best_effort(target_dir: &Path) {
    let snapshot_path = target_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME);
    let auth_path = match opencode_auth_file() {
        Ok(v) => v,
        Err(_) => return,
    };
    let Some(entry) = read_openai_entry_from_opencode_auth_file(&auth_path) else {
        if snapshot_path.exists() {
            let _ = fs::remove_file(snapshot_path);
        }
        return;
    };
    if let Ok(text) = serde_json::to_string_pretty(&entry) {
        let _ = fs::write(snapshot_path, format!("{text}\n"));
    }
}

fn apply_opencode_snapshot_to_live_auth(source_dir: &Path, backup_dir: &Path) -> CmdResult<()> {
    let snapshot_path = source_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME);
    if !snapshot_path.exists() {
        let _ = ensure_opencode_snapshot_from_codex_auth(source_dir);
    }
    if !snapshot_path.exists() {
        return Ok(());
    }
    let snapshot_text = fs::read_to_string(&snapshot_path)
        .map_err(|e| format!("读取 OpenCode 快照失败 {}: {e}", snapshot_path.display()))?;
    let snapshot_value = serde_json::from_str::<Value>(&snapshot_text)
        .map_err(|e| format!("解析 OpenCode 快照失败 {}: {e}", snapshot_path.display()))?;
    if !snapshot_value.is_object() {
        return Err("OpenCode 快照格式错误：必须为对象。".to_string());
    }

    let auth_path = opencode_auth_file()?;
    if let Some(parent) = auth_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建 OpenCode 数据目录失败: {e}"))?;
    }
    if auth_path.exists() {
        let _ = fs::copy(&auth_path, backup_dir.join(OPENCODE_AUTH_BACKUP_FILE_NAME));
    }

    let mut root = fs::read_to_string(&auth_path)
        .ok()
        .and_then(|v| serde_json::from_str::<Value>(&v).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    root.insert(OPENCODE_PROVIDER_ID.to_string(), snapshot_value);

    let text = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("序列化 OpenCode auth.json 失败: {e}"))?;
    fs::write(&auth_path, format!("{text}\n"))
        .map_err(|e| format!("写入 OpenCode auth.json 失败 {}: {e}", auth_path.display()))
}

fn copy_current_account_snapshot(target_dir: &Path) -> CmdResult<()> {
    let codex_home = codex_home()?;
    let auth_src = codex_home.join(AUTH_FILE_NAME);
    if !auth_src.exists() {
        return Err(format!("未找到 {}，请先登录 Codex。", auth_src.display()));
    }

    fs::create_dir_all(target_dir).map_err(|e| format!("创建目标目录失败: {e}"))?;
    fs::copy(&auth_src, target_dir.join(AUTH_FILE_NAME))
        .map_err(|e| format!("复制 auth.json 失败: {e}"))?;

    let cap_sid_src = codex_home.join(CAP_SID_FILE_NAME);
    if cap_sid_src.exists() {
        fs::copy(&cap_sid_src, target_dir.join(CAP_SID_FILE_NAME))
            .map_err(|e| format!("复制 cap_sid 失败: {e}"))?;
    }

    let config_src = codex_home.join(CONFIG_FILE_NAME);
    if config_src.exists() {
        fs::copy(&config_src, target_dir.join(CONFIG_FILE_NAME))
            .map_err(|e| format!("复制 config.toml 失败: {e}"))?;
    }
    sync_opencode_snapshot_from_live_auth_best_effort(target_dir);
    Ok(())
}

fn build_profile_record(
    profile_name: &str,
    snapshot_dir: &Path,
    quota: &AccountQuota,
    existing_record: Option<&Map<String, Value>>,
) -> Value {
    let workspace_alias = existing_record
        .and_then(|r| r.get("workspace_alias"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let support = existing_record
        .map(|r| profile_support_from_value(r.get("support")))
        .unwrap_or_else(default_profile_support);

    json!({
        "name": profile_name,
        "snapshot_dir": snapshot_dir.to_string_lossy().to_string(),
        "email": quota.email,
        "workspace_name": quota.workspace_name,
        "workspace_id": quota.workspace_id,
        "workspace_alias": workspace_alias,
        "support": profile_support_json(support),
        "plan_type": quota.plan_type,
        "quota": {
            "five_hour": quota.five_hour,
            "one_week": quota.one_week
        },
        "last_checked_at": now_iso(),
        "last_error": Value::Null,
        "updated_at": now_iso()
    })
}

fn apply_profile_snapshot(source_dir: &Path) -> CmdResult<String> {
    let auth_src = source_dir.join(AUTH_FILE_NAME);
    if !auth_src.exists() {
        return Err(format!(
            "账号快照缺少 {}: {}",
            AUTH_FILE_NAME,
            source_dir.display()
        ));
    }

    let codex_home = codex_home()?;
    fs::create_dir_all(&codex_home).map_err(|e| format!("创建 CODEX_HOME 失败: {e}"))?;

    let backup_dir =
        backups_dir()?.join(format!("backup_{}", Local::now().format("%Y%m%d_%H%M%S")));
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let auth_dst = codex_home.join(AUTH_FILE_NAME);
    if auth_dst.exists() {
        let _ = fs::copy(&auth_dst, backup_dir.join(AUTH_FILE_NAME));
    }
    fs::copy(&auth_src, &auth_dst).map_err(|e| format!("应用 auth.json 失败: {e}"))?;

    let cap_sid_src = source_dir.join(CAP_SID_FILE_NAME);
    let cap_sid_dst = codex_home.join(CAP_SID_FILE_NAME);
    if cap_sid_dst.exists() {
        let _ = fs::copy(&cap_sid_dst, backup_dir.join(CAP_SID_FILE_NAME));
    }
    if cap_sid_src.exists() {
        fs::copy(&cap_sid_src, &cap_sid_dst).map_err(|e| format!("应用 cap_sid 失败: {e}"))?;
    }

    apply_opencode_snapshot_to_live_auth(source_dir, &backup_dir)?;

    Ok(backup_dir
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("backup")
        .to_string())
}

fn apply_profile_snapshot_codex_only(source_dir: &Path) -> CmdResult<String> {
    let auth_src = source_dir.join(AUTH_FILE_NAME);
    if !auth_src.exists() {
        return Err(format!(
            "账号快照缺少 {}: {}",
            AUTH_FILE_NAME,
            source_dir.display()
        ));
    }

    let codex_home = codex_home()?;
    fs::create_dir_all(&codex_home).map_err(|e| format!("创建 CODEX_HOME 失败: {e}"))?;

    let backup_dir =
        backups_dir()?.join(format!("backup_{}", Local::now().format("%Y%m%d_%H%M%S")));
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;

    let auth_dst = codex_home.join(AUTH_FILE_NAME);
    if auth_dst.exists() {
        let _ = fs::copy(&auth_dst, backup_dir.join(AUTH_FILE_NAME));
    }
    fs::copy(&auth_src, &auth_dst).map_err(|e| format!("应用 auth.json 失败: {e}"))?;

    let cap_sid_src = source_dir.join(CAP_SID_FILE_NAME);
    let cap_sid_dst = codex_home.join(CAP_SID_FILE_NAME);
    if cap_sid_dst.exists() {
        let _ = fs::copy(&cap_sid_dst, backup_dir.join(CAP_SID_FILE_NAME));
    }
    if cap_sid_src.exists() {
        fs::copy(&cap_sid_src, &cap_sid_dst).map_err(|e| format!("应用 cap_sid 失败: {e}"))?;
    }

    Ok(backup_dir
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("backup")
        .to_string())
}

fn apply_profile_snapshot_opencode_only(source_dir: &Path) -> CmdResult<String> {
    let backup_dir =
        backups_dir()?.join(format!("backup_{}", Local::now().format("%Y%m%d_%H%M%S")));
    fs::create_dir_all(&backup_dir).map_err(|e| format!("创建备份目录失败: {e}"))?;
    apply_opencode_snapshot_to_live_auth(source_dir, &backup_dir)?;
    Ok(backup_dir
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("backup")
        .to_string())
}

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

fn build_auto_profile_base(quota: &AccountQuota) -> String {
    let email = quota.email.clone().unwrap_or_default();
    let workspace = quota
        .workspace_name
        .clone()
        .or_else(|| quota.workspace_id.clone())
        .unwrap_or_default();
    let email = email.trim();
    let workspace = workspace.trim();

    if !email.is_empty() && !workspace.is_empty() {
        format!("{email} [{workspace}]")
    } else if !workspace.is_empty() {
        workspace.to_string()
    } else if !email.is_empty() {
        email.to_string()
    } else {
        "current-account".to_string()
    }
}

fn refresh_one_profile_quota(store: &mut StoreData, name: &str, refresh_token: bool) -> bool {
    let Some(record_value) = store.profiles.get(name).cloned() else {
        return false;
    };
    let mut record = record_value.as_object().cloned().unwrap_or_default();
    let snapshot_dir = match record_snapshot_dir(name, &record) {
        Ok(v) => v,
        Err(err) => {
            record.insert("last_checked_at".to_string(), Value::String(now_iso()));
            record.insert("last_error".to_string(), Value::String(err));
            store
                .profiles
                .insert(name.to_string(), Value::Object(record));
            return false;
        }
    };

    if !snapshot_dir.join(AUTH_FILE_NAME).exists() {
        record.insert("last_checked_at".to_string(), Value::String(now_iso()));
        record.insert(
            "last_error".to_string(),
            Value::String(format!("缺少 {}", AUTH_FILE_NAME)),
        );
        store
            .profiles
            .insert(name.to_string(), Value::Object(record));
        return false;
    }

    match fetch_quota_from_codex_home(&snapshot_dir, refresh_token) {
        Ok(quota) => {
            record.insert(
                "email".to_string(),
                quota.email.map(Value::String).unwrap_or(Value::Null),
            );
            record.insert(
                "workspace_name".to_string(),
                quota
                    .workspace_name
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            record.insert(
                "workspace_id".to_string(),
                quota.workspace_id.map(Value::String).unwrap_or(Value::Null),
            );
            record.insert(
                "plan_type".to_string(),
                quota.plan_type.map(Value::String).unwrap_or(Value::Null),
            );
            let quota_value = json!({
                "five_hour": quota.five_hour,
                "one_week": quota.one_week
            });
            record.insert("quota".to_string(), quota_value);
            record.insert("last_checked_at".to_string(), Value::String(now_iso()));
            record.insert("last_error".to_string(), Value::Null);
            store
                .profiles
                .insert(name.to_string(), Value::Object(record));
            true
        }
        Err(err) => {
            record.insert("last_checked_at".to_string(), Value::String(now_iso()));
            record.insert("last_error".to_string(), Value::String(err));
            store
                .profiles
                .insert(name.to_string(), Value::Object(record));
            false
        }
    }
}

fn quota_fields_from_record(
    record: &Map<String, Value>,
) -> (Option<i64>, Option<i64>, Option<i64>, Option<i64>) {
    let quota = record.get("quota").and_then(Value::as_object);
    let five = quota
        .and_then(|q| q.get("five_hour").or_else(|| q.get("fiveHour")))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let week = quota
        .and_then(|q| q.get("one_week").or_else(|| q.get("oneWeek")))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let read_i64 = |obj: &Map<String, Value>, key1: &str, key2: &str| {
        obj.get(key1)
            .or_else(|| obj.get(key2))
            .and_then(Value::as_i64)
    };
    let calc_remaining_from_used = |obj: &Map<String, Value>| {
        read_i64(obj, "used_percent", "usedPercent").map(|used| (100 - used).clamp(0, 100))
    };

    let five_pct = read_i64(&five, "remaining_percent", "remainingPercent")
        .or_else(|| calc_remaining_from_used(&five));
    let five_reset = read_i64(&five, "resets_at", "resetsAt");
    let week_pct = read_i64(&week, "remaining_percent", "remainingPercent")
        .or_else(|| calc_remaining_from_used(&week));
    let week_reset = read_i64(&week, "resets_at", "resetsAt");
    (five_pct, five_reset, week_pct, week_reset)
}

fn build_profile_view(store: &StoreData, name: &str, record: &Map<String, Value>) -> ProfileView {
    let snapshot_dir = record_snapshot_dir(name, record).unwrap_or_else(|_| PathBuf::from(name));
    let mut workspace_name = record
        .get("workspace_name")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let mut workspace_id = record
        .get("workspace_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    if workspace_name.as_deref().unwrap_or("").trim().is_empty()
        && workspace_id.as_deref().unwrap_or("").trim().is_empty()
    {
        let (wname, wid) = read_workspace_info_from_auth_file(&snapshot_dir.join(AUTH_FILE_NAME));
        workspace_name = wname;
        workspace_id = wid;
    }

    let workspace_alias = record
        .get("workspace_alias")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToString::to_string);
    let support = profile_support_from_value(record.get("support"));
    let display_workspace = format_workspace_display(
        workspace_name.as_deref(),
        workspace_id.as_deref(),
        workspace_alias.as_deref(),
    );
    let (five_pct, five_reset, week_pct, week_reset) = quota_fields_from_record(record);
    let validity = profile_validity(record, &snapshot_dir);
    let is_active = store.active_profile.as_deref() == Some(name);
    let status = if is_active {
        format!("{validity}(当前生效)")
    } else {
        validity
    };

    ProfileView {
        name: name.to_string(),
        email: record
            .get("email")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        workspace_name,
        workspace_id,
        workspace_alias,
        support,
        display_workspace,
        five_hour_remaining_percent: five_pct,
        five_hour_resets_at: five_reset,
        one_week_remaining_percent: week_pct,
        one_week_resets_at: week_reset,
        last_checked_at: record
            .get("last_checked_at")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        last_error: record
            .get("last_error")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        status,
        is_active,
    }
}

fn build_dashboard(
    store: &StoreData,
    current: Option<CurrentStatusView>,
    current_error: Option<String>,
) -> DashboardData {
    let mut profiles = Vec::new();
    for name in list_profile_names(store) {
        let record = store
            .profiles
            .get(&name)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        profiles.push(build_profile_view(store, &name, &record));
    }
    DashboardData {
        app_name: APP_NAME.to_string(),
        active_profile: store.active_profile.clone(),
        current,
        current_error,
        last_keepalive_at: store.last_keepalive_at,
        profiles,
    }
}

fn current_quota_runtime_cache() -> &'static Mutex<CurrentQuotaRuntimeCache> {
    CURRENT_QUOTA_RUNTIME_CACHE.get_or_init(|| Mutex::new(CurrentQuotaRuntimeCache::default()))
}

fn cached_current_quota_snapshot(now_ms: i64) -> Option<(AccountQuota, i64)> {
    let cache = current_quota_runtime_cache().lock().ok()?;
    let quota = cache.quota.clone()?;
    if cache.fetched_at_ms <= 0 {
        return None;
    }
    let age_ms = now_ms.saturating_sub(cache.fetched_at_ms);
    if age_ms > CURRENT_QUOTA_CACHE_MAX_AGE_MS {
        return None;
    }
    Some((quota, age_ms))
}

fn update_current_quota_runtime_cache(quota: &AccountQuota, now_ms: i64) {
    if let Ok(mut cache) = current_quota_runtime_cache().lock() {
        cache.quota = Some(quota.clone());
        cache.fetched_at_ms = now_ms;
        cache.last_error = None;
        cache.last_error_at_ms = 0;
    }
}

fn mark_current_quota_runtime_error(err: &str, now_ms: i64) {
    if let Ok(mut cache) = current_quota_runtime_cache().lock() {
        cache.last_error = Some(err.to_string());
        cache.last_error_at_ms = now_ms;
    }
}

fn cached_quota_matches_live_workspace(codex_home: &Path, quota: &AccountQuota) -> bool {
    let (_, live_workspace_id) =
        read_workspace_info_from_auth_file(&codex_home.join(AUTH_FILE_NAME));
    let live = live_workspace_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    let cached = quota
        .workspace_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if live.is_empty() || cached.is_empty() {
        return true;
    }
    live.eq_ignore_ascii_case(&cached)
}

fn current_status_from_quota(store: &StoreData, quota: &AccountQuota) -> CurrentStatusView {
    let alias = find_workspace_alias_by_identity(
        store,
        quota.workspace_id.as_deref(),
        quota.email.as_deref(),
    );
    let display_workspace = format_workspace_display(
        quota.workspace_name.as_deref(),
        quota.workspace_id.as_deref(),
        alias.as_deref(),
    );
    CurrentStatusView {
        email: quota.email.clone(),
        workspace_name: quota.workspace_name.clone(),
        workspace_id: quota.workspace_id.clone(),
        display_workspace,
        five_hour_remaining_percent: quota.five_hour.as_ref().and_then(|v| v.remaining_percent),
        five_hour_resets_at: quota.five_hour.as_ref().and_then(|v| v.resets_at),
        one_week_remaining_percent: quota.one_week.as_ref().and_then(|v| v.remaining_percent),
        one_week_resets_at: quota.one_week.as_ref().and_then(|v| v.resets_at),
    }
}

fn auto_sync_current_account_to_list(
    store: &mut StoreData,
    quota: &AccountQuota,
) -> CmdResult<String> {
    let matched = find_profile_name_by_identity_prefer_existing(
        store,
        quota.workspace_id.as_deref(),
        quota.email.as_deref(),
    );

    if let Some(name) = matched {
        let target = profile_snapshot_dir(&name)?;
        copy_current_account_snapshot(&target)?;
        let existing = store.profiles.get(&name).and_then(Value::as_object);
        let record = build_profile_record(&name, &target, quota, existing);
        store.profiles.insert(name.clone(), record);
        store.active_profile = Some(name.clone());
        return Ok(name);
    }

    let auto_name = next_auto_profile_name(store, Some(&build_auto_profile_base(quota)));
    let target = profile_snapshot_dir(&auto_name)?;
    copy_current_account_snapshot(&target)?;
    let record = build_profile_record(&auto_name, &target, quota, None);
    store.profiles.insert(auto_name.clone(), record);
    store.active_profile = Some(auto_name.clone());
    Ok(auto_name)
}

fn load_dashboard_internal(sync_current: bool) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let mut current = None;
    let mut current_error = None;
    let codex_home = codex_home()?;
    let now_ms = now_ts_ms();
    let cached_quota = cached_current_quota_snapshot(now_ms).and_then(|(quota, age_ms)| {
        if cached_quota_matches_live_workspace(&codex_home, &quota) {
            Some((quota, age_ms))
        } else {
            None
        }
    });

    let can_use_fresh_cached = !sync_current
        && cached_quota
            .as_ref()
            .map(|(_, age_ms)| *age_ms <= CURRENT_QUOTA_CACHE_FRESH_MS)
            .unwrap_or(false);
    if can_use_fresh_cached {
        if let Some((quota, _)) = cached_quota.as_ref() {
            current = Some(current_status_from_quota(&store, quota));
            return Ok(build_dashboard(&store, current, current_error));
        }
    }

    // Prefer live ~/.codex; fallback to recent cache when host/limit endpoint transiently fails.
    match fetch_quota_from_codex_home(&codex_home, false) {
        Ok(quota) => {
            update_current_quota_runtime_cache(&quota, now_ms);
            if sync_current {
                auto_sync_current_account_to_list(&mut store, &quota)?;
                save_store(&store)?;
            }
            current = Some(current_status_from_quota(&store, &quota));
        }
        Err(err) => {
            mark_current_quota_runtime_error(&err, now_ms);
            if let Some((quota, age_ms)) = cached_quota {
                current = Some(current_status_from_quota(&store, &quota));
                if sync_current && age_ms > CURRENT_QUOTA_CACHE_FRESH_MS {
                    current_error = Some(format!(
                        "默认环境读取失败: {err}（已回退到缓存，{}秒前）",
                        age_ms / 1000
                    ));
                }
            } else {
                current_error = Some(format!("默认环境读取失败: {err}"));
            }
        }
    }
    Ok(build_dashboard(&store, current, current_error))
}

fn save_current_profile_internal(profile_name: &str) -> CmdResult<DashboardData> {
    let profile_name = profile_name.trim();
    if profile_name.is_empty() {
        return Err("账号名称不能为空。".to_string());
    }
    let mut store = load_store()?;
    let quota = fetch_quota_from_codex_home(&codex_home()?, false)?;
    let matched = find_profile_name_by_identity_prefer_existing(
        &store,
        quota.workspace_id.as_deref(),
        quota.email.as_deref(),
    );

    let final_name = matched.unwrap_or_else(|| profile_name.to_string());
    let target = profile_snapshot_dir(&final_name)?;
    copy_current_account_snapshot(&target)?;
    let existing = store.profiles.get(&final_name).and_then(Value::as_object);
    let record = build_profile_record(&final_name, &target, &quota, existing);
    store.profiles.insert(final_name.clone(), record);
    if store.active_profile.is_none() {
        store.active_profile = Some(final_name);
    }
    save_store(&store)?;
    load_dashboard_internal(false)
}

fn finalize_login_target(
    store: &mut StoreData,
    target: &Path,
    alias_opt: &Option<String>,
) -> CmdResult<String> {
    let auth_file = target.join(AUTH_FILE_NAME);
    if !auth_file.exists() {
        return Err("登录已完成，但未检测到登录态文件 auth.json，请重试。".to_string());
    }
    if !target.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME).exists() {
        let _ = ensure_opencode_snapshot_from_codex_auth(target);
    }

    let login_result_message = match fetch_quota_from_codex_home(target, false) {
        Ok(quota) => {
            let existing = find_profile_name_by_identity_prefer_existing(
                store,
                quota.workspace_id.as_deref(),
                quota.email.as_deref(),
            );
            let is_overwrite_existing = existing.is_some();

            let (final_name, final_dir) = if let Some(name) = existing {
                let current_record = store
                    .profiles
                    .get(&name)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let final_dir = record_snapshot_dir(&name, &current_record)?;
                fs::create_dir_all(&final_dir).map_err(|e| format!("创建账号目录失败: {e}"))?;
                fs::copy(&auth_file, final_dir.join(AUTH_FILE_NAME))
                    .map_err(|e| format!("复制登录 auth.json 失败: {e}"))?;
                for optional in [
                    CAP_SID_FILE_NAME,
                    CONFIG_FILE_NAME,
                    OPENCODE_OPENAI_SNAPSHOT_FILE_NAME,
                ] {
                    let src = target.join(optional);
                    if src.exists() {
                        let _ = fs::copy(&src, final_dir.join(optional));
                    }
                }
                safe_remove_dir(target);
                (name, final_dir)
            } else {
                let base = build_auto_profile_base(&quota);
                let final_name = next_auto_profile_name(store, Some(&base));
                let final_dir = profile_snapshot_dir(&final_name)?;
                if fs::rename(target, &final_dir).is_err() {
                    fs::create_dir_all(&final_dir).map_err(|e| format!("创建账号目录失败: {e}"))?;
                    fs::copy(&auth_file, final_dir.join(AUTH_FILE_NAME))
                        .map_err(|e| format!("复制登录 auth.json 失败: {e}"))?;
                    for optional in [
                        CAP_SID_FILE_NAME,
                        CONFIG_FILE_NAME,
                        OPENCODE_OPENAI_SNAPSHOT_FILE_NAME,
                    ] {
                        let src = target.join(optional);
                        if src.exists() {
                            let _ = fs::copy(&src, final_dir.join(optional));
                        }
                    }
                    safe_remove_dir(target);
                }
                (final_name, final_dir)
            };

            let existing_record = store.profiles.get(&final_name).and_then(Value::as_object);
            let mut record = build_profile_record(&final_name, &final_dir, &quota, existing_record)
                .as_object()
                .cloned()
                .unwrap_or_default();
            if final_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME).exists() {
                record.insert(
                    "support".to_string(),
                    profile_support_json(ProfileSupportView {
                        gpt: true,
                        opencode: true,
                    }),
                );
            }
            if let Some(alias) = alias_opt.as_ref() {
                record.insert("workspace_alias".to_string(), Value::String(alias.clone()));
            }
            let replaced_old = store
                .profiles
                .insert(final_name.clone(), Value::Object(record))
                .is_some();
            if store.active_profile.is_none() {
                store.active_profile = Some(final_name);
            }
            if replaced_old || is_overwrite_existing {
                "检测到相同账号身份，已覆盖旧记录。".to_string()
            } else {
                "新增账号成功。".to_string()
            }
        }
        Err(err) => {
            let base = format!("new-account-{}", Local::now().format("%H%M%S"));
            let final_name = next_auto_profile_name(store, Some(&base));
            let final_dir = profile_snapshot_dir(&final_name)?;
            if fs::rename(target, &final_dir).is_err() {
                fs::create_dir_all(&final_dir).map_err(|e| format!("创建账号目录失败: {e}"))?;
                fs::copy(&auth_file, final_dir.join(AUTH_FILE_NAME))
                    .map_err(|e| format!("复制登录 auth.json 失败: {e}"))?;
                let openai_snapshot = target.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME);
                if openai_snapshot.exists() {
                    let _ = fs::copy(
                        &openai_snapshot,
                        final_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME),
                    );
                }
                safe_remove_dir(target);
            }
            let (workspace_name, workspace_id) =
                read_workspace_info_from_auth_file(&final_dir.join(AUTH_FILE_NAME));
            let support = if final_dir.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME).exists() {
                profile_support_json(ProfileSupportView {
                    gpt: true,
                    opencode: true,
                })
            } else {
                profile_support_json(default_profile_support())
            };
            let record = json!({
                "name": final_name,
                "snapshot_dir": final_dir.to_string_lossy().to_string(),
                "email": Value::Null,
                "workspace_name": workspace_name,
                "workspace_id": workspace_id,
                "workspace_alias": alias_opt.clone().map(Value::String).unwrap_or(Value::Null),
                "support": support,
                "plan_type": Value::Null,
                "quota": {"five_hour": Value::Null, "one_week": Value::Null},
                "last_checked_at": now_iso(),
                "last_error": format!("登录完成，但读取账号/额度失败：{err}"),
                "updated_at": now_iso()
            });
            store.profiles.insert(final_name.clone(), record);
            if store.active_profile.is_none() {
                store.active_profile = Some(final_name.clone());
            }
            format!("登录完成，但读取账号信息失败，已按新账号保存：{final_name}")
        }
    };

    Ok(login_result_message)
}

fn add_account_by_login_internal(
    app: &tauri::AppHandle,
    workspace_alias: Option<String>,
) -> CmdResult<DashboardData> {
    emit_login_progress(app, "opening", "正在打开内嵌登录窗口...");
    let alias = workspace_alias.unwrap_or_default();
    let alias = alias.trim().to_string();
    let mut alias_opt = if alias.is_empty() { None } else { Some(alias) };

    let mut store = load_store()?;
    let target = make_pending_login_dir()?;
    let auth_file = target.join(AUTH_FILE_NAME);
    if let Err(err) = ensure_login_callback_port_ready() {
        safe_remove_dir(&target);
        return Err(err);
    }
    let mut login_session = match start_browser_oauth_login_session() {
        Ok(v) => v,
        Err(err) => {
            safe_remove_dir(&target);
            return Err(format!("启动内嵌登录失败：{err}"));
        }
    };
    let login_window_label = format!("login-{}", Local::now().format("%Y%m%d_%H%M%S%3f"));
    let login_window =
        match open_embedded_login_window(app, &login_window_label, &login_session.auth_url) {
            Ok(v) => v,
            Err(err) => {
                shutdown_browser_oauth_login_session(&mut login_session);
                safe_remove_dir(&target);
                return Err(err);
            }
        };
    if login_session.callback_port != LOGIN_CALLBACK_PORT {
        emit_login_progress(
            app,
            "callback_port_switched",
            &format!(
                "1455 已被占用，已切换到内嵌回调端口 {} 继续登录。",
                login_session.callback_port
            ),
        );
    }
    emit_login_progress(app, "awaiting_login", "请在内嵌窗口完成登录...");

    let deadline = Instant::now() + Duration::from_secs(CHATGPT_BROWSER_OAUTH_TIMEOUT_SECS);
    let mut login_error: Option<String> = None;
    let mut completed = false;

    while Instant::now() < deadline {
        if let Some(window) = app.get_webview_window(&login_window.label) {
            let _ = window.eval(WORKSPACE_CAPTURE_SCRIPT);
            let _ = window.eval(LOGIN_ERROR_CAPTURE_SCRIPT);
            if let Ok(title) = window.title() {
                if let Some(text) = title.strip_prefix(WORKSPACE_CAPTURE_TITLE_PREFIX) {
                    let clean = text.trim().replace('\n', " ");
                    if !clean.is_empty() {
                        if let Ok(mut guard) = login_window.selected_workspace_name.lock() {
                            *guard = Some(clean);
                        }
                    }
                }
                if let Some(text) = title.strip_prefix(LOGIN_ERROR_CAPTURE_TITLE_PREFIX) {
                    let detail = text.trim();
                    let detail = if detail.is_empty() {
                        "unknown_error".to_string()
                    } else {
                        detail.to_string()
                    };
                    login_error = Some(format!("内嵌登录验证失败：{detail}"));
                    break;
                }
            }
        } else {
            login_error = Some("已取消登录（登录窗口已关闭）。".to_string());
            break;
        }

        match login_session.rx.recv_timeout(Duration::from_millis(350)) {
            Ok(result) => match result {
                Ok(tokens) => {
                    emit_login_progress(app, "token_exchange", "授权成功，正在保存登录态...");
                    if let Err(err) = persist_chatgpt_tokens_to_auth_file(&target, &tokens) {
                        login_error = Some(err);
                        break;
                    }
                    if let Err(err) = write_opencode_openai_snapshot(&target, &tokens) {
                        login_error = Some(err);
                        break;
                    }
                    completed = true;
                    break;
                }
                Err(err) => {
                    login_error = Some(err);
                    break;
                }
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if auth_file.exists() {
                    completed = true;
                } else {
                    login_error = Some("登录回调连接中断。".to_string());
                }
                break;
            }
        }
    }

    if completed && !auth_file.exists() {
        let grace_deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < grace_deadline && !auth_file.exists() {
            thread::sleep(Duration::from_millis(200));
        }
    }

    close_login_window(app, &login_window.label);
    shutdown_browser_oauth_login_session(&mut login_session);

    if !completed {
        safe_remove_dir(&target);
        return Err(
            login_error.unwrap_or_else(|| "15 分钟内未检测到登录完成事件，请重试。".to_string())
        );
    }
    if !auth_file.exists() {
        safe_remove_dir(&target);
        return Err("登录已完成，但未检测到登录态文件 auth.json，请重试。".to_string());
    }
    if !target.join(OPENCODE_OPENAI_SNAPSHOT_FILE_NAME).exists() {
        let _ = ensure_opencode_snapshot_from_codex_auth(&target);
    }
    if alias_opt.is_none() {
        alias_opt = login_window
            .selected_workspace_name
            .lock()
            .ok()
            .and_then(|v| v.clone())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
    }

    emit_login_progress(app, "fetching_profile", "登录完成，正在拉取账号信息...");
    let login_result_message = finalize_login_target(&mut store, &target, &alias_opt)?;

    save_store(&store)?;
    emit_login_progress(app, "done", &login_result_message);
    load_dashboard_internal(true)
}

fn apply_profile_internal(name: &str) -> CmdResult<DashboardData> {
    apply_profile_internal_for_mode(name, None)
}

fn apply_profile_internal_for_mode(name: &str, mode: Option<&str>) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    let record = store
        .profiles
        .get(profile_name)
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| format!("账号不存在：{profile_name}"))?;
    let source = record_snapshot_dir(profile_name, &record)?;
    match mode.unwrap_or("both").trim().to_lowercase().as_str() {
        "both" => {
            let _backup_name = apply_profile_snapshot(&source)?;
            store.active_profile = Some(profile_name.to_string());
            save_store(&store)?;
            load_dashboard_internal(true)
        }
        "gpt" => {
            let _backup_name = apply_profile_snapshot_codex_only(&source)?;
            store.active_profile = Some(profile_name.to_string());
            save_store(&store)?;
            load_dashboard_internal(true)
        }
        "opencode" => {
            let _backup_name = apply_profile_snapshot_opencode_only(&source)?;
            // OpenCode 独立切号不应影响 Codex 当前账号指针。
            load_dashboard_internal(false)
        }
        other => Err(format!(
            "不支持的切号模式: {other}。可选值: gpt / opencode / both"
        )),
    }
}

fn active_profile_workspace_id_internal(store: &StoreData) -> Option<String> {
    let active_name = store.active_profile.as_ref()?;
    let record = store.profiles.get(active_name).and_then(Value::as_object)?;
    read_workspace_id_from_record_or_auth(active_name, record)
}

fn live_workspace_id_internal() -> Option<String> {
    let home = codex_home().ok()?;
    let (_, wid) = read_workspace_info_from_auth_file(&home.join(AUTH_FILE_NAME));
    wid
}

fn ensure_live_auth_matches_active_profile_internal() -> CmdResult<Option<String>> {
    let store = load_store()?;
    let Some(active_name) = store.active_profile.as_ref() else {
        return Ok(None);
    };
    let Some(expected_workspace_id) = active_profile_workspace_id_internal(&store) else {
        return Ok(None);
    };
    let current_workspace_id = live_workspace_id_internal();
    if current_workspace_id.as_deref() == Some(expected_workspace_id.as_str()) {
        return Ok(None);
    }

    let record = store
        .profiles
        .get(active_name)
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| format!("账号不存在：{active_name}"))?;
    let source = record_snapshot_dir(active_name, &record)?;
    let _ = apply_profile_snapshot(&source)?;

    let after_workspace_id = live_workspace_id_internal();
    if after_workspace_id.as_deref() == Some(expected_workspace_id.as_str()) {
        Ok(Some(
            "检测到本地 auth 未切到目标账号，已自动重新写入账号快照。".to_string(),
        ))
    } else {
        Err(format!(
            "本地 auth 与目标账号不一致，重写后仍不一致。目标={} 当前={}",
            expected_workspace_id,
            after_workspace_id.unwrap_or_else(|| "-".to_string())
        ))
    }
}

fn set_workspace_alias_internal(name: &str, alias: Option<String>) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    let record_value = store
        .profiles
        .get(profile_name)
        .cloned()
        .ok_or_else(|| format!("账号不存在：{profile_name}"))?;
    let mut record = record_value.as_object().cloned().unwrap_or_default();
    if let Some(v) = alias.map(|v| v.trim().to_string()) {
        if v.is_empty() {
            record.remove("workspace_alias");
        } else {
            record.insert("workspace_alias".to_string(), Value::String(v));
        }
    } else {
        record.remove("workspace_alias");
    }
    record.insert("updated_at".to_string(), Value::String(now_iso()));
    store
        .profiles
        .insert(profile_name.to_string(), Value::Object(record));
    save_store(&store)?;
    load_dashboard_internal(true)
}

fn set_profile_support_internal(name: &str, gpt: bool, opencode: bool) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    if !gpt && !opencode {
        return Err("支持标签至少选择一个：GPT 或 OpenCode。".to_string());
    }
    let record_value = store
        .profiles
        .get(profile_name)
        .cloned()
        .ok_or_else(|| format!("账号不存在：{profile_name}"))?;
    let mut record = record_value.as_object().cloned().unwrap_or_default();
    let support = ProfileSupportView { gpt, opencode };
    record.insert("support".to_string(), profile_support_json(support));
    record.insert("updated_at".to_string(), Value::String(now_iso()));
    store
        .profiles
        .insert(profile_name.to_string(), Value::Object(record));
    save_store(&store)?;
    load_dashboard_internal(true)
}

fn refresh_profile_quota_internal(name: &str, refresh_token: bool) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    if !store.profiles.contains_key(profile_name) {
        return Err(format!("账号不存在：{profile_name}"));
    }
    let _ = refresh_one_profile_quota(&mut store, profile_name, refresh_token);
    save_store(&store)?;
    load_dashboard_internal(true)
}

fn refresh_all_quota_internal(refresh_token: bool) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let names = list_profile_names(&store);
    for name in names {
        let _ = refresh_one_profile_quota(&mut store, &name, refresh_token);
    }
    save_store(&store)?;
    load_dashboard_internal(true)
}

fn keepalive_all_internal() -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let names = list_profile_names(&store);
    for name in names {
        let _ = refresh_one_profile_quota(&mut store, &name, true);
    }
    store.last_keepalive_at = Some(Local::now().timestamp());
    save_store(&store)?;
    load_dashboard_internal(true)
}

fn delete_profile_internal(name: &str) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let profile_name = name.trim();
    if profile_name.is_empty() {
        return Err("请先选择账号。".to_string());
    }
    let Some(record) = store
        .profiles
        .get(profile_name)
        .and_then(Value::as_object)
        .cloned()
    else {
        return Err(format!("账号不存在：{profile_name}"));
    };

    if let Ok(snapshot_dir) = record_snapshot_dir(profile_name, &record) {
        safe_remove_dir(&snapshot_dir);
    }
    store.profiles.remove(profile_name);
    if store.active_profile.as_deref() == Some(profile_name) {
        store.active_profile = None;
    }
    save_store(&store)?;
    load_dashboard_internal(false)
}

fn reorder_profiles_internal(names: Vec<String>) -> CmdResult<DashboardData> {
    let mut store = load_store()?;
    let mut ordered: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for name in names {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !store.profiles.contains_key(trimmed) {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            ordered.push(trimmed.to_string());
        }
    }

    store.profile_order = ordered;
    normalize_profile_order(&mut store);
    save_store(&store)?;
    load_dashboard_internal(false)
}

#[cfg(target_os = "windows")]
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

    for alias in ["code", "code-insiders", "cursor", "windsurf"] {
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
    bins
}

#[cfg(target_os = "windows")]
fn preferred_editor_kinds_internal() -> Vec<&'static str> {
    let mut kinds: Vec<&'static str> = Vec::new();
    if let Some(latest_log) = find_latest_codex_extension_log_file() {
        if let Some(kind) = editor_kind_from_codex_log_path(&latest_log) {
            kinds.push(kind);
        }
    }
    if kinds.is_empty() {
        let counts = count_windows_processes_by_images(&[
            "Windsurf.exe",
            "Cursor.exe",
            "Code.exe",
            "Code - Insiders.exe",
        ]);
        let windsurf_running = counts.get("windsurf.exe").copied().unwrap_or(0) > 0;
        let cursor_running = counts.get("cursor.exe").copied().unwrap_or(0) > 0;
        let vscode_running = counts.get("code.exe").copied().unwrap_or(0) > 0
            || counts.get("code - insiders.exe").copied().unwrap_or(0) > 0;
        if windsurf_running {
            kinds.push("windsurf");
        }
        if cursor_running {
            kinds.push("cursor");
        }
        if vscode_running {
            kinds.push("vscode");
        }
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
            format!("vscode://command/{command_id}"),
        ]
    } else {
        preferred_kinds
            .iter()
            .map(|kind| match *kind {
                "windsurf" => format!("windsurf://command/{command_id}"),
                "cursor" => format!("cursor://command/{command_id}"),
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
                let is_vscode = !is_windsurf
                    && !is_cursor
                    && (lower.contains("code-insiders")
                        || lower.contains("\\code")
                        || lower.ends_with("code")
                        || lower.ends_with("code.exe"));
                let matched = (preferred_kinds.contains(&"windsurf") && is_windsurf)
                    || (preferred_kinds.contains(&"cursor") && is_cursor)
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
        let script = r#"Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'Code.exe' -or $_.Name -eq 'Code - Insiders.exe') -and $_.CommandLine -match '--utility-sub-type=node\.mojom\.NodeService' -and $_.CommandLine -match '--inspect-port=0' } | ForEach-Object { $_.ProcessId }"#;
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

fn get_vscode_status_internal() -> VsCodeStatusView {
    #[cfg(target_os = "windows")]
    let process_count = {
        let counts = count_windows_processes_by_images(&[
            "Code.exe",
            "Code - Insiders.exe",
            "Cursor.exe",
            "Windsurf.exe",
        ]);
        counts.values().sum::<u64>()
    };

    #[cfg(not(target_os = "windows"))]
    let process_count = {
        count_unix_processes_by_name("code")
            + count_unix_processes_by_name("code-insiders")
            + count_unix_processes_by_name("Code")
            + count_unix_processes_by_name("cursor")
            + count_unix_processes_by_name("Cursor")
            + count_unix_processes_by_name("windsurf")
            + count_unix_processes_by_name("Windsurf")
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
            if !has_codex_hook_installed_internal() {
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
        if let Ok(msg) = install_codex_hook_internal() {
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

fn now_ts_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn value_to_i64(v: &Value) -> Option<i64> {
    if let Some(x) = v.as_i64() {
        return Some(x);
    }
    if let Some(x) = v.as_u64() {
        return i64::try_from(x).ok();
    }
    v.as_f64().map(|x| x.round() as i64)
}

fn read_num_from_map(map: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(v) = map.get(*key).and_then(value_to_i64) {
            return Some(v);
        }
    }
    None
}

fn parse_rate_window_remaining(window: &Map<String, Value>) -> Option<(i64, i64)> {
    let minutes = read_num_from_map(
        window,
        &["window_minutes", "windowMinutes", "windowDurationMins"],
    )?;
    let remaining =
        read_num_from_map(window, &["remaining_percent", "remainingPercent"]).or_else(|| {
            read_num_from_map(window, &["used_percent", "usedPercent"])
                .map(|used| (100 - used).clamp(0, 100))
        })?;
    Some((minutes, remaining.clamp(0, 100)))
}

fn pick_remaining_window(
    windows: &[(i64, i64)],
    target_minutes: i64,
    tolerance_minutes: i64,
) -> Option<i64> {
    windows
        .iter()
        .filter_map(|(mins, remain)| {
            let diff = (*mins - target_minutes).abs();
            if diff <= tolerance_minutes {
                Some((diff, *remain))
            } else {
                None
            }
        })
        .min_by_key(|(diff, _)| *diff)
        .map(|(_, remain)| remain)
}

fn merge_runtime_quota_from_rate_limits(
    snapshot: &mut SessionQuotaSnapshot,
    rate_limits: &Map<String, Value>,
) {
    let mut windows: Vec<(i64, i64)> = Vec::new();
    for key in ["primary", "secondary"] {
        if let Some(obj) = rate_limits.get(key).and_then(Value::as_object) {
            if let Some(parsed) = parse_rate_window_remaining(obj) {
                windows.push(parsed);
            }
        }
    }

    let five = pick_remaining_window(&windows, 300, 30);
    let week = pick_remaining_window(&windows, 10080, 12 * 60);
    let mut changed = false;
    if let Some(v) = five {
        snapshot.five_hour_remaining_percent = Some(v);
        changed = true;
    }
    if let Some(v) = week {
        snapshot.one_week_remaining_percent = Some(v);
        changed = true;
    }
    if changed {
        snapshot.updated_at_ms = Some(now_ts_ms());
    }
}

fn contains_hard_quota_error_text(text: &str) -> bool {
    let lowered = text.trim().to_lowercase();
    if lowered.is_empty() {
        return false;
    }
    HARD_QUOTA_ERROR_KEYWORDS
        .iter()
        .any(|kw| lowered.contains(kw))
}

fn contains_http_429(value: &Value) -> bool {
    match value {
        Value::Number(_) => value_to_i64(value) == Some(429),
        Value::String(v) => v.contains("429"),
        Value::Array(arr) => arr.iter().any(contains_http_429),
        Value::Object(map) => map.values().any(contains_http_429),
        _ => false,
    }
}

fn hard_quota_reason_from_event_payload(payload: &Map<String, Value>) -> Option<String> {
    if let Some(codex_error) = payload.get("codex_error_info") {
        if let Some(code) = codex_error.as_str() {
            let lowered = code.to_lowercase();
            if lowered == "usage_limit_exceeded" || contains_hard_quota_error_text(&lowered) {
                return Some(code.to_string());
            }
        }
        if contains_http_429(codex_error) {
            return Some("http_429".to_string());
        }
        let text = codex_error.to_string();
        if contains_hard_quota_error_text(&text) {
            return Some(text);
        }
    }

    let message = payload
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if contains_hard_quota_error_text(message) {
        return Some(message.to_string());
    }
    None
}

fn process_event_msg_payload(payload: &Map<String, Value>, session: &mut SessionTailState) {
    let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
    match event_type {
        "task_started" => {
            if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                session.open_turns.insert(turn_id.to_string());
            }
            session.event_seq = session.event_seq.saturating_add(1);
        }
        "task_complete" => {
            if let Some(turn_id) = payload.get("turn_id").and_then(Value::as_str) {
                session.open_turns.remove(turn_id);
            }
            session.event_seq = session.event_seq.saturating_add(1);
        }
        "user_message" => {
            session.user_seq = session.user_seq.saturating_add(1);
            session.event_seq = session.event_seq.saturating_add(1);
        }
        "token_count" => {
            if let Some(rate_limits) = payload.get("rate_limits").and_then(Value::as_object) {
                merge_runtime_quota_from_rate_limits(&mut session.quota, rate_limits);
            }
            session.event_seq = session.event_seq.saturating_add(1);
        }
        "error" | "warning" => {
            if let Some(reason) = hard_quota_reason_from_event_payload(payload) {
                session.hard_trigger_seq = session.hard_trigger_seq.saturating_add(1);
                session.last_hard_trigger_reason = Some(reason);
            }
            session.event_seq = session.event_seq.saturating_add(1);
        }
        _ => {}
    }
}

fn process_session_log_line(line: &str, session: &mut SessionTailState) {
    if line.trim().is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("event_msg") {
        return;
    }
    let Some(payload) = value.get("payload").and_then(Value::as_object) else {
        return;
    };
    process_event_msg_payload(payload, session);
}

fn collect_rollout_session_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rollout_session_files(&path, out);
            continue;
        }
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if name.starts_with("rollout-") && name.ends_with(".jsonl") {
            out.push(path);
        }
    }
}

fn find_latest_rollout_session_file() -> Option<PathBuf> {
    let root = codex_home().ok()?.join("sessions");
    if !root.exists() {
        return None;
    }
    let mut files: Vec<PathBuf> = Vec::new();
    collect_rollout_session_files(&root, &mut files);
    let mut latest: Option<(SystemTime, PathBuf)> = None;
    for file in files {
        let modified = fs::metadata(&file)
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match &latest {
            Some((ts, _)) if modified < *ts => {}
            _ => latest = Some((modified, file)),
        }
    }
    latest.map(|(_, path)| path)
}

fn reset_session_tail_state(session: &mut SessionTailState, path: PathBuf) {
    session.current_file = Some(path);
    session.offset = 0;
    session.open_turns.clear();
    session.event_seq = 0;
    session.user_seq = 0;
    session.quota = SessionQuotaSnapshot::default();
    session.hard_trigger_seq = 0;
    session.last_hard_trigger_reason = None;
}

fn sync_session_tail(runtime: &mut AutoSwitchRuntime) -> CmdResult<()> {
    let now_ms = now_ts_ms();
    let should_scan = runtime.session.current_file.is_none()
        || now_ms - runtime.session.last_scan_at_ms >= AUTO_SWITCH_SESSION_SCAN_INTERVAL_MS;
    if should_scan {
        if let Some(latest_file) = find_latest_rollout_session_file() {
            let changed = runtime
                .session
                .current_file
                .as_ref()
                .map(|p| p != &latest_file)
                .unwrap_or(true);
            if changed {
                reset_session_tail_state(&mut runtime.session, latest_file);
                runtime.last_observed_hard_trigger_seq = 0;
            }
        }
        runtime.session.last_scan_at_ms = now_ms;
    }

    let Some(path) = runtime.session.current_file.clone() else {
        return Ok(());
    };
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(()),
    };
    let file_len = file.metadata().ok().map(|m| m.len()).unwrap_or(0);
    if runtime.session.offset > file_len {
        runtime.session.offset = 0;
        runtime.session.open_turns.clear();
        runtime.session.event_seq = 0;
        runtime.session.user_seq = 0;
        runtime.session.quota = SessionQuotaSnapshot::default();
        runtime.session.hard_trigger_seq = 0;
        runtime.session.last_hard_trigger_reason = None;
        runtime.last_observed_hard_trigger_seq = 0;
    }
    if file.seek(SeekFrom::Start(runtime.session.offset)).is_err() {
        return Ok(());
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取会话日志失败: {e}"))?;
        if bytes == 0 {
            break;
        }
        let clean = line.trim_end_matches(&['\r', '\n'][..]);
        process_session_log_line(clean, &mut runtime.session);
    }
    runtime.session.offset = reader.stream_position().unwrap_or(file_len);
    Ok(())
}

fn collect_opencode_log_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_opencode_log_files(&path, out);
            continue;
        }
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if name.ends_with(".log") {
            out.push(path);
        }
    }
}

fn find_latest_opencode_log_file() -> Option<PathBuf> {
    let root = opencode_data_dir().ok()?.join("log");
    if !root.exists() {
        return None;
    }
    let mut files: Vec<PathBuf> = Vec::new();
    collect_opencode_log_files(&root, &mut files);
    let mut latest: Option<(SystemTime, PathBuf)> = None;
    for file in files {
        let modified = fs::metadata(&file)
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match &latest {
            Some((ts, _)) if modified < *ts => {}
            _ => latest = Some((modified, file)),
        }
    }
    latest.map(|(_, path)| path)
}

fn reset_opencode_log_tail_state(state: &mut OpenCodeLogTailState, path: PathBuf) {
    let offset = fs::metadata(&path).ok().map(|m| m.len()).unwrap_or(0);
    state.current_file = Some(path);
    state.offset = offset;
}

fn extract_opencode_session_id_from_path(line: &str) -> Option<String> {
    let marker = "path=/session/";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest
        .find('/')
        .or_else(|| rest.find(|c: char| c.is_whitespace()))
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn extract_opencode_session_id_from_field(line: &str) -> Option<String> {
    let marker = "sessionID=";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == ')')
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn opencode_log_line_has_message_started(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("service=server")
        && lowered.contains("status=started")
        && lowered.contains("method=post")
        && lowered.contains("path=/session/")
        && lowered.contains("/message")
}

fn opencode_log_line_has_session_idle(line: &str) -> bool {
    line.to_lowercase().contains("type=session.idle publishing")
}

fn opencode_log_line_has_session_prompt_end(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("service=session.prompt")
        && (lowered.contains("exiting loop") || lowered.contains(" cancel"))
}

fn opencode_log_line_has_session_error(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("type=session.error publishing")
        || (lowered.contains("service=session.prompt") && lowered.contains("status=error"))
}

fn opencode_log_line_hard_quota_reason(line: &str) -> Option<String> {
    let lowered = line.to_lowercase();
    let has_error_context = lowered.contains("error")
        || lowered.contains("429")
        || lowered.contains("quota")
        || lowered.contains("rate_limit")
        || lowered.contains("rate limit");
    if !has_error_context {
        return None;
    }
    if !contains_hard_quota_error_text(&lowered) {
        return None;
    }
    let reason = HARD_QUOTA_ERROR_KEYWORDS
        .iter()
        .find(|kw| lowered.contains(**kw))
        .map(|kw| (*kw).to_string())
        .unwrap_or_else(|| "opencode_hard_quota".to_string());
    Some(reason)
}

fn process_opencode_log_line(line: &str, runtime: &mut AutoSwitchRuntime) {
    if opencode_log_line_has_message_started(line) {
        let key = extract_opencode_session_id_from_path(line)
            .unwrap_or_else(|| "__opencode_unknown__".to_string());
        runtime.session.open_turns.insert(key);
        runtime.session.user_seq = runtime.session.user_seq.saturating_add(1);
        runtime.session.event_seq = runtime.session.event_seq.saturating_add(1);
    }

    if opencode_log_line_has_session_prompt_end(line) {
        if let Some(session_id) = extract_opencode_session_id_from_field(line) {
            runtime.session.open_turns.remove(&session_id);
        } else {
            runtime.session.open_turns.clear();
        }
        runtime.session.event_seq = runtime.session.event_seq.saturating_add(1);
    }

    if opencode_log_line_has_session_idle(line) {
        runtime.session.open_turns.clear();
        runtime.session.event_seq = runtime.session.event_seq.saturating_add(1);
    }

    if let Some(reason) = opencode_log_line_hard_quota_reason(line) {
        runtime.session.hard_trigger_seq = runtime.session.hard_trigger_seq.saturating_add(1);
        runtime.session.last_hard_trigger_reason = Some(reason);
        runtime.session.event_seq = runtime.session.event_seq.saturating_add(1);
    }

    if opencode_log_line_has_session_error(line) {
        runtime.opencode_log.session_error_seq =
            runtime.opencode_log.session_error_seq.saturating_add(1);
        runtime.session.event_seq = runtime.session.event_seq.saturating_add(1);
    }
}

fn sync_opencode_log_tail(runtime: &mut AutoSwitchRuntime) -> CmdResult<()> {
    let now_ms = now_ts_ms();
    let should_scan = runtime.opencode_log.current_file.is_none()
        || now_ms - runtime.opencode_log.last_scan_at_ms
            >= AUTO_SWITCH_OPENCODE_LOG_SCAN_INTERVAL_MS;
    if should_scan {
        if let Some(latest_file) = find_latest_opencode_log_file() {
            let changed = runtime
                .opencode_log
                .current_file
                .as_ref()
                .map(|p| p != &latest_file)
                .unwrap_or(true);
            if changed {
                reset_opencode_log_tail_state(&mut runtime.opencode_log, latest_file);
                runtime.last_observed_opencode_session_error_seq =
                    runtime.opencode_log.session_error_seq;
            }
        }
        runtime.opencode_log.last_scan_at_ms = now_ms;
    }

    let Some(path) = runtime.opencode_log.current_file.clone() else {
        return Ok(());
    };
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(()),
    };
    let file_len = file.metadata().ok().map(|m| m.len()).unwrap_or(0);
    if runtime.opencode_log.offset > file_len {
        runtime.opencode_log.offset = file_len;
        runtime.session.open_turns.clear();
    }
    if file
        .seek(SeekFrom::Start(runtime.opencode_log.offset))
        .is_err()
    {
        return Ok(());
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取 OpenCode 日志失败: {e}"))?;
        if bytes == 0 {
            break;
        }
        let clean = line.trim_end_matches(&['\r', '\n'][..]);
        process_opencode_log_line(clean, runtime);
    }
    runtime.opencode_log.offset = reader.stream_position().unwrap_or(file_len);
    Ok(())
}

fn get_opencode_monitor_status_internal() -> OpenCodeMonitorStatusView {
    let auth_ready = opencode_auth_file()
        .ok()
        .and_then(|path| read_openai_entry_from_opencode_auth_file(&path))
        .is_some();

    let mut log_ready = false;
    let mut log_recent = false;
    let mut last_log_age_ms: Option<i64> = None;
    let mut activity_source: Option<String> = None;
    let mut activity_candidates: Vec<(i64, &'static str)> = Vec::new();

    if let Some(path) = find_latest_opencode_log_file() {
        log_ready = true;
        if let Some(modified) = fs::metadata(&path).ok().and_then(|m| m.modified().ok()) {
            if let Ok(elapsed) = modified.elapsed() {
                let age_ms = elapsed.as_millis().min(i64::MAX as u128) as i64;
                last_log_age_ms = Some(age_ms);
                log_recent = age_ms <= OPENCODE_LOG_RECENT_WINDOW_MS;
                activity_candidates.push((age_ms, "log"));
            }
        }
    }

    if let Ok(base) = opencode_data_dir() {
        for (name, source) in [("opencode.db-wal", "db-wal"), ("opencode.db", "db")] {
            let path = base.join(name);
            if !path.exists() {
                continue;
            }
            if let Some(modified) = fs::metadata(&path).ok().and_then(|m| m.modified().ok()) {
                if let Ok(elapsed) = modified.elapsed() {
                    let age_ms = elapsed.as_millis().min(i64::MAX as u128) as i64;
                    activity_candidates.push((age_ms, source));
                }
            }
        }
    }

    activity_candidates.sort_by_key(|(age, _)| *age);
    let last_activity_age_ms = activity_candidates.first().map(|(age, _)| *age);
    if let Some((_, source)) = activity_candidates.first() {
        activity_source = Some((*source).to_string());
    }
    let activity_recent = last_activity_age_ms
        .map(|age| age <= OPENCODE_LOG_RECENT_WINDOW_MS)
        .unwrap_or(false);

    OpenCodeMonitorStatusView {
        auth_ready,
        log_ready,
        log_recent,
        last_log_age_ms,
        activity_recent,
        last_activity_age_ms,
        activity_source,
    }
}

fn push_unique_dir_entry(entries: &mut Vec<PathBuf>, seen: &mut HashSet<String>, path: PathBuf) {
    let key = path.to_string_lossy().to_lowercase();
    if key.is_empty() || seen.contains(&key) {
        return;
    }
    seen.insert(key);
    entries.push(path);
}

fn candidate_vscode_user_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            let base = PathBuf::from(appdata);
            for product in ["Code", "Code - Insiders", "Cursor", "Windsurf"] {
                let root = base.join(product).join("User");
                if root.exists() {
                    push_unique_dir_entry(&mut roots, &mut seen, root);
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            for rel in [
                ".config/Code/User",
                ".config/Code - Insiders/User",
                ".config/Cursor/User",
                ".config/Windsurf/User",
            ] {
                let root = home.join(rel);
                if root.exists() {
                    push_unique_dir_entry(&mut roots, &mut seen, root);
                }
            }
        }
    }
    roots
}

fn collect_workspace_state_db_files(user_root: &Path) -> Vec<PathBuf> {
    let workspace_root = user_root.join("workspaceStorage");
    let mut dbs: Vec<PathBuf> = Vec::new();
    let Ok(entries) = fs::read_dir(workspace_root) else {
        return dbs;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let db = path.join("state.vscdb");
        if db.exists() {
            dbs.push(db);
        }
    }
    dbs
}

fn run_sqlite3_internal(db_path: &Path, sql: &str, json_mode: bool) -> CmdResult<String> {
    if !db_path.exists() {
        return Err(format!("数据库不存在: {}", db_path.display()));
    }
    let mut cmd = command_no_window("sqlite3");
    if json_mode {
        cmd.arg("-json");
    }
    let mut child = cmd
        .arg(db_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("执行 sqlite3 失败 ({}): {err}", db_path.display()))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(sql.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|err| format!("写入 sqlite3 输入失败 ({}): {err}", db_path.display()))?;
    } else {
        return Err(format!(
            "执行 sqlite3 失败 ({}): 无法获取 stdin",
            db_path.display()
        ));
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("等待 sqlite3 结果失败 ({}): {err}", db_path.display()))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
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
    Err(format!(
        "sqlite3 执行失败 ({}): {detail}",
        db_path.display()
    ))
}

fn sqlite_count_internal(db_path: &Path, sql: &str) -> CmdResult<i64> {
    let output = run_sqlite3_internal(db_path, sql, false)?;
    let line = output.lines().next().unwrap_or("0").trim();
    line.parse::<i64>()
        .map_err(|err| format!("解析 sqlite 计数失败 ({}): {err}", db_path.display()))
}

fn load_global_openai_state_json_internal(db_path: &Path) -> CmdResult<Option<Value>> {
    let output = run_sqlite3_internal(
        db_path,
        "SELECT value FROM ItemTable WHERE key='openai.chatgpt' LIMIT 1;",
        true,
    )?;
    if output.trim().is_empty() {
        return Ok(None);
    }
    let rows: Value = serde_json::from_str(&output)
        .map_err(|err| format!("解析 sqlite JSON 结果失败 ({}): {err}", db_path.display()))?;
    let raw = rows
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("value"))
        .and_then(Value::as_str);
    let Some(raw) = raw else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(raw).map_err(|err| {
        format!(
            "解析 openai.chatgpt JSON 失败 ({}): {err}",
            db_path.display()
        )
    })?;
    Ok(Some(parsed))
}

fn save_global_openai_state_json_internal(db_path: &Path, state: &Value) -> CmdResult<()> {
    let serialized = serde_json::to_string(state)
        .map_err(|err| format!("序列化 openai.chatgpt JSON 失败: {err}"))?;
    let escaped = serialized.replace('\'', "''");
    let sql = format!(
        "PRAGMA busy_timeout=1500; UPDATE ItemTable SET value='{escaped}' WHERE key='openai.chatgpt';"
    );
    run_sqlite3_internal(db_path, &sql, false).map(|_| ())
}

fn sanitize_global_openai_state_json_internal(state: &mut Value) -> bool {
    let Some(root) = state.as_object_mut() else {
        return false;
    };
    let mut changed = false;

    let empty_titles = json!({
        "titles": {},
        "order": [],
    });
    if root.get("thread-titles") != Some(&empty_titles) {
        root.insert("thread-titles".to_string(), empty_titles);
        changed = true;
    }

    let sandbox_off = Value::Bool(false);
    if root.get(OPENAI_STATE_WINDOWS_SANDBOX_KEY) != Some(&sandbox_off) {
        root.insert(OPENAI_STATE_WINDOWS_SANDBOX_KEY.to_string(), sandbox_off);
        changed = true;
    }

    changed
}

fn purge_global_openai_thread_indexes_internal(db_path: &Path) -> CmdResult<bool> {
    let Some(mut state) = load_global_openai_state_json_internal(db_path)? else {
        return Ok(false);
    };
    if !sanitize_global_openai_state_json_internal(&mut state) {
        return Ok(false);
    }
    save_global_openai_state_json_internal(db_path, &state)?;
    Ok(true)
}

fn purge_workspace_agent_sessions_cache_internal(db_path: &Path) -> CmdResult<bool> {
    let hit_count = sqlite_count_internal(
        db_path,
        "SELECT count(*) FROM ItemTable WHERE key='agentSessions.model.cache' AND value LIKE '%openai-codex://route/local/%';",
    )?;
    if hit_count <= 0 {
        return Ok(false);
    }
    run_sqlite3_internal(
        db_path,
        "PRAGMA busy_timeout=1500; DELETE FROM ItemTable WHERE key IN ('agentSessions.model.cache','agentSessions.state.cache');",
        false,
    )?;
    Ok(true)
}

fn purge_stale_codex_session_indexes_internal() -> CmdResult<String> {
    let roots = candidate_vscode_user_roots();
    if roots.is_empty() {
        return Err("未找到编辑器 User 目录，无法执行会话索引清理。".to_string());
    }

    let mut global_scanned = 0usize;
    let mut global_cleaned = 0usize;
    let mut workspace_scanned = 0usize;
    let mut workspace_cleaned = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for root in roots {
        let global_db = root.join("globalStorage").join("state.vscdb");
        if global_db.exists() {
            global_scanned = global_scanned.saturating_add(1);
            match purge_global_openai_thread_indexes_internal(&global_db) {
                Ok(changed) => {
                    if changed {
                        global_cleaned = global_cleaned.saturating_add(1);
                    }
                }
                Err(err) => {
                    if errors.len() < AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES {
                        errors.push(err);
                    }
                }
            }
        }

        for db in collect_workspace_state_db_files(&root) {
            workspace_scanned = workspace_scanned.saturating_add(1);
            match purge_workspace_agent_sessions_cache_internal(&db) {
                Ok(changed) => {
                    if changed {
                        workspace_cleaned = workspace_cleaned.saturating_add(1);
                    }
                }
                Err(err) => {
                    if errors.len() < AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES {
                        errors.push(err);
                    }
                }
            }
        }
    }

    let mut summary = if global_cleaned == 0 && workspace_cleaned == 0 {
        format!(
            "未发现需要清理的陈旧索引（全局库 {global_scanned} 个，工作区库 {workspace_scanned} 个）。"
        )
    } else {
        format!(
            "已清理 Codex 会话索引：全局库 {global_cleaned}/{global_scanned}，工作区库 {workspace_cleaned}/{workspace_scanned}。"
        )
    };

    if !errors.is_empty() {
        summary.push_str(&format!(" 部分数据库处理失败: {}", errors.join(" | ")));
    }

    if global_scanned == 0 && workspace_scanned == 0 {
        return Err("未找到可处理的 state.vscdb 文件。".to_string());
    }
    if global_cleaned == 0 && workspace_cleaned == 0 && !errors.is_empty() {
        return Err(summary);
    }
    Ok(summary)
}

fn enforce_windows_sandbox_disabled_internal() -> CmdResult<String> {
    let roots = candidate_vscode_user_roots();
    if roots.is_empty() {
        return Err("未找到编辑器 User 目录，无法校验 Windows 沙箱设置。".to_string());
    }

    let mut scanned = 0usize;
    let mut updated = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for root in roots {
        let global_db = root.join("globalStorage").join("state.vscdb");
        if !global_db.exists() {
            continue;
        }
        scanned = scanned.saturating_add(1);
        match load_global_openai_state_json_internal(&global_db) {
            Ok(Some(mut state)) => {
                let changed = if let Some(obj) = state.as_object_mut() {
                    if obj.get(OPENAI_STATE_WINDOWS_SANDBOX_KEY) != Some(&Value::Bool(false)) {
                        obj.insert(
                            OPENAI_STATE_WINDOWS_SANDBOX_KEY.to_string(),
                            Value::Bool(false),
                        );
                        true
                    } else {
                        false
                    }
                } else {
                    false
                };
                if changed {
                    match save_global_openai_state_json_internal(&global_db, &state) {
                        Ok(()) => {
                            updated = updated.saturating_add(1);
                        }
                        Err(err) => {
                            if errors.len() < AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES {
                                errors.push(err);
                            }
                        }
                    }
                }
            }
            Ok(None) => {}
            Err(err) => {
                if errors.len() < AUTO_SWITCH_STATE_PURGE_MAX_ERROR_NOTES {
                    errors.push(err);
                }
            }
        }
    }

    if scanned == 0 {
        return Err("未找到可处理的全局 state.vscdb。".to_string());
    }

    let mut summary = if updated == 0 {
        format!("Windows 沙箱已是关闭状态（{scanned} 个全局库）。")
    } else {
        format!("已关闭 Windows 沙箱实验开关（{updated}/{scanned} 个全局库）。")
    };
    if !errors.is_empty() {
        summary.push_str(&format!(" 部分数据库处理失败: {}", errors.join(" | ")));
    }
    if updated == 0 && !errors.is_empty() {
        return Err(summary);
    }
    Ok(summary)
}

fn candidate_vscode_log_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = env::var("APPDATA") {
            let base = PathBuf::from(appdata);
            for product in ["Code", "Code - Insiders", "Cursor", "Windsurf"] {
                let path = base.join(product).join("logs");
                if path.exists() {
                    roots.push(path);
                }
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = dirs::home_dir() {
            for rel in [
                ".config/Code/logs",
                ".config/Code - Insiders/logs",
                ".config/Cursor/logs",
                ".config/Windsurf/logs",
            ] {
                let path = home.join(rel);
                if path.exists() {
                    roots.push(path);
                }
            }
        }
    }
    roots
}

fn collect_codex_extension_log_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_codex_extension_log_files(&path, out);
            continue;
        }
        let Some(name) = path.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        if name != "Codex.log" {
            continue;
        }
        let text = path.to_string_lossy();
        if text.contains("openai.chatgpt") {
            out.push(path);
        }
    }
}

fn find_latest_codex_extension_log_file() -> Option<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    for root in candidate_vscode_log_roots() {
        collect_codex_extension_log_files(&root, &mut files);
    }
    let mut latest: Option<(SystemTime, PathBuf)> = None;
    for file in files {
        let modified = fs::metadata(&file)
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        match &latest {
            Some((ts, _)) if modified < *ts => {}
            _ => latest = Some((modified, file)),
        }
    }
    latest.map(|(_, path)| path)
}

fn editor_kind_from_codex_log_path(path: &Path) -> Option<&'static str> {
    let text = path.to_string_lossy().to_lowercase();
    if text.contains("\\windsurf\\logs\\") || text.contains("/windsurf/logs/") {
        return Some("windsurf");
    }
    if text.contains("\\cursor\\logs\\") || text.contains("/cursor/logs/") {
        return Some("cursor");
    }
    if text.contains("\\code - insiders\\logs\\")
        || text.contains("\\code\\logs\\")
        || text.contains("/code - insiders/logs/")
        || text.contains("/code/logs/")
    {
        return Some("vscode");
    }
    None
}

fn reset_codex_log_tail_state(state: &mut CodexLogTailState, path: PathBuf) {
    let offset = fs::metadata(&path).ok().map(|m| m.len()).unwrap_or(0);
    state.current_file = Some(path);
    state.offset = offset;
}

fn codex_log_line_has_thread_not_found(line: &str) -> bool {
    let lowered = line.to_lowercase();
    if !lowered.contains("thread not found") {
        return false;
    }
    lowered.contains("method=turn/start")
        || lowered.contains("[composer] submit failed")
        || lowered.contains("submit failed")
}

fn codex_log_line_has_rollout_missing(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("no rollout found for thread id")
        || lowered.contains("no rollout found for conversation id")
        || lowered.contains("failed to resume conversation")
        || lowered.contains("failed to resume task")
        || lowered.contains("no-client-found")
}

fn codex_log_line_has_runtime_unavailable(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("codex process is not available")
        || lowered.contains("codex app-server process exited unexpectedly")
        || lowered.contains("process exited unexpectedly")
}

fn codex_log_line_has_turn_metadata_timeout(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("turn_metadata: timed out after 250ms")
        || lowered.contains("timed out after 250ms while building turn metadata header")
}

fn codex_log_line_has_runtime_restart(line: &str) -> bool {
    let lowered = line.to_lowercase();
    lowered.contains("spawning codex app-server") || lowered.contains("initialize received (id={})")
}

fn process_codex_log_line(line: &str, runtime: &mut AutoSwitchRuntime) {
    if codex_log_line_has_thread_not_found(line) {
        runtime.codex_log.thread_not_found_seq =
            runtime.codex_log.thread_not_found_seq.saturating_add(1);
    }
    if codex_log_line_has_rollout_missing(line) {
        runtime.codex_log.rollout_missing_seq =
            runtime.codex_log.rollout_missing_seq.saturating_add(1);
    }
    if codex_log_line_has_runtime_unavailable(line) {
        runtime.codex_log.runtime_unavailable_seq =
            runtime.codex_log.runtime_unavailable_seq.saturating_add(1);
    }
    if codex_log_line_has_turn_metadata_timeout(line) {
        runtime.codex_log.turn_metadata_timeout_seq = runtime
            .codex_log
            .turn_metadata_timeout_seq
            .saturating_add(1);
    }
    if codex_log_line_has_runtime_restart(line) {
        runtime.codex_log.runtime_restart_seq =
            runtime.codex_log.runtime_restart_seq.saturating_add(1);
    }
}

fn sync_codex_log_tail(runtime: &mut AutoSwitchRuntime) -> CmdResult<()> {
    let now_ms = now_ts_ms();
    let should_scan = runtime.codex_log.current_file.is_none()
        || now_ms - runtime.codex_log.last_scan_at_ms >= AUTO_SWITCH_CODEX_LOG_SCAN_INTERVAL_MS;
    if should_scan {
        if let Some(latest_file) = find_latest_codex_extension_log_file() {
            let changed = runtime
                .codex_log
                .current_file
                .as_ref()
                .map(|p| p != &latest_file)
                .unwrap_or(true);
            if changed {
                reset_codex_log_tail_state(&mut runtime.codex_log, latest_file);
                runtime.last_observed_thread_not_found_seq = runtime.codex_log.thread_not_found_seq;
                runtime.last_observed_rollout_missing_seq = runtime.codex_log.rollout_missing_seq;
                runtime.last_observed_runtime_unavailable_seq =
                    runtime.codex_log.runtime_unavailable_seq;
                runtime.last_observed_turn_metadata_timeout_seq =
                    runtime.codex_log.turn_metadata_timeout_seq;
            }
        }
        runtime.codex_log.last_scan_at_ms = now_ms;
    }

    let Some(path) = runtime.codex_log.current_file.clone() else {
        return Ok(());
    };
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Ok(()),
    };
    let file_len = file.metadata().ok().map(|m| m.len()).unwrap_or(0);
    if runtime.codex_log.offset > file_len {
        runtime.codex_log.offset = file_len;
    }
    if file
        .seek(SeekFrom::Start(runtime.codex_log.offset))
        .is_err()
    {
        return Ok(());
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取 Codex 扩展日志失败: {e}"))?;
        if bytes == 0 {
            break;
        }
        let clean = line.trim_end_matches(&['\r', '\n'][..]);
        process_codex_log_line(clean, runtime);
    }
    runtime.codex_log.offset = reader.stream_position().unwrap_or(file_len);
    Ok(())
}

fn auto_switch_signature(runtime: &AutoSwitchRuntime) -> AutoSwitchSignature {
    AutoSwitchSignature {
        event_seq: runtime.session.event_seq,
        user_seq: runtime.session.user_seq,
        open_turn_count: runtime.session.open_turns.len(),
    }
}

fn active_profile_quota_from_store(
    store: &StoreData,
    active_profile_name: Option<&str>,
) -> (Option<i64>, Option<i64>) {
    let Some(active_name) = active_profile_name else {
        return (None, None);
    };
    let Some(record) = store.profiles.get(active_name).and_then(Value::as_object) else {
        return (None, None);
    };
    let (five, _, week, _) = quota_fields_from_record(record);
    (five, week)
}

fn session_quota_is_fresh_for_trigger(runtime: &AutoSwitchRuntime, now_ms: i64) -> bool {
    let Some(updated_at) = runtime.session.quota.updated_at_ms else {
        return false;
    };
    if runtime.last_switch_applied_at_ms > 0 && updated_at < runtime.last_switch_applied_at_ms {
        return false;
    }
    now_ms - updated_at <= AUTO_SWITCH_SESSION_QUOTA_MAX_AGE_MS
}

fn current_quota_for_trigger(
    runtime: &AutoSwitchRuntime,
    store: &StoreData,
    now_ms: i64,
    active_profile_name: Option<&str>,
) -> (Option<i64>, Option<i64>) {
    let session_five = runtime.session.quota.five_hour_remaining_percent;
    let session_week = runtime.session.quota.one_week_remaining_percent;
    let (store_five, store_week) = active_profile_quota_from_store(store, active_profile_name);
    if session_quota_is_fresh_for_trigger(runtime, now_ms) {
        (session_five.or(store_five), session_week.or(store_week))
    } else {
        (store_five.or(session_five), store_week.or(session_week))
    }
}

fn soft_trigger_hit(five_hour: Option<i64>, one_week: Option<i64>) -> bool {
    five_hour
        .map(|v| v <= SOFT_TRIGGER_FIVE_HOUR_THRESHOLD)
        .unwrap_or(false)
        || one_week
            .map(|v| v <= SOFT_TRIGGER_ONE_WEEK_THRESHOLD)
            .unwrap_or(false)
}

fn candidate_quota_ok(five_hour: Option<i64>, one_week: Option<i64>) -> bool {
    five_hour
        .map(|v| v > CANDIDATE_MIN_FIVE_HOUR)
        .unwrap_or(false)
        && one_week
            .map(|v| v > CANDIDATE_MIN_ONE_WEEK)
            .unwrap_or(false)
}

fn sync_session_tail_for_mode(
    runtime: &mut AutoSwitchRuntime,
    mode: AutoSwitchMode,
) -> CmdResult<()> {
    match mode {
        AutoSwitchMode::Gpt => sync_session_tail(runtime),
        AutoSwitchMode::OpenCode => sync_opencode_log_tail(runtime),
    }
}

fn run_switch_guard(
    runtime: &mut AutoSwitchRuntime,
    mode: AutoSwitchMode,
) -> CmdResult<Option<AutoSwitchSignature>> {
    let first = auto_switch_signature(runtime);
    if first.open_turn_count > 0 {
        return Ok(None);
    }
    thread::sleep(Duration::from_millis(AUTO_SWITCH_GUARD_WAIT_MS));
    sync_session_tail_for_mode(runtime, mode)?;
    let second = auto_switch_signature(runtime);
    if second != first || second.open_turn_count > 0 {
        return Ok(None);
    }
    thread::sleep(Duration::from_millis(AUTO_SWITCH_GUARD_WAIT_MS));
    sync_session_tail_for_mode(runtime, mode)?;
    let third = auto_switch_signature(runtime);
    if third != second || third.open_turn_count > 0 {
        return Ok(None);
    }
    Ok(Some(third))
}

fn fill_pending_reason(result: &mut AutoSwitchTickResult, runtime: &AutoSwitchRuntime) {
    result.pending_reason = runtime.pending_reason.map(|r| r.as_str().to_string());
}

fn record_stale_recover_hit(
    runtime: &mut AutoSwitchRuntime,
    reason: StaleRecoverReason,
    now_ms: i64,
) -> u32 {
    let same_reason = runtime.last_stale_recover_reason == Some(reason);
    let within_window = runtime.last_stale_recover_at_ms > 0
        && now_ms - runtime.last_stale_recover_at_ms <= AUTO_SWITCH_STALE_RECOVER_WINDOW_MS;
    if same_reason && within_window {
        runtime.stale_recover_repeat_count = runtime.stale_recover_repeat_count.saturating_add(1);
    } else {
        runtime.stale_recover_repeat_count = 1;
    }
    runtime.last_stale_recover_reason = Some(reason);
    runtime.last_stale_recover_at_ms = now_ms;
    runtime.stale_recover_repeat_count
}

fn mark_state_purge_escalated(runtime: &mut AutoSwitchRuntime, now_ms: i64) {
    runtime.state_index_purge_cooldown_until_ms =
        now_ms + AUTO_SWITCH_STATE_INDEX_PURGE_COOLDOWN_MS;
    runtime.last_stale_recover_reason = None;
    runtime.last_stale_recover_at_ms = now_ms;
    runtime.stale_recover_repeat_count = 0;
}

fn recover_runtime_without_new_chat_internal(
    reason: &str,
    allow_extension_host_fallback: bool,
    request_new_chat_reset: bool,
) -> AutoSwitchTickResult {
    let prefer_restart_signal = has_codex_hook_signal_watch_installed_internal();
    let mut notes: Vec<String> = Vec::new();
    let mut recovered = false;

    match enforce_windows_sandbox_disabled_internal() {
        Ok(msg) => notes.push(msg),
        Err(err) => notes.push(format!("Windows 沙箱设置校验失败：{err}")),
    }

    if prefer_restart_signal || has_codex_hook_watch_installed_internal() {
        match trigger_codex_hook_restart_internal(prefer_restart_signal) {
            Ok(msg) => {
                recovered = true;
                notes.push(msg);
            }
            Err(err) => notes.push(format!("运行时重连失败：{err}")),
        }
    } else {
        notes.push("未检测到 Hook 提速监听。".to_string());
    }

    if !recovered && allow_extension_host_fallback {
        match restart_extension_host_internal() {
            Ok(msg) => {
                recovered = true;
                notes.push(format!("已自动降级为方案1。{msg}"));
            }
            Err(err) => notes.push(format!("方案1兜底失败：{err}")),
        }
    } else if !recovered {
        notes.push("为避免打断当前界面，未自动执行方案1兜底。".to_string());
    }

    if request_new_chat_reset {
        if recovered {
            match invoke_vscode_command_uri_internal(
                "chatgpt.newChat",
                "已请求在当前窗口重置为新会话。",
            ) {
                Ok(msg) => notes.push(msg),
                Err(uri_err) => {
                    notes.push(format!("命令重置失败，尝试 Hook 信号。{uri_err}"));
                    match trigger_chatgpt_new_chat_reset_internal(true, false) {
                        Ok(msg) => notes.push(msg),
                        Err(err) => notes.push(format!("同窗口新会话重置未成功：{err}")),
                    }
                }
            }
        } else {
            notes.push("运行时尚未恢复，跳过同窗口新会话重置。".to_string());
        }
    }

    let detail = notes.join(" ");
    let mut result = AutoSwitchTickResult::new("thread_recovering");
    if recovered {
        let mode_text = if request_new_chat_reset {
            "并请求同窗口重置到新会话"
        } else {
            "（不自动新建对话）"
        };
        result.action = "thread_recovered".to_string();
        result.message = Some(format!(
            "检测到{reason}，已自动重连 Codex 运行时{mode_text}。{detail}"
        ));
    } else {
        result.action = "thread_recover_failed".to_string();
        result.message = Some(format!("检测到{reason}，自动重连失败。{detail}"));
    }
    result
}

fn recover_runtime_with_state_purge_internal(
    runtime: &mut AutoSwitchRuntime,
    reason: StaleRecoverReason,
    request_new_chat_reset: bool,
) -> AutoSwitchTickResult {
    let now_ms = now_ts_ms();
    let purge_note = match purge_stale_codex_session_indexes_internal() {
        Ok(msg) => format!("已执行会话索引清理。{msg}"),
        Err(err) => format!("会话索引清理失败：{err}"),
    };
    mark_state_purge_escalated(runtime, now_ms);

    let mut result =
        recover_runtime_without_new_chat_internal(reason.message(), false, request_new_chat_reset);
    if let Some(text) = result.message.as_mut() {
        text.push(' ');
        text.push_str(&purge_note);
    } else {
        result.message = Some(purge_note);
    }
    result
}

fn maybe_recover_stale_thread_from_log(
    runtime: &mut AutoSwitchRuntime,
) -> CmdResult<Option<AutoSwitchTickResult>> {
    sync_codex_log_tail(runtime)?;
    let now_ms = now_ts_ms();
    let reason = if runtime.codex_log.rollout_missing_seq
        > runtime.last_observed_rollout_missing_seq
    {
        runtime.last_observed_rollout_missing_seq = runtime.codex_log.rollout_missing_seq;
        Some(StaleRecoverReason::RolloutMissing)
    } else if runtime.codex_log.thread_not_found_seq > runtime.last_observed_thread_not_found_seq {
        runtime.last_observed_thread_not_found_seq = runtime.codex_log.thread_not_found_seq;
        Some(StaleRecoverReason::ThreadNotFound)
    } else if runtime.codex_log.runtime_unavailable_seq
        > runtime.last_observed_runtime_unavailable_seq
    {
        runtime.last_observed_runtime_unavailable_seq = runtime.codex_log.runtime_unavailable_seq;
        Some(StaleRecoverReason::RuntimeUnavailable)
    } else if runtime.codex_log.turn_metadata_timeout_seq
        > runtime.last_observed_turn_metadata_timeout_seq
    {
        runtime.last_observed_turn_metadata_timeout_seq =
            runtime.codex_log.turn_metadata_timeout_seq;
        Some(StaleRecoverReason::TurnMetadataTimeout)
    } else {
        None
    };
    let Some(reason) = reason else {
        return Ok(None);
    };

    if reason == StaleRecoverReason::TurnMetadataTimeout {
        // This warning is noisy and frequently self-heals; auto-restarting here
        // caused aggressive restart loops.
        return Ok(None);
    }

    if reason == StaleRecoverReason::RuntimeUnavailable
        && runtime.last_runtime_unavailable_recover_restart_seq
            == Some(runtime.codex_log.runtime_restart_seq)
    {
        // Only attempt one automatic recovery for the same runtime generation.
        return Ok(None);
    }

    let has_new_user_message = runtime.session.user_seq > runtime.last_thread_recover_user_seq;
    let _ = record_stale_recover_hit(runtime, reason, now_ms);

    // Stop background restart loops: only recover after a fresh user message.
    if !has_new_user_message {
        return Ok(None);
    }

    if now_ms < runtime.thread_recover_cooldown_until_ms {
        return Ok(None);
    }

    let mut request_new_chat_reset = matches!(
        reason,
        StaleRecoverReason::RolloutMissing | StaleRecoverReason::ThreadNotFound
    );
    if request_new_chat_reset {
        if !has_codex_hook_newchat_watch_installed_internal() {
            request_new_chat_reset = false;
        } else {
            let in_cooldown = runtime.last_new_chat_reset_at_ms > 0
                && now_ms - runtime.last_new_chat_reset_at_ms
                    < AUTO_SWITCH_NEW_CHAT_RESET_COOLDOWN_MS;
            let same_user_seq = runtime.last_new_chat_reset_user_seq == runtime.session.user_seq;
            if in_cooldown || same_user_seq {
                request_new_chat_reset = false;
            }
        }
    }

    if reason == StaleRecoverReason::RuntimeUnavailable {
        runtime.last_runtime_unavailable_recover_restart_seq =
            Some(runtime.codex_log.runtime_restart_seq);
    }
    if request_new_chat_reset {
        runtime.last_new_chat_reset_at_ms = now_ms;
        runtime.last_new_chat_reset_user_seq = runtime.session.user_seq;
    }
    runtime.last_thread_recover_user_seq = runtime.session.user_seq;
    runtime.thread_recover_cooldown_until_ms = now_ms
        + if matches!(
            reason,
            StaleRecoverReason::RolloutMissing
                | StaleRecoverReason::ThreadNotFound
                | StaleRecoverReason::RuntimeUnavailable
        ) {
            AUTO_SWITCH_THREAD_RECOVER_HARD_COOLDOWN_MS
        } else {
            AUTO_SWITCH_THREAD_RECOVER_COOLDOWN_MS
        };

    Ok(Some(recover_runtime_without_new_chat_internal(
        reason.message(),
        false,
        request_new_chat_reset,
    )))
}

fn maybe_recover_stale_thread_from_opencode_log(
    runtime: &mut AutoSwitchRuntime,
) -> CmdResult<Option<AutoSwitchTickResult>> {
    sync_opencode_log_tail(runtime)?;
    if runtime.opencode_log.session_error_seq <= runtime.last_observed_opencode_session_error_seq {
        return Ok(None);
    }
    runtime.last_observed_opencode_session_error_seq = runtime.opencode_log.session_error_seq;

    let has_new_user_message = runtime.session.user_seq > runtime.last_thread_recover_user_seq;
    if !has_new_user_message {
        return Ok(None);
    }

    let now_ms = now_ts_ms();
    if now_ms < runtime.thread_recover_cooldown_until_ms {
        return Ok(None);
    }
    runtime.last_thread_recover_user_seq = runtime.session.user_seq;
    runtime.thread_recover_cooldown_until_ms = now_ms + AUTO_SWITCH_THREAD_RECOVER_COOLDOWN_MS;

    let detail = runtime
        .session
        .last_hard_trigger_reason
        .clone()
        .unwrap_or_else(|| "session.error".to_string());
    let mut result = AutoSwitchTickResult::new("thread_recover_failed");
    result.message = Some(format!(
        "检测到 OpenCode 会话异常（{detail}）。当前仅做检测提示，暂未自动重连运行时。"
    ));
    Ok(Some(result))
}

fn auto_switch_tick_internal(
    runtime: &mut AutoSwitchRuntime,
    mode: Option<&str>,
) -> CmdResult<AutoSwitchTickResult> {
    let mode = parse_auto_switch_mode(mode);
    ensure_auto_switch_mode(runtime, mode);
    sync_session_tail_for_mode(runtime, mode)?;
    let mut now_ms = now_ts_ms();

    if runtime.session.hard_trigger_seq > runtime.last_observed_hard_trigger_seq {
        runtime.last_observed_hard_trigger_seq = runtime.session.hard_trigger_seq;
        runtime.pending_reason = Some(TriggerReason::Hard);
    }

    let store_for_trigger = load_store()?;
    let active_profile_name = match mode {
        AutoSwitchMode::Gpt => store_for_trigger.active_profile.clone(),
        AutoSwitchMode::OpenCode => {
            let live_workspace_id = live_opencode_workspace_id_internal();
            find_profile_name_by_identity_prefer_existing(
                &store_for_trigger,
                live_workspace_id.as_deref(),
                None,
            )
        }
    };
    let (current_five, current_week) = current_quota_for_trigger(
        runtime,
        &store_for_trigger,
        now_ms,
        active_profile_name.as_deref(),
    );
    let soft_hit = soft_trigger_hit(current_five, current_week);
    match runtime.pending_reason {
        Some(TriggerReason::Hard) => {}
        Some(TriggerReason::Soft) if !soft_hit => runtime.pending_reason = None,
        None if soft_hit => runtime.pending_reason = Some(TriggerReason::Soft),
        _ => {}
    }

    if runtime.pending_reason.is_none() {
        return Ok(AutoSwitchTickResult::new("idle"));
    }

    if now_ms < runtime.switch_cooldown_until_ms {
        let mut result = AutoSwitchTickResult::new("cooldown");
        result.message = Some("无感换号冷却中。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }
    if now_ms < runtime.no_candidate_until_ms {
        let mut result = AutoSwitchTickResult::new("no_candidate_cooldown");
        result.message = Some("暂未找到可切换账号，等待下次探测。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }

    if !runtime.session.open_turns.is_empty() {
        let mut result = AutoSwitchTickResult::new("wait_turn_end");
        result.message = Some("检测到当前对话仍在进行，等待结束后切号。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }

    let Some(stable_sig) = run_switch_guard(runtime, mode)? else {
        now_ms = now_ts_ms();
        runtime.switch_cooldown_until_ms = now_ms + AUTO_SWITCH_SWITCH_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("guard_cancelled");
        result.message = Some("检测到新消息或新回合，已取消本次无感换号。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    };

    let mut store = load_store()?;
    let names = list_profile_names(&store);
    let active = match mode {
        AutoSwitchMode::Gpt => store.active_profile.clone(),
        AutoSwitchMode::OpenCode => {
            let live_workspace_id = live_opencode_workspace_id_internal();
            find_profile_name_by_identity_prefer_existing(
                &store,
                live_workspace_id.as_deref(),
                None,
            )
        }
    };
    let mut picked: Option<String> = None;
    let mut checked = 0usize;
    for name in names {
        if active.as_deref() == Some(name.as_str()) {
            continue;
        }
        checked += 1;
        let _ = refresh_one_profile_quota(&mut store, &name, false);
        let Some(record) = store.profiles.get(&name).and_then(Value::as_object) else {
            continue;
        };
        let Ok(snapshot_dir) = record_snapshot_dir(&name, record) else {
            continue;
        };
        let validity = profile_validity(record, &snapshot_dir);
        if validity != "正常" {
            continue;
        }
        let (five, _, week, _) = quota_fields_from_record(record);
        if candidate_quota_ok(five, week) {
            picked = Some(name);
            break;
        }
    }
    save_store(&store)?;

    let Some(target_profile) = picked else {
        now_ms = now_ts_ms();
        runtime.no_candidate_until_ms = now_ms + AUTO_SWITCH_NO_CANDIDATE_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("no_candidate");
        result.message = Some(format!("已探测 {checked} 个账号，暂无满足条件的候选账号。"));
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    };

    sync_session_tail_for_mode(runtime, mode)?;
    let latest_sig = auto_switch_signature(runtime);
    if latest_sig != stable_sig || latest_sig.open_turn_count > 0 {
        now_ms = now_ts_ms();
        runtime.switch_cooldown_until_ms = now_ms + AUTO_SWITCH_SWITCH_COOLDOWN_MS;
        let mut result = AutoSwitchTickResult::new("guard_cancelled");
        result.message = Some("切号前检测到会话状态变化，已取消本次切号。".to_string());
        fill_pending_reason(&mut result, runtime);
        return Ok(result);
    }

    let reason = runtime.pending_reason.unwrap_or(TriggerReason::Soft);
    let dashboard = match mode {
        AutoSwitchMode::Gpt => apply_profile_internal_for_mode(&target_profile, Some("gpt"))?,
        AutoSwitchMode::OpenCode => {
            apply_profile_internal_for_mode(&target_profile, Some("opencode"))?
        }
    };
    now_ms = now_ts_ms();
    runtime.last_switch_applied_at_ms = now_ms;
    runtime.session.quota = SessionQuotaSnapshot::default();
    runtime.pending_reason = None;
    runtime.switch_cooldown_until_ms = now_ms + AUTO_SWITCH_SWITCH_COOLDOWN_MS;
    runtime.no_candidate_until_ms = 0;

    let mut result = AutoSwitchTickResult::new("switched");
    result.message = Some(format!(
        "{}触发无感换号（{}模式），已切换到账号: {}",
        if reason == TriggerReason::Hard {
            "硬触发"
        } else {
            "低额度"
        },
        if matches!(mode, AutoSwitchMode::Gpt) {
            "GPT"
        } else {
            "OpenCode"
        },
        target_profile
    ));
    result.switched_to = Some(target_profile);
    result.pending_reason = Some(reason.as_str().to_string());
    result.dashboard = Some(dashboard);
    Ok(result)
}

fn thread_recover_tick_internal(
    runtime: &mut AutoSwitchRuntime,
    mode: Option<&str>,
) -> CmdResult<AutoSwitchTickResult> {
    let mode = parse_auto_switch_mode(mode);
    ensure_auto_switch_mode(runtime, mode);
    match mode {
        AutoSwitchMode::Gpt => {
            if let Some(result) = maybe_recover_stale_thread_from_log(runtime)? {
                return Ok(result);
            }
        }
        AutoSwitchMode::OpenCode => {
            if let Some(result) = maybe_recover_stale_thread_from_opencode_log(runtime)? {
                return Ok(result);
            }
        }
    }
    Ok(AutoSwitchTickResult::new("thread_monitor_idle"))
}

fn auto_switch_reset_internal(runtime: &mut AutoSwitchRuntime) -> String {
    *runtime = AutoSwitchRuntime::default();
    "无感换号状态已重置。".to_string()
}

fn fmt_reset(ts: Option<i64>) -> String {
    let Some(value) = ts else {
        return "-".to_string();
    };
    let Some(dt) = Local.timestamp_opt(value, 0).single() else {
        return "-".to_string();
    };
    dt.format("%m-%d %H:%M").to_string()
}

#[tauri::command]
async fn load_dashboard(sync_current: Option<bool>) -> CmdResult<DashboardData> {
    let sync_current = sync_current.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || load_dashboard_internal(sync_current))
        .await
        .map_err(|e| format!("加载看板任务执行失败: {e}"))?
}

#[tauri::command]
fn save_current_profile(profile_name: String) -> CmdResult<DashboardData> {
    save_current_profile_internal(&profile_name)
}

#[tauri::command]
async fn add_account_by_login(
    app: tauri::AppHandle,
    workspace_alias: Option<String>,
) -> CmdResult<DashboardData> {
    tauri::async_runtime::spawn_blocking(move || {
        add_account_by_login_internal(&app, workspace_alias)
    })
    .await
    .map_err(|e| format!("登录任务执行失败: {e}"))?
}

#[tauri::command]
fn apply_profile(name: String, mode: Option<String>) -> CmdResult<DashboardData> {
    apply_profile_internal_for_mode(&name, mode.as_deref())
}

#[tauri::command]
fn set_workspace_alias(name: String, alias: Option<String>) -> CmdResult<DashboardData> {
    set_workspace_alias_internal(&name, alias)
}

#[tauri::command]
fn set_profile_support(name: String, gpt: bool, opencode: bool) -> CmdResult<DashboardData> {
    set_profile_support_internal(&name, gpt, opencode)
}

#[tauri::command]
async fn refresh_profile_quota(
    name: String,
    refresh_token: Option<bool>,
) -> CmdResult<DashboardData> {
    let refresh_token = refresh_token.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        refresh_profile_quota_internal(&name, refresh_token)
    })
    .await
    .map_err(|e| format!("刷新账号额度任务执行失败: {e}"))?
}

#[tauri::command]
async fn refresh_all_quota(refresh_token: Option<bool>) -> CmdResult<DashboardData> {
    let refresh_token = refresh_token.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || refresh_all_quota_internal(refresh_token))
        .await
        .map_err(|e| format!("刷新全部额度任务执行失败: {e}"))?
}

#[tauri::command]
async fn keepalive_all() -> CmdResult<DashboardData> {
    tauri::async_runtime::spawn_blocking(keepalive_all_internal)
        .await
        .map_err(|e| format!("保活任务执行失败: {e}"))?
}

#[tauri::command]
fn auto_switch_tick(
    auto_runtime: State<'_, AutoSwitchRuntimeState>,
    mode: Option<String>,
) -> CmdResult<AutoSwitchTickResult> {
    let mut runtime = auto_runtime
        .inner
        .lock()
        .map_err(|_| "无感换号状态锁定失败。".to_string())?;
    auto_switch_tick_internal(&mut runtime, mode.as_deref())
}

#[tauri::command]
fn thread_recover_tick(
    auto_runtime: State<'_, AutoSwitchRuntimeState>,
    mode: Option<String>,
) -> CmdResult<AutoSwitchTickResult> {
    let mut runtime = auto_runtime
        .inner
        .lock()
        .map_err(|_| "无感换号状态锁定失败。".to_string())?;
    thread_recover_tick_internal(&mut runtime, mode.as_deref())
}

#[tauri::command]
fn auto_switch_reset(auto_runtime: State<'_, AutoSwitchRuntimeState>) -> CmdResult<String> {
    let mut runtime = auto_runtime
        .inner
        .lock()
        .map_err(|_| "无感换号状态锁定失败。".to_string())?;
    Ok(auto_switch_reset_internal(&mut runtime))
}

#[tauri::command]
fn delete_profile(name: String) -> CmdResult<DashboardData> {
    delete_profile_internal(&name)
}

#[tauri::command]
fn reorder_profiles(names: Vec<String>) -> CmdResult<DashboardData> {
    reorder_profiles_internal(names)
}

#[tauri::command]
async fn reload_vscode_window(app: tauri::AppHandle) -> CmdResult<String> {
    let mut fallback_notes: Vec<String> = Vec::new();

    if has_codex_hook_installed_internal() {
        let prefer_signal = has_codex_hook_signal_watch_installed_internal();
        let hook_result = tauri::async_runtime::spawn_blocking(move || {
            trigger_codex_hook_restart_internal(prefer_signal)
        })
        .await
        .map_err(|e| format!("Hook 刷新任务执行失败: {e}"))?;
        match hook_result {
            Ok(msg) => return Ok(format!("已通过 Hook 提速刷新。{msg}")),
            Err(err) => fallback_notes.push(format!("Hook 提速刷新失败：{err}")),
        }
    } else {
        fallback_notes.push("未安装 Hook 提速版".to_string());
    }

    let restart_result = tauri::async_runtime::spawn_blocking(restart_extension_host_internal)
        .await
        .map_err(|e| format!("重启 Extension Host 任务执行失败: {e}"))?;
    match restart_result {
        Ok(msg) => {
            if fallback_notes.is_empty() {
                return Ok(msg);
            }
            return Ok(format!(
                "{}；已回退到重启 Extension Host。{msg}",
                fallback_notes.join("；")
            ));
        }
        Err(err) => fallback_notes.push(format!("重启 Extension Host 失败：{err}")),
    }

    let preferred_kinds = preferred_editor_kinds_internal();
    let command_uris = build_editor_command_uris("workbench.action.reloadWindow", &preferred_kinds);
    let mut opener_errors: Vec<String> = Vec::new();

    for command_uri in &command_uris {
        match app.opener().open_url(command_uri.clone(), None::<String>) {
            Ok(_) => {
                if fallback_notes.is_empty() {
                    return Ok("已请求 VS Code 重载窗口。".to_string());
                }
                return Ok(format!(
                    "{}；已降级为窗口重载。已请求 VS Code 重载窗口。",
                    fallback_notes.join("；")
                ));
            }
            Err(err) => opener_errors.push(format!("{command_uri} -> {err}")),
        }
    }

    let cli_result = tauri::async_runtime::spawn_blocking(trigger_vscode_reload_internal)
        .await
        .map_err(|e| format!("刷新 VS Code 任务执行失败: {e}"))?;
    match cli_result {
        Ok(msg) => {
            if fallback_notes.is_empty() {
                Ok(msg)
            } else {
                Ok(format!(
                    "{}；已降级为窗口重载。{msg}",
                    fallback_notes.join("；")
                ))
            }
        }
        Err(err) => {
            let mut reasons: Vec<String> = Vec::new();
            reasons.extend(fallback_notes);
            if opener_errors.is_empty() {
                reasons.push(err);
            } else {
                reasons.push(format!(
                    "{err}（open_url 失败详情: {}）",
                    opener_errors.join(" | ")
                ));
            }
            Err(reasons.join("；"))
        }
    }
}

#[tauri::command]
fn restart_extension_host() -> CmdResult<String> {
    restart_extension_host_internal()
}

#[tauri::command]
fn install_codex_hook() -> CmdResult<String> {
    install_codex_hook_internal()
}

#[tauri::command]
async fn get_vscode_status() -> CmdResult<VsCodeStatusView> {
    tauri::async_runtime::spawn_blocking(get_vscode_status_internal)
        .await
        .map_err(|e| format!("检测 VS Code 状态任务执行失败: {e}"))
}

#[tauri::command]
async fn get_opencode_monitor_status() -> CmdResult<OpenCodeMonitorStatusView> {
    tauri::async_runtime::spawn_blocking(get_opencode_monitor_status_internal)
        .await
        .map_err(|e| format!("检测 OpenCode 监听状态任务执行失败: {e}"))
}

#[tauri::command]
fn get_codex_extension_info() -> CodexExtensionInfoView {
    get_codex_extension_info_internal()
}

#[tauri::command]
fn is_codex_hook_installed() -> bool {
    has_codex_hook_installed_internal()
}

#[tauri::command]
fn load_skills_catalog() -> CmdResult<SkillsCatalogView> {
    load_skills_catalog_internal()
}

#[tauri::command]
fn set_skill_targets(
    skill_id: String,
    codex: bool,
    opencode: bool,
) -> CmdResult<SkillsCatalogView> {
    set_skill_targets_internal(&skill_id, codex, opencode)
}

#[tauri::command]
fn run_post_switch_action(strategy: String) -> CmdResult<String> {
    run_post_switch_action_internal(&strategy)
}

#[tauri::command]
async fn export_data_backup(output_dir: Option<String>) -> CmdResult<BackupExportResult> {
    tauri::async_runtime::spawn_blocking(move || export_data_backup_internal(output_dir.as_deref()))
        .await
        .map_err(|e| format!("导出备份任务执行失败: {e}"))?
}

#[tauri::command]
async fn import_data_backup_base64(
    file_name: String,
    archive_base64: String,
) -> CmdResult<BackupImportResult> {
    tauri::async_runtime::spawn_blocking(move || {
        import_data_backup_base64_internal(&file_name, &archive_base64)
    })
    .await
    .map_err(|e| format!("导入备份任务执行失败: {e}"))?
}

#[tauri::command]
fn format_reset_time(ts: Option<i64>) -> String {
    fmt_reset(ts)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AutoSwitchRuntimeState::default())
        .invoke_handler(tauri::generate_handler![
            load_dashboard,
            save_current_profile,
            add_account_by_login,
            apply_profile,
            set_workspace_alias,
            set_profile_support,
            refresh_profile_quota,
            refresh_all_quota,
            keepalive_all,
            auto_switch_tick,
            thread_recover_tick,
            auto_switch_reset,
            delete_profile,
            reorder_profiles,
            reload_vscode_window,
            restart_extension_host,
            install_codex_hook,
            get_vscode_status,
            get_opencode_monitor_status,
            get_codex_extension_info,
            is_codex_hook_installed,
            load_skills_catalog,
            set_skill_targets,
            run_post_switch_action,
            export_data_backup,
            import_data_backup_base64,
            format_reset_time
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
