#!/usr/bin/env node
/**
 * Build the site and publish it to the `gh-pages` branch.
 *
 * This exists because pushing to GitHub Pages needs a token scope that is
 * separate from pushing code: the Actions workflow in .github/workflows is the
 * nicer route once your token has the `workflow` scope, but this needs nothing
 * beyond the one you already use to push.
 *
 *   npm run deploy
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const [owner, repo] = (pkg.repository.url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/) ?? []).slice(1)

if (!owner || !repo) {
  console.error('Could not read owner/repo from package.json -> repository.url')
  process.exit(1)
}

const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'inherit' })
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })

function argFor(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

console.log(`\nPublishing ${repo} to GitHub Pages\n`)

console.log('• typechecking and building')
run('npm', ['run', 'build'])

const stage = mkdtempSync(join(tmpdir(), 'adi-draw-pages-'))
try {
  cpSync(join(root, 'dist'), stage, { recursive: true })

  // source maps are for debugging, not for serving
  for (const f of readdirSafe(join(stage, 'assets'))) {
    if (f.endsWith('.map')) rmSync(join(stage, 'assets', f))
  }
  // keep the Pages 404 page so deep links land back on the app
  writeFileSync(join(stage, '404.html'), readFileSync(join(root, 'scripts', '404.html')))
  writeFileSync(join(stage, '.nojekyll'), '')

  const branch = argFor('--branch') ?? 'gh-pages'
  process.chdir(stage)
  const g = (...args) => execFileSync('git', args, { stdio: 'inherit' })
  g('init', '-b', branch, '-q')
  g('config', 'user.name', pkg.author ?? 'Adi Draw')
  g('config', 'user.email', 'adi-draw@users.noreply.com')
  // let the GitHub CLI hand over credentials, if it is the thing that's authed
  if (hasGhAuth()) g('config', 'credential.helper', '!gh auth git-credential')
  g('add', '-A')
  g('commit', '-q', '-m', `Deploy ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`)
  g('push', '-f', `https://github.com/${owner}/${repo}.git`, branch)

  console.log(`\n✓ live at https://${owner.toLowerCase()}.github.io/${repo}/`)
  console.log('  (GitHub builds the branch; allow a minute)')
  console.log('  deploy log: https://github.com/' + owner + '/' + repo + '/actions\n')
} finally {
  process.chdir(root)
  rmSync(stage, { recursive: true, force: true })
}

function hasGhAuth() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function readdirSafe(p) {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}
