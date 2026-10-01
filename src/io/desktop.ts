/**
 * Electron bridge. Everything degrades gracefully to the browser flow
 * (downloads + <input type=file>) when the bridge is absent.
 */

export interface DesktopBridge {
  isDesktop: true
  platform: string
  save(contents: string, suggestedName: string): Promise<string | null>
  open(): Promise<{ path: string; name: string; contents: string } | null>
  exportPng(suggestedName: string, dataUrl: string): Promise<string | null>
  onMenu(handler: (action: string) => void): () => void
}

declare global {
  interface Window {
    inkDesktop?: DesktopBridge
  }
}

export const desktop: DesktopBridge | null =
  typeof window !== 'undefined' && window.inkDesktop ? window.inkDesktop : null

export const isDesktop = !!desktop
