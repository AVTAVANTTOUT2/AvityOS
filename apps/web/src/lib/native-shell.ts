/**
 * Detects the macOS WKWebView shell that embeds the Figma Mission Control UI.
 * The native host injects `window.__AVITY_NATIVE__` before the first paint.
 */

export interface AvityNativeBridge {
  shell: true;
  platform: "macos";
  openNativeSettings: () => void;
  saveApiToken?: (token: string) => void;
}

declare global {
  interface Window {
    __AVITY_NATIVE__?: AvityNativeBridge;
    avityNativeNavigate?: (route: string) => void;
  }
}

export function isNativeShell(): boolean {
  return typeof window !== "undefined" && window.__AVITY_NATIVE__?.shell === true;
}

export function openNativeSettings(): void {
  window.__AVITY_NATIVE__?.openNativeSettings?.();
}

export function saveApiTokenToNative(token: string): void {
  window.__AVITY_NATIVE__?.saveApiToken?.(token);
}
