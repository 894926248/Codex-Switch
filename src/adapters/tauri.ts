import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow as tauriGetCurrentWindow } from "@tauri-apps/api/window";
import { confirm as dialogConfirm, open as dialogOpen } from "@tauri-apps/plugin-dialog";

export const invoke = tauriInvoke;
export const listen = tauriListen;
export const getCurrentWindow = tauriGetCurrentWindow;
export const confirm = dialogConfirm;
export const open = dialogOpen;
