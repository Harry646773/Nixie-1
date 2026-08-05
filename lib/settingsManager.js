'use strict'

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { EventEmitter } = require('events')
const { MongoClient } = require('mongodb')

const DB_DIR = path.resolve(__dirname, '..', 'database')
const USER_FILE = path.join(DB_DIR, 'users.json')
const GROUP_FILE = path.join(DB_DIR, 'groups.json')
const ROLE_FILE = path.join(DB_DIR, 'roles.json')
const CACHE_TTL = 5_000
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || ''
const DB_NAME = process.env.MONGO_DB_NAME || 'nixie_bot'
const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 360000,
  connectTimeoutMS: 10000,
  family: 4,
  appName: 'NixieBot',
  retryWrites: true,
}

const DEFAULT_USER_SETTINGS = {
  prefix: '.',
  font: 'regular',
  replyStyle: 'premium',
  menuStyle: 'default',
  language: 'en',
  theme: 'default',
  autoread: false,
  autoreact: false,
  autotyping: true,
  mode: 'strict',
}

const DEFAULT_GROUP_SETTINGS = {
  font: 'clean',
  replyStyle: 'premium',
  menuStyle: 'default',
  language: 'en',
  theme: 'default',
  welcome: true,
  goodbye: true,
  antilink: { enabled: true, action: 'delete' },
  antibadword: { enabled: true, words: [] },
  antispam: { enabled: true, action: 'delete' },
  antisticker: { enabled: true, action: 'delete' },
  chatbotEnabled: true,
  mutedUsers: [],
}

const _cache = {
  users: { data: null, exp: 0 },
  groups: { data: null, exp: 0 },
  roles: { data: null, exp: 0 },
}

const events = new EventEmitter()
let _writeQueue = Promise.resolve()
let _mongoClient = null
let _mongoDb = null
let _mongoInitPromise = null

function normalizeId(id = '') {
  return String(id).replace(/:\d+(?=@)/, '').replace(/@s\.whatsapp\.net$/, '').replace(/^\+/, '')
}

function mergeDefaults(base, defaults) {
  return { ...defaults, ...base }
}

async function ensureDatabaseDirectory() {
  if (!fs.existsSync(DB_DIR)) {
    await fsp.mkdir(DB_DIR, { recursive: true })
  }
}

async function writeJsonAtomic(filePath, data) {
  await ensureDatabaseDirectory()
  const tempFile = `${filePath}.${Date.now()}.tmp`
  await fsp.writeFile(tempFile, JSON.stringify(data, null, 2), 'utf8')
  await fsp.rename(tempFile, filePath)
}

async function recoverCorruptedFile(filePath, defaultValue, error) {
  try {
    const backupPath = `${filePath}.corrupted.${Date.now()}`
    await fsp.copyFile(filePath, backupPath)
    console.error(`[settingsManager] Corrupted JSON recovered. Backup saved to ${backupPath}`)
  } catch (copyError) {
    console.error('[settingsManager] Failed to backup corrupted JSON file:', copyError?.message || copyError)
  }
  await writeJsonAtomic(filePath, defaultValue)
  return defaultValue
}

async function readJson(filePath, defaultValue) {
  try {
    await ensureDatabaseDirectory()
    const raw = await fsp.readFile(filePath, 'utf8')
    if (!raw.trim()) return defaultValue
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') {
      await writeJsonAtomic(filePath, defaultValue)
      return defaultValue
    }
    return recoverCorruptedFile(filePath, defaultValue, error)
  }
}

function writeQueue(task) {
  _writeQueue = _writeQueue.then(task).catch(err => {
    console.error('[settingsManager] writeQueue error:', err?.message || err)
  })
  return _writeQueue
}

async function getMongoDb() {
  if (_mongoDb) return _mongoDb
  if (_mongoInitPromise) return _mongoInitPromise
  if (!MONGO_URI) return null

  _mongoInitPromise = (async () => {
    try {
      const client = new MongoClient(MONGO_URI, CONNECT_OPTIONS)
      await client.connect()
      _mongoClient = client
      _mongoDb = client.db(DB_NAME)
      await _mongoDb.collection('bot_data').createIndex({ type: 1, scope: 1 }, { background: true })
      return _mongoDb
    } catch (err) {
      _mongoClient = null
      _mongoDb = null
      _mongoInitPromise = null
      throw err
    }
  })()

  try {
    return await _mongoInitPromise
  } catch (err) {
    console.warn('[settingsManager] MongoDB unavailable, using legacy persistence fallback:', err?.message || err)
    return null
  }
}

