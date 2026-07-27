#!/usr/bin/env node
// Fetch + extract the Rabby extension build into .cache-synpress/.
//
// Sibling of fetch-metamask.mjs, same rationale and same cross-platform
// extraction (Windows has no bash). Node 18+, no dependencies.
//
// WHY PIN A VERSION
// The matrix records a verdict per (dApp, wallet, flow). A verdict against
// "whatever was latest that day" is not reproducible, and wallet UIs drift
// fast — MetaMask renamed the Connect button's test id between 13.13.1 and
// 13.39.1 and silently broke the whole connect flow. So this pins by default
// and prints the version it actually resolved, for the `wallet_version`
// column in matrix/data/results.csv.
//
// To move deliberately:  RABBY_VERSION=0.93.101 node scripts/fetch-rabby.mjs
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const VERSION = process.env.RABBY_VERSION ?? '0.93.100'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(root, '.cache-synpress')
const ZIP = path.join(CACHE_DIR, `rabby-chrome-${VERSION}.zip`)
const DIR = path.join(CACHE_DIR, `rabby-chrome-${VERSION}`)
const URL = `https://github.com/RabbyHub/Rabby/releases/download/v${VERSION}/Rabby_v${VERSION}.zip`

mkdirSync(CACHE_DIR, { recursive: true })

if (!existsSync(ZIP)) {
  console.log(`==> downloading Rabby ${VERSION}`)
  console.log(`    ${URL}`)
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    console.error(`download failed: HTTP ${res.status} for ${URL}`)
    console.error('check the version exists: https://github.com/RabbyHub/Rabby/releases')
    process.exit(1)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(ZIP))
}

if (!findManifestDir(DIR)) {
  console.log(`==> extracting to ${DIR}`)
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  if (!extract(ZIP, DIR)) {
    console.error('could not extract the Rabby archive (need PowerShell, tar, unzip, or python3)')
    process.exit(1)
  }
}

// Unlike MetaMask's zip, which is flat, we do NOT assume manifest.json sits at
// the root — some extension archives wrap everything in a top-level folder.
// Resolve it rather than guessing, and fail loudly with a directory listing if
// it genuinely isn't there.
const extensionDir = findManifestDir(DIR)
if (!extensionDir) {
  console.error(`extraction produced no manifest.json under ${DIR}`)
  console.error('contents:', readdirSync(DIR).join(', ') || '(empty)')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'))
console.log(`==> Rabby ready: ${extensionDir}`)
console.log(`    name=${manifest.name} version=${manifest.version} manifest_version=${manifest.manifest_version}`)
if (extensionDir !== DIR) {
  console.log(`    NOTE: the archive nests the extension one level down — load THIS path, not ${DIR}`)
}

/** manifest.json at the root, or exactly one level below it. */
function findManifestDir(dir) {
  if (!existsSync(dir)) return null
  if (existsSync(path.join(dir, 'manifest.json'))) return dir
  for (const entry of readdirSync(dir)) {
    const candidate = path.join(dir, entry)
    if (statSync(candidate).isDirectory() && existsSync(path.join(candidate, 'manifest.json'))) {
      return candidate
    }
  }
  return null
}

function run(cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function extract(zip, dir) {
  if (process.platform === 'win32') {
    return (
      run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]) ||
      run('tar', ['-xf', zip, '-C', dir])
    )
  }
  return (
    run('unzip', ['-q', '-o', zip, '-d', dir]) ||
    run('tar', ['-xf', zip, '-C', dir]) ||
    run('python3', ['-c', 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir])
  )
}
