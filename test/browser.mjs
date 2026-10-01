import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

/**
 * Resolve a Chromium to drive.
 *
 * Playwright normally knows where its own download is; this also copes with a
 * machine (like the one this was developed on) that already has a *different*
 * Playwright browser build cached. CHROME_PATH overrides everything.
 */
export function chromiumPath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  try {
    const p = chromium.executablePath()
    if (p && existsSync(p)) return p
  } catch {
    /* playwright has no download registered */
  }
  const cache = join(homedir(), '.cache', 'ms-playwright')
  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse()
    for (const d of dirs) {
      for (const rel of [
        ['chrome-linux64', 'chrome'],
        ['chrome-linux', 'chrome'],
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
      ]) {
        const p = join(cache, d, ...rel)
        if (existsSync(p)) return p
      }
    }
  }
  return undefined
}

export function launch() {
  return chromium.launch({
    executablePath: chromiumPath(),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
}