async function normalizeGroup(raw) {
  const members = {}
  let settingsSource = {}

  if (!raw || typeof raw !== 'object') {
    settingsSource = {}
  } else if (raw.settings && typeof raw.settings === 'object') {
    settingsSource = raw.settings
    if (raw.members && typeof raw.members === 'object') {
      for (const [id, memberInfo] of Object.entries(raw.members)) {
        const role = memberInfo && typeof memberInfo === 'object' ? String(memberInfo.role || 'member') : 'member'
        members[normalizeId(id)] = { role }
      }
    }
  } else {
    const { members: rawMembers, mods, ...rootSettings } = raw
    settingsSource = rootSettings
    if (rawMembers && typeof rawMembers === 'object') {
      for (const [id, memberInfo] of Object.entries(rawMembers)) {
        const role = memberInfo && typeof memberInfo === 'object' ? String(memberInfo.role || 'member') : 'member'
        members[normalizeId(id)] = { role }
      }
    }
    if (Array.isArray(mods)) {
      for (const id of mods) {
        if (typeof id === 'string') {
          members[normalizeId(id)] = { role: 'moderator' }
        }
      }
    }
  }

  return {
    settings: mergeDefaults(settingsSource, DEFAULT_GROUP_SETTINGS),
    members,
  }
}

async function migrateLegacyJsonToMongo() {
  const db = await getMongoDb()
  if (!db) return false

  const [legacyUsers, legacyGroups, legacyRoles] = await Promise.all([
    readJson(USER_FILE, {}),
    readJson(GROUP_FILE, {}),
    readJson(ROLE_FILE, {}),
  ])

  const userCollection = db.collection('bot_data')

  const userDocs = Object.entries(legacyUsers || {})
  for (const [userId, rawSettings] of userDocs) {
    if (!userId || typeof rawSettings !== 'object') continue
    const normalizedId = normalizeId(userId)
    const merged = mergeDefaults({ ...rawSettings }, DEFAULT_USER_SETTINGS)
    await userCollection.updateOne(
      { type: 'userSettings', scope: normalizedId },
      { $setOnInsert: { type: 'userSettings', scope: normalizedId, createdAt: new Date() }, $set: { data: merged, updatedAt: new Date() } },
      { upsert: true }
    )
  }

  const groupCollection = db.collection('bot_data')
  for (const [groupId, rawValue] of Object.entries(legacyGroups || {})) {
    const normalizedGroup = await normalizeGroup(rawValue)
    await groupCollection.updateOne(
      { type: 'groupSettings', scope: String(groupId) },
      { $setOnInsert: { type: 'groupSettings', scope: String(groupId), createdAt: new Date() }, $set: { data: normalizedGroup.settings, members: normalizedGroup.members, updatedAt: new Date() } },
      { upsert: true }
    )
  }

  const roleCollection = db.collection('bot_data')
  for (const [userId, role] of Object.entries(legacyRoles || {})) {
    const normalizedId = normalizeId(userId)
    await roleCollection.updateOne(
      { type: 'userRole', scope: normalizedId },
      { $setOnInsert: { type: 'userRole', scope: normalizedId, createdAt: new Date() }, $set: { data: String(role), updatedAt: new Date() } },
      { upsert: true }
    )
  }

  return true
}

async function ensureMongoSeeded() {
  if (_cache._seeded) return true
  try {
    await migrateLegacyJsonToMongo()
    _cache._seeded = true
    return true
  } catch (err) {
    console.warn('[settingsManager] Legacy seed failed:', err?.message || err)
    return false
  }
}

async function loadUsers() {
  if (Date.now() < _cache.users.exp && _cache.users.data !== null) return _cache.users.data
  const db = await getMongoDb()
  const data = {}
  if (db) {
    const docs = await db.collection('bot_data').find({ type: 'userSettings' }).toArray()
    for (const doc of docs) {
      data[normalizeId(doc.scope)] = doc.data || {}
    }
    await ensureMongoSeeded()
  } else {
    const legacy = await readJson(USER_FILE, {})
    Object.assign(data, legacy)
  }
  _cache.users = { data, exp: Date.now() + CACHE_TTL }
  return data
}

