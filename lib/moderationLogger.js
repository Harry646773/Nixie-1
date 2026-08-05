'use strict'

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')

const DB_DIR = path.resolve(__dirname, '..', 'database')
const LOG_FILE = path.join(DB_DIR, 'moderation_logs.json')
let _writeQueue = Promise.resolve()

function normalizeId(id = '') {
  return String(id).replace(/:\d+(?=@)/, '').replace(/@s\.whatsapp\.net$/, '').replace(/^\+/, '')
}

async function ensureDatabaseDirectory() {
  if (!fs.existsSync(DB_DIR)) {
    await fsp.mkdir(DB_DIR, { recursive: true })
  }
}

function writeQueue(task) {
  _writeQueue = _writeQueue.then(task).catch(err => {
    console.error('[moderationLogger] writeQueue error:', err?.message || err)
  })
  return _writeQueue
}

async function readLogs() {
  await ensureDatabaseDirectory()
  try {
    const raw = await fsp.readFile(LOG_FILE, 'utf8')
    if (!raw.trim()) return []
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') {
      await writeQueue(async () => await fsp.writeFile(LOG_FILE, '[]', 'utf8'))
      return []
    }
    console.error('[moderationLogger] failed to read logs:', error?.message || error)
    return []
  }
}

async function appendLog(entry) {
  await ensureDatabaseDirectory()
  return writeQueue(async () => {
    const logs = await readLogs()
    logs.push(entry)
    const tempFile = `${LOG_FILE}.${Date.now()}.tmp`
    await fsp.writeFile(tempFile, JSON.stringify(logs, null, 2), 'utf8')
    await fsp.rename(tempFile, LOG_FILE)
  })
}

async function logAction({ userId, targetUserId, groupId = null, action, metadata = {} }) {
  const timestamp = new Date().toISOString()
  const entry = {
    timestamp,
    userId: normalizeId(userId),
    targetUserId: normalizeId(targetUserId),
    groupId: groupId ? String(groupId) : null,
    action: String(action),
    metadata,
  }
  await appendLog(entry)
  return entry
}

module.exports = {
  logAction,
  readLogs,
}
