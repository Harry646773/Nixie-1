'use strict'

const settingsManager = require('./settingsManager')
const moderationLogger = require('./moderationLogger')

const ALLOWED_MODERATOR_SETTINGS = new Set([
  'welcome',
  'goodbye',
  'antilink',
  'antibadword',
  'chatbotEnabled',
])

const DB_DIR = require('path').resolve(__dirname, '..', 'database')
const ROLE_FILE = require('path').join(DB_DIR, 'roles.json')
const fs = require('fs')
const fsp = require('fs/promises')
let _rolesCache = { data: null, exp: 0 }
let _writeQueue = Promise.resolve()
const CACHE_TTL = 5_000

function normalizeId(id = '') {
  return String(id).replace(/:\d+(?=@)/, '').replace(/@s\.whatsapp\.net$/, '').replace(/^\+/, '')
}

async function ensureDatabaseDirectory() {
  if (!fs.existsSync(DB_DIR)) {
    await fsp.mkdir(DB_DIR, { recursive: true })
  }
}

async function readJson(filePath, defaultValue) {
  try {
    await ensureDatabaseDirectory()
    const raw = await fsp.readFile(filePath, 'utf8')
    if (!raw.trim()) return defaultValue
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fsp.writeFile(filePath, JSON.stringify(defaultValue, null, 2), 'utf8')
      return defaultValue
    }
    console.error('[permissionManager] failed to read JSON:', error?.message || error)
    return defaultValue
  }
}

function writeQueue(task) {
  _writeQueue = _writeQueue.then(task).catch(err => {
    console.error('[permissionManager] writeQueue error:', err?.message || err)
  })
  return _writeQueue
}

async function persistRoles(data) {
  _rolesCache = { data, exp: Date.now() + CACHE_TTL }
  await writeQueue(async () => {
    const tempFile = `${ROLE_FILE}.${Date.now()}.tmp`
    await fsp.writeFile(tempFile, JSON.stringify(data, null, 2), 'utf8')
    await fsp.rename(tempFile, ROLE_FILE)
  })
}

async function loadRoles() {
  if (Date.now() < _rolesCache.exp && _rolesCache.data !== null) return _rolesCache.data
  const data = await readJson(ROLE_FILE, {})
  _rolesCache = { data, exp: Date.now() + CACHE_TTL }
  return data
}

async function getGlobalRole(userId) {
  const roles = await loadRoles()
  return roles[normalizeId(userId)] || 'member'
}

async function setGlobalRole(userId, role) {
  const clean = normalizeId(userId)
  const roles = await loadRoles()
  roles[clean] = String(role)
  await persistRoles(roles)
  return roles[clean]
}

async function removeGlobalRole(userId) {
  const clean = normalizeId(userId)
  const roles = await loadRoles()
  if (roles[clean]) {
    delete roles[clean]
    await persistRoles(roles)
  }
  return true
}

async function checkRole(userId, groupId = null) {
  const cleanUserId = normalizeId(userId)
  const globalRole = await getGlobalRole(cleanUserId)
  if (globalRole === 'owner') {
    return {
      role: 'owner',
      isOwner: true,
      isAdmin: true,
      isModerator: true,
      isMember: false,
      groupId: groupId || null,
    }
  }

  const groupData = groupId ? await settingsManager.getGroupData(groupId) : null
  const groupMember = groupData?.members?.[cleanUserId]
  const memberRole = groupMember?.role
  if (memberRole === 'admin') {
    return {
      role: 'admin',
      isOwner: false,
      isAdmin: true,
      isModerator: false,
      isMember: false,
      groupId: groupId || null,
    }
  }
  if (memberRole === 'moderator') {
    return {
      role: 'moderator',
      isOwner: false,
      isAdmin: false,
      isModerator: true,
      isMember: false,
      groupId: groupId || null,
    }
  }

  return {
    role: 'member',
    isOwner: false,
    isAdmin: false,
    isModerator: false,
    isMember: true,
    groupId: groupId || null,
  }
}

async function canManageGroupSetting(userId, groupId, fieldName) {
  const role = await checkRole(userId, groupId)
  if (role.isOwner || role.isAdmin) return true
  if (role.isModerator && ALLOWED_MODERATOR_SETTINGS.has(fieldName)) return true
  return false
}

async function logAction({ userId, targetUserId, groupId = null, action, metadata = {} }) {
  return moderationLogger.logAction({ userId, targetUserId, groupId, action, metadata })
}

module.exports = {
  checkRole,
  canManageGroupSetting,
  getGlobalRole,
  setGlobalRole,
  removeGlobalRole,
  logAction,
}