async function loadGroups() {
  if (Date.now() < _cache.groups.exp && _cache.groups.data !== null) return _cache.groups.data
  const db = await getMongoDb()
  const groups = {}
  if (db) {
    const docs = await db.collection('bot_data').find({ type: 'groupSettings' }).toArray()
    for (const doc of docs) {
      groups[String(doc.scope)] = {
        settings: mergeDefaults(doc.data || {}, DEFAULT_GROUP_SETTINGS),
        members: doc.members || {},
      }
    }
    await ensureMongoSeeded()
  } else {
    const raw = await readJson(GROUP_FILE, {})
    for (const [groupId, rawValue] of Object.entries(raw)) {
      const normalizedGroup = await normalizeGroup(rawValue)
      groups[groupId] = normalizedGroup
    }
  }
  _cache.groups = { data: groups, exp: Date.now() + CACHE_TTL }
  return groups
}

async function loadRoles() {
  if (Date.now() < _cache.roles.exp && _cache.roles.data !== null) return _cache.roles.data
  const db = await getMongoDb()
  const roles = {}
  if (db) {
    const docs = await db.collection('bot_data').find({ type: 'userRole' }).toArray()
    for (const doc of docs) {
      roles[normalizeId(doc.scope)] = String(doc.data || '')
    }
  } else {
    const legacy = await readJson(ROLE_FILE, {})
    Object.assign(roles, legacy)
  }
  _cache.roles = { data: roles, exp: Date.now() + CACHE_TTL }
  return roles
}

async function persistUsers(users) {
  _cache.users = { data: users, exp: Date.now() + CACHE_TTL }
  const db = await getMongoDb()
  if (db) {
    return writeQueue(async () => {
      const collection = db.collection('bot_data')
      for (const [userId, data] of Object.entries(users)) {
        const normalizedId = normalizeId(userId)
        await collection.updateOne(
          { type: 'userSettings', scope: normalizedId },
          { $setOnInsert: { type: 'userSettings', scope: normalizedId, createdAt: new Date() }, $set: { data: mergeDefaults(data || {}, DEFAULT_USER_SETTINGS), updatedAt: new Date() } },
          { upsert: true }
        )
      }
    })
  }
  return writeQueue(async () => await writeJsonAtomic(USER_FILE, users))
}

async function persistGroups(groups) {
  _cache.groups = { data: groups, exp: Date.now() + CACHE_TTL }
  const db = await getMongoDb()
  if (db) {
    return writeQueue(async () => {
      const collection = db.collection('bot_data')
      for (const [groupId, value] of Object.entries(groups)) {
        const normalizedGroup = value && typeof value === 'object' ? value : { settings: {}, members: {} }
        const settings = mergeDefaults(normalizedGroup.settings || {}, DEFAULT_GROUP_SETTINGS)
        await collection.updateOne(
          { type: 'groupSettings', scope: String(groupId) },
          { $setOnInsert: { type: 'groupSettings', scope: String(groupId), createdAt: new Date() }, $set: { data: settings, members: normalizedGroup.members || {}, updatedAt: new Date() } },
          { upsert: true }
        )
      }
    })
  }
  return writeQueue(async () => await writeJsonAtomic(GROUP_FILE, groups))
}

async function persistRoles(roles) {
  _cache.roles = { data: roles, exp: Date.now() + CACHE_TTL }
  const db = await getMongoDb()
  if (db) {
    return writeQueue(async () => {
      const collection = db.collection('bot_data')
      for (const [userId, role] of Object.entries(roles)) {
        const normalizedId = normalizeId(userId)
        await collection.updateOne(
          { type: 'userRole', scope: normalizedId },
          { $setOnInsert: { type: 'userRole', scope: normalizedId, createdAt: new Date() }, $set: { data: String(role), updatedAt: new Date() } },
          { upsert: true }
        )
      }
    })
  }
  return writeQueue(async () => await writeJsonAtomic(ROLE_FILE, roles))
}

async function getUserSettings(userId) {
  const key = normalizeId(userId)
  const users = await loadUsers()
  if (!Object.prototype.hasOwnProperty.call(users, key)) {
    const defaults = mergeDefaults({}, DEFAULT_USER_SETTINGS)
    users[key] = defaults
    await persistUsers(users)
    return defaults
  }
  return mergeDefaults(users[key], DEFAULT_USER_SETTINGS)
}

