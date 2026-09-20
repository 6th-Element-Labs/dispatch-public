// Builds Dispatch.app and installs it over /Applications/Dispatch.app, then
// relaunches it, so the app in the Dock is always the build you just made.
// Usage: npm run install:app [-- --skip-build] [-- --target /path/Applications]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const skipBuild = args.includes('--skip-build')
const targetDir = args.includes('--target') ? args[args.indexOf('--target') + 1] : '/Applications'
const targetRoot = process.env.CARGO_TARGET_DIR ?? join(desktop, 'src-tauri', 'target')
const built = join(targetRoot, 'release', 'bundle', 'macos', 'Dispatch.app')
const installed = join(targetDir, 'Dispatch.app')

if (process.platform !== 'darwin') fail('install-app only knows macOS')
if (!skipBuild) {
  console.log('install-app: building Dispatch.app')
  execFileSync('npx', ['tauri', 'build', '--bundles', 'app'], { cwd: desktop, stdio: 'inherit' })
}
if (!existsSync(join(built, 'Contents', 'MacOS', 'dispatch'))) fail(`${built} is missing; build first`)

console.log('install-app: quitting the running Dispatch')
spawnSync('osascript', ['-e', 'tell application "Dispatch" to quit'], { stdio: 'ignore' })
for (let waited = 0; waited < 10_000 && running(); waited += 250) sleep(250)
if (running()) fail('Dispatch is still running; quit it and rerun')

console.log(`install-app: replacing ${installed}`)
rmSync(installed, { recursive: true, force: true })
execFileSync('ditto', [built, installed], { stdio: 'inherit' })
execFileSync('xattr', ['-dr', 'com.apple.quarantine', installed], { stdio: 'ignore' })
console.log('install-app: launching')
execFileSync('open', ['-a', installed], { stdio: 'inherit' })
console.log(`install-app: ${installed} is the running build`)

function running() {
  return spawnSync('pgrep', ['-f', 'Dispatch.app/Contents/MacOS/dispatch']).status === 0
}
function sleep(ms) {
  spawnSync('sleep', [String(ms / 1000)])
}
function fail(message) {
  console.error(`install-app: ${message}`)
  process.exit(1)
}
