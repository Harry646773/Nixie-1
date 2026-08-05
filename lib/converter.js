const fs = require('fs')
const path = require('path')
const os = require('os')
const { writeFile, unlink, readFile } = require('fs').promises
const { spawn, spawnSync } = require('child_process')

let ffmpegPath
let ffmpegSource

function verifyFfmpegPath(candidate) {
  if (!candidate || !fs.existsSync(candidate)) return false
  const proc = spawnSync(candidate, ['-version'], { encoding: 'utf8' })
  return proc.status === 0 && !proc.error
}

function resolveFfmpegPath() {
  if (ffmpegPath) return ffmpegPath

  const candidates = [
    () => {
      const result = require('ffmpeg-static')
      if (typeof result === 'string' && verifyFfmpegPath(result)) {
        ffmpegSource = 'ffmpeg-static'
        return result
      }
    },
    () => {
      const installer = require('@ffmpeg-installer/ffmpeg')
      const result = installer?.path || installer
      if (typeof result === 'string' && verifyFfmpegPath(result)) {
        ffmpegSource = '@ffmpeg-installer/ffmpeg'
        return result
      }
    },
    () => {
      const command = process.platform === 'win32' ? 'where' : 'which'
      const proc = spawnSync(command, ['ffmpeg'], { encoding: 'utf8' })
      if (proc.status === 0 && proc.stdout) {
        const candidate = proc.stdout.split(/\r?\n/).find(Boolean)
        if (candidate && verifyFfmpegPath(candidate.trim())) {
          ffmpegSource = 'system'
          return candidate.trim()
        }
      }
    }
  ]

  for (const getPath of candidates) {
    try {
      const result = getPath()
      if (result) {
        ffmpegPath = result
        break
      }
    } catch (e) {
      continue
    }
  }

  if (!ffmpegPath) {
    throw new Error('ffmpeg binary not found. Install ffmpeg-static, @ffmpeg-installer/ffmpeg, or add ffmpeg to your PATH.')
  }

  return ffmpegPath
}

async function ffmpeg(inputBuffer, args = [], outExt = 'mp4', prefix = 'nixie') {
  const binary = resolveFfmpegPath()
  const tmpDir = os.tmpdir()
  const inPath = path.join(tmpDir, `${prefix}_${Date.now()}.in`)
  const outPath = path.join(tmpDir, `${prefix}_${Date.now()}.out.${outExt}`)
  await writeFile(inPath, inputBuffer)
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ['-y', '-i', inPath, ...args, outPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', d => stderr += d.toString())
    proc.on('error', err => reject(err))
    proc.on('close', async code => {
      try {
        if (code !== 0) {
          const err = new Error('ffmpeg exited with code ' + code + '\n' + stderr)
          reject(err)
          try { await unlink(inPath) } catch {}
          try { await unlink(outPath) } catch {}
          return
        }
        const outBuf = await readFile(outPath)
        await unlink(inPath).catch(() => {})
        await unlink(outPath).catch(() => {})
        resolve(outBuf)
      } catch (e) {
        reject(e)
      }
    })
  })
}

module.exports = { ffmpeg }