async function saveUserSettings(userId, settings) {
  const key = normalizeId(userId)
  const users = await loadUsers()
  const existing = users[key] || {}
  const merged = mergeDefaults({ ...existing, ...settings }, DEFAULT_USER_SETTINGS)
  users[key] = merged
  await persistUsers(users)
  events.emit('userSettingsChanged', key)
  return merged
}

async function getUserSetting(userId, key, defaultValue = false) {
  const settings = await getUserSettings(userId)
  return settings?.[key] !== undefined ? settings[key] : defaultValue
}

async function setUserSetting(userId, key, value) {
  return saveUserSettings(userId, { [key]: value })
}

async function getGroupData(groupId) {
  const groups = await loadGroups()
  const key = String(groupId)
  if (!groups[key]) {
    groups[key] = { settings: mergeDefaults({}, DEFAULT_GROUP_SETTINGS), members: {} }
    await persistGroups(groups)
  }
  return groups[key]
}

async function getGroupSettings(groupId) {
  const group = await getGroupData(groupId)
  return group.settings
}

async function saveGroupSettings(groupId, settings) {
  const groups = await loadGroups()
  const key = String(groupId)
  const group = groups[key] || { settings: mergeDefaults({}, DEFAULT_GROUP_SETTINGS), members: {} }
  group.settings = mergeDefaults({ ...group.settings, ...settings }, DEFAULT_GROUP_SETTINGS)
  groups[key] = group
  await persistGroups(groups)
  events.emit('groupSettingsChanged', key)
  return group.settings
}

async function getGroupSetting(groupId, key, defaultValue = null) {
  const settings = await getGroupSettings(groupId)
  return settings?.[key] !== undefined ? settings[key] : defaultValue
}

async function setGroupSetting(groupId, key, value) {
  const group = await getGroupData(groupId)
  group.settings[key] = value
  return saveGroupSettings(groupId, group.settings)
}

async function getGroupMembers(groupId) {
  const group = await getGroupData(groupId)
  return group.members || {}
}

async function getGroupMemberRole(groupId, userId) {
  const members = await getGroupMembers(groupId)
  return members[normalizeId(userId)]?.role || 'member'
}

async function setGroupMemberRole(groupId, userId, role) {
  const groups = await loadGroups()
  const key = String(groupId)
  const group = groups[key] || { settings: mergeDefaults({}, DEFAULT_GROUP_SETTINGS), members: {} }
  const normalizedUserId = normalizeId(userId)
  group.members = group.members || {}
  group.members[normalizedUserId] = { role: String(role) }
  groups[key] = group
  await persistGroups(groups)
  events.emit('groupSettingsChanged', key)
  return group.members[normalizedUserId]
}

async function removeGroupMemberRole(groupId, userId) {
  const groups = await loadGroups()
  const key = String(groupId)
  const group = groups[key]
  if (!group || !group.members) return false
  const normalizedUserId = normalizeId(userId)
  if (!group.members[normalizedUserId]) return false
  delete group.members[normalizedUserId]
  await persistGroups(groups)
  events.emit('groupSettingsChanged', key)
  return true
}

async function getUserRole(userId) {
  const roles = await loadRoles()
  return roles[normalizeId(userId)] || 'member'
}

async function setUserRole(userId, role) {
  const roles = await loadRoles()
  roles[normalizeId(userId)] = String(role)
  await persistRoles(roles)
  return roles[normalizeId(userId)]
}

async function removeUserRole(userId) {
  const roles = await loadRoles()
  const key = normalizeId(userId)
  if (roles[key]) delete roles[key]
  await persistRoles(roles)
  return true
}

module.exports = {
  getUserSettings,
  saveUserSettings,
  getGroupSettings,
  saveGroupSettings,
  getUserSetting,
  setUserSetting,
  getGroupSetting,
  setGroupSetting,
  getGroupData,
  getGroupMembers,
  getGroupMemberRole,
  setGroupMemberRole,
  removeGroupMemberRole,
  getUserRole,
  setUserRole,
  removeUserRole,
  loadUsers,
  loadGroups,
  loadRoles,
  persistUsers,
  persistGroups,
  persistRoles,
  events,
}
