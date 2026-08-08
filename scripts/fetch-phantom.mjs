#!/usr/bin/env node
// Fetch + extract the Phantom extension build into .cache-synpress/.
//
// Sibling of fetch-metamask.mjs and fetch-rabby.mjs, same cross-platform
// extraction. Node 18+, no dependencies.
//
// WHY THIS ONE CANNOT PIN A VERSION — and what we do instead
// Rabby publishes a versioned zip per GitHub release, so fetch-rabby.mjs pins
// by default. Phantom does not: it ships through the Chrome Web Store only
// (extension id bfnaelmomeimhlpmgjnjophhpkkoljpa) and publishes no downloadable
// build. Searching turns up several third-party "Phantom download" repos; every
// one of them is an unverified mirror of a wallet, and loading a wallet binary
// from an unverified mirror is not a trade this project makes at any price.
//
// So we fetch from Google's own CRX endpoint — the same URL Chrome itself uses
// to install and update the extension. That is authentic, but it always serves
// the CURRENT version; there is no way to ask it for an older one.
//
// The repo's rule is "a verdict against whatever was latest that day is not
// reproducible". We cannot satisfy that by pinning here, so we satisfy it the
// other way: this script READS the version out of the extracted manifest and
// prints it loudly, and that value MUST be written into the `wallet_version`
// column of matrix/data/results.csv for every Phantom cell. A recorded version
// is reproducible after the fact — you can always tell whether two runs
// measured the same build. A silent one is not.
//
// PHANTOM_CRX_VERSION only tells Google which Chrome version is asking; it does
// NOT select a Phantom version.
//
// Usage:  node scripts/fetch-phantom.mjs
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const EXT_ID = 'bfnaelmomeimhlpmgjnjophhpkkoljpa'
const CHROME_VERSION = process.env.PHANTOM_CRX_VERSION ?? '120.0.0.0'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(root, '.cache-synpress')
// Named `-latest` deliberately: the file is NOT a pinned artefact and the name
// should stop anyone treating it as one. Delete it to force a re-fetch.
const CRX = path.join(CACHE_DIR, 'phantom-chrome-latest.crx')
const DIR = path.join(CACHE_DIR, 'phantom-chrome-latest')
const URL =
  `https://clients2.google.com/service/update2/crx` +
  `?response=redirect&acceptformat=crx2,crx3` +
  `&prodversion=${CHROME_VERSION}&x=id%3D${EXT_ID}%26uc`

mkdirSync(CACHE_DIR, { recursive: true })

if (!existsSync(CRX)) {
  console.log('==> downloading Phantom (current Web Store build — cannot be pinned)')
  console.log(`    ${URL}`)
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    console.error(`download failed: HTTP ${res.status}`)
    console.error('If this 404s, the extension id may have changed. Verify at:')
    console.error(`  https://chromewebstore.google.com/detail/phantom/${EXT_ID}`)
    process.exit(1)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(CRX))
}

if (!findManifestDir(DIR)) {
  console.log(`==> extracting to ${DIR}`)
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  // A .crx is a zip with a signature header bolted on the front. Every
  // extractor below tolerates the leading garbage and finds the central
  // directory at the end, so no header stripping is needed — but if one day
  // one of them does not, that is the first thing to suspect.
  if (!extract(CRX, DIR)) {
    console.error('could not extract the Phantom CRX (need PowerShell, tar, unzip, or python3)')
    console.error('a .crx is a zip with a signature prefix; some strict unzippers refuse it')
    process.exit(1)
  }
}

const extensionDir = findManifestDir(DIR)
if (!extensionDir) {
  console.error(`extraction produced no manifest.json under ${DIR}`)
  console.error('contents:', readdirSync(DIR).join(', ') || '(empty)')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'))
console.log(`==> Phantom ready: ${extensionDir}`)
console.log(`    name=${manifest.name} version=${manifest.version} manifest_version=${manifest.manifest_version}`)
console.log('')
console.log('    ┌─────────────────────────────────────────────────────────────┐')
console.log(`    │ RECORD THIS: wallet_version = ${String(manifest.version).padEnd(29)}│`)
console.log('    │ Phantom cannot be version-pinned, so every Phantom cell in  │')
console.log('    │ matrix/data/results.csv MUST carry the version it ran on.   │')
console.log('    └─────────────────────────────────────────────────────────────┘')
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
      run('tar', ['-xf', zip, '-C', dir]) ||
      run('python3', ['-c', 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir])
    )
  }
  return (
    run('unzip', ['-q', '-o', zip, '-d', dir]) ||
    run('tar', ['-xf', zip, '-C', dir]) ||
    run('python3', ['-c', 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir])
  )
}
