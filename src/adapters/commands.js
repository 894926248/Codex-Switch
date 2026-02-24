import { invoke } from "./tauri";

export const DASHBOARD_COMMANDS = Object.freeze({
  applyProfile: "apply_profile",
  deleteProfile: "delete_profile",
  refreshAllQuota: "refresh_all_quota",
  refreshProfileQuota: "refresh_profile_quota",
  refreshProfilesQuota: "refresh_profiles_quota",
  reorderProfiles: "reorder_profiles",
  setWorkspaceAlias: "set_workspace_alias",
});

export function invokeCommand(command, args) {
  return args === void 0 ? invoke(command) : invoke(command, args);
}

export function loadSkillsCatalogCommand() {
  return invokeCommand("load_skills_catalog");
}

export function loadSkillsDiscoveryCommand(syncRemote) {
  return invokeCommand("load_skills_discovery", { syncRemote });
}

export function loadSkillReposManageCommand(refreshCount) {
  return invokeCommand("load_skill_repos_manage", { refreshCount });
}

export function loadMcpManageCommand() {
  return invokeCommand("load_mcp_manage");
}

export function loadDashboardCommand(syncCurrent, mode) {
  return invokeCommand("load_dashboard", { syncCurrent, mode });
}

export function addAccountByLoginCommand() {
  return invokeCommand("add_account_by_login", {});
}

export function exportDataBackupCommand(outputDir) {
  return invokeCommand("export_data_backup", { outputDir });
}

export function importDataBackupBase64Command(fileName, archiveBase64) {
  return invokeCommand("import_data_backup_base64", { fileName, archiveBase64 });
}

export function refreshProfileQuotaCommand(name, refreshToken, mode) {
  return invokeCommand("refresh_profile_quota", { name, refreshToken, mode });
}

export function reorderProfilesCommand(names) {
  return invokeCommand("reorder_profiles", { names });
}

export function getVsCodeStatusCommand(editorTarget) {
  return invokeCommand("get_vscode_status", { editorTarget });
}

export function getOpenCodeMonitorStatusCommand() {
  return invokeCommand("get_opencode_monitor_status");
}

export function getCodexExtensionInfoCommand() {
  return invokeCommand("get_codex_extension_info");
}

export function isCodexHookInstalledCommand(editorTarget) {
  return invokeCommand("is_codex_hook_installed", { editorTarget });
}

export function runPostSwitchActionCommand(strategy, editorTarget) {
  return invokeCommand("run_post_switch_action", { strategy, editorTarget });
}

export function reloadVsCodeWindowCommand() {
  return invokeCommand("reload_vscode_window");
}

export function installCodexHookCommand(editorTarget) {
  return editorTarget
    ? invokeCommand("install_codex_hook", { editorTarget })
    : invokeCommand("install_codex_hook");
}

export function autoSwitchResetCommand() {
  return invokeCommand("auto_switch_reset");
}

export function autoSwitchTickCommand(mode) {
  return invokeCommand("auto_switch_tick", { mode });
}

export function applyProfileCommand(name, mode) {
  return invokeCommand("apply_profile", { name, mode });
}

export function threadRecoverTickCommand(mode) {
  return invokeCommand("thread_recover_tick", { mode });
}

export function keepaliveAllCommand() {
  return invokeCommand("keepalive_all");
}

export function openExternalUrlCommand(url) {
  return invokeCommand("open_external_url", { url });
}

export function installDiscoverySkillCommand(payload) {
  return invokeCommand("install_discovery_skill", payload);
}

export function addSkillRepoCommand(repoInput, branch) {
  return invokeCommand("add_skill_repo", { repoInput, branch });
}

export function removeSkillRepoCommand(owner, name) {
  return invokeCommand("remove_skill_repo", { owner, name });
}

export function setSkillTargetsCommand(payload) {
  return invokeCommand("set_skill_targets", payload);
}

export function deleteSkillCommand(skillId) {
  return invokeCommand("delete_skill", { skillId });
}

export function addMcpServerCommand(payload) {
  return invokeCommand("add_mcp_server", payload);
}

export function setMcpTargetsCommand(payload) {
  return invokeCommand("set_mcp_targets", payload);
}

export function removeMcpServerCommand(serverId) {
  return invokeCommand("remove_mcp_server", { serverId });
}

export function importExistingMcpCommand() {
  return invokeCommand("import_existing_mcp");
}
