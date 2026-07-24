#!/usr/bin/env node
// Fetch + extract the MetaMask build Synpress expects, into .cache-synpress/.
//
// Cross-platform replacement for fetch-metamask.sh: this runs on Windows (which
// has no bash) as well as macOS / Linux / WSL. Node 18+ only — no dependencies.
//
// Same rationale as the shell version: Synpress's own pure-JS unzip pegs a core
// and effectively never finishes, so we download + extract natively (seconds),
// and Synpress no-ops when the files already exist.
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const VERSION = process.env.METAMASK_VERSION ?? '13.39.1'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DIR = path.join(root, '.cache-synpress')
const ZIP = path.join(CACHE_DIR, `metamask-chrome-${VERSION}.zip`)
const DIR = path.join(CACHE_DIR, `metamask-chrome-${VERSION}`)
const URL = `https://github.com/MetaMask/metamask-extension/releases/download/v${VERSION}/metamask-chrome-${VERSION}.zip`

mkdirSync(CACHE_DIR, { recursive: true })

if (!existsSync(ZIP)) {
  console.log(`==> downloading MetaMask ${VERSION}`)
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    console.error(`download failed: HTTP ${res.status} for ${URL}`)
    process.exit(1)
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(ZIP))
}

if (!existsSync(path.join(DIR, 'manifest.json'))) {
  console.log(`==> extracting to ${DIR}`)
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  if (!extract(ZIP, DIR)) {
    console.error('could not extract the MetaMask archive (need PowerShell, tar, unzip, or python3)')
    process.exit(1)
  }
}

if (!existsSync(path.join(DIR, 'manifest.json'))) {
  console.error(`extraction produced no manifest.json in ${DIR}`)
  process.exit(1)
}
console.log(`==> MetaMask ready: ${DIR}`)

function run(cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function extract(zip, dir) {
  if (process.platform === 'win32') {
    // Expand-Archive ships with Windows PowerShell; bsdtar (tar.exe) is the fallback on Win10+.
    return (
      run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]) ||
      run('tar', ['-xf', zip, '-C', dir])
    )
  }
  // macOS bsdtar handles zips; Linux typically has unzip or python3.
  return (
    run('unzip', ['-q', '-o', zip, '-d', dir]) ||
    run('tar', ['-xf', zip, '-C', dir]) ||
    run('python3', ['-c', 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, dir])
  )
}
