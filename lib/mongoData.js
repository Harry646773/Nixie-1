const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const dbDir = path.join(__dirname, '..', 'data')
const dbFile = path.join(dbDir, 'nixie-db.json')

const DEFAULT_STATE = {
  features: {},
  modes: {},
  userSettings: {},
  pmBlockers: {},
  mentionReplies: {},
  autoReplies: {},
  timezones: {},
  owners: [],
  bannedUsers: [],
  warnings: {},
  mods: {},
  mutedUsers: {},
  groupSettings: {},
  antilink: {},
  antibadword: {},
  chatbot: {},
  antidelete: { enabled: false },
  welcome: {},
  goodbye: {},
  spam: {},
}

let state = null
let _saveScheduled = false
let _savePromise = Promise.resolve()

function ensureDb() {
  if (state !== null) return
  try {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
    if (fs.existsSync(dbFile)) {
      const text = fs.readFileSync(dbFile, 'utf8')
      state = Object.assign({}, DEFAULT_STATE, JSON.parse(text || '{}'))
    } else {
      state = JSON.parse(JSON.stringify(DEFAULT_STATE))
      scheduleSaveState()
    }
  } catch (err) {
    console.error('mongoData init error:', err.message)
    state = JSON.parse(JSON.stringify(DEFAULT_STATE))
  }
}

function scheduleSaveState() {
  if (_saveScheduled) return
  _saveScheduled = true
  setImmediate(() => {
    _saveScheduled = false
    _savePromise = _savePromise.then(async () => {
      try {
        await fsp.writeFile(dbFile, JSON.stringify(state, null, 2), 'utf8')
      } catch (err) {
        console.error('mongoData save error:', err.message)
      }
    })
  })
}

async function flushState() {
  if (!_saveScheduled) await _savePromise
}

function getNamespace(ns) {
  ensureDb()
  if (!state[ns] || typeof state[ns] !== 'object') state[ns] = {}
  return state[ns]
}

function getArray(ns) {
  ensureDb()
  if (!Array.isArray(state[ns])) state[ns] = []
  return state[ns]
}

function getOrDefault(ns, key, defaultValue) {
  return getNamespace(ns)[key] ?? defaultValue
}

function setNs(ns, key, value) {
  const nsObj = getNamespace(ns)
  nsObj[key] = value
  scheduleSaveState()
  return value
}

function ensureNested(ns, id) {
  const nsObj = getNamespace(ns)
  if (!nsObj[id] || typeof nsObj[id] !== 'object') nsObj[id] = {}
  return nsObj[id]
}

function ensureList(ns, id) {
  const nsObj = getNamespace(ns)
  if (!Array.isArray(nsObj[id])) nsObj[id] = []
  return nsObj[id]
}

function normalizeJid(jid) {
  if (!jid) return ''
  return String(jid).replace(/\s+/g, '')
}

process.on('beforeExit', async () => {
  await flushState()
})

module.exports = {
  async getAntidelete() {
    ensureDb()
    return state.antidelete || { enabled: false }
  },
  async setAntidelete(value) {
    ensureDb()
    state.antidelete = value || { enabled: false }
    scheduleSaveState()
    return state.antidelete
  },
  async getFeature(name) {
    ensureDb()
    return getOrDefault('features', name, {})
  },
  async setFeature(name, value) {
    return setNs('features', name, value)
  },
  async checkSpam(chatId, senderId) {
    ensureDb()
    const ts = Date.now()
    state.spam = state.spam || {}
    const chat = state.spam[chatId] || {}
    const user = chat[senderId] || []
    const recent = user.filter(t => ts - t < 10000)
    recent.push(ts)
    chat[senderId] = recent
    state.spam[chatId] = chat
    scheduleSaveState()
    return recent.length > 5
  },
  async resetSpam(chatId, senderId) {
    ensureDb()
    if (state.spam?.[chatId]) {
      state.spam[chatId][senderId] = []
      scheduleSaveState()
    }
  },
  async getMode(botNum) {
    ensureDb()
    return getOrDefault('modes', botNum, true)
  },
  async setMode(botNum, value) {
    return setNs('modes', botNum, value)
  },
  async setUserSetting(userId, key, value) {
    const user = ensureNested('userSettings', userId)
    user[key] = value
    scheduleSaveState()
    return user
  },
  async getUserSetting(userId, key, defaultValue) {
    ensureDb()
    const user = getNamespace('userSettings')[userId] || {}
    return user[key] !== undefined ? user[key] : defaultValue
  },
  async getPmBlocker(botNum) {
    ensureDb()
    return getOrDefault('pmBlockers', botNum, { enabled: false, message: '🚫 PMs are disabled.' })
  },
  async setPmBlocker(botNum, value) {
    return setNs('pmBlockers', botNum, value)
  },
  async getAutoreply(botNum) {
    ensureDb()
    return getOrDefault('autoReplies', botNum, { enabled: false, replies: {} })
  },
  async setAutoreply(botNum, value) {
    return setNs('autoReplies', botNum, value)
  },
  async getMentionReply(botNum) {
    ensureDb()
    return getOrDefault('mentionReplies', botNum, { enabled: false, message: '' })
  },
  async setMentionReply(botNum, value) {
    return setNs('mentionReplies', botNum, value)
  },
  async getOwners() {
    ensureDb()
    const owners = getArray('owners')
    const env = process.env.OWNER_NUMBER || ''
    const envOwners = String(env).split(/\s+/).filter(Boolean)
    return [...new Set([...owners, ...envOwners])]
  },
  async getTimezone(botNum) {
    ensureDb()
    return getOrDefault('timezones', botNum, null)
  },
  async setTimezone(botNum, value) {
    return setNs('timezones', botNum, value)
  },
  async banUser(target) {
    const normalized = normalizeJid(target)
    const list = getArray('bannedUsers')
    if (!list.includes(normalized)) {
      list.push(normalized)
      scheduleSaveState()
      return true
    }
    return false
  },
  async unbanUser(target) {
    ensureDb()
    const normalized = normalizeJid(target)
    const list = getArray('bannedUsers')
    const next = list.filter(u => u !== normalized)
    if (next.length !== list.length) {
      state.bannedUsers = next
      scheduleSaveState()
      return true
    }
    return false
  },
  async getWarnings(chatId, target) {
    ensureDb()
    const group = getNamespace('warnings')[chatId] || {}
    return group[normalizeJid(target)] || 0
  },
  async addWarning(chatId, target) {
    const group = ensureNested('warnings', chatId)
    const key = normalizeJid(target)
    group[key] = (group[key] || 0) + 1
    scheduleSaveState()
    return group[key]
  },
  async clearWarning(chatId, target) {
    ensureDb()
    const group = getNamespace('warnings')[chatId] || {}
    const key = normalizeJid(target)
    if (group[key]) {
      delete group[key]
      scheduleSaveState()
    }
  },
  async addMod(chatId, target) {
    const list = ensureList('mods', chatId)
    const normalized = normalizeJid(target)
    if (!list.includes(normalized)) {
      list.push(normalized)
      scheduleSaveState()
      return true
    }
    return false
  },
  async removeMod(chatId, target) {
    ensureDb()
    const list = ensureList('mods', chatId)
    const normalized = normalizeJid(target)
    const next = list.filter(u => u !== normalized)
    if (next.length !== list.length) {
      state.mods[chatId] = next
      scheduleSaveState()
      return true
    }
    return false
  },
  async getMods(chatId) {
    return ensureList('mods', chatId)
  },
  async muteUser(chatId, target) {
    const list = ensureList('mutedUsers', chatId)
    const normalized = normalizeJid(target)
    if (!list.includes(normalized)) {
      list.push(normalized)
      scheduleSaveState()
      return true
    }
    return false
  },
  async unmuteUser(chatId, target) {
    ensureDb()
    const list = ensureList('mutedUsers', chatId)
    const normalized = normalizeJid(target)
    const next = list.filter(u => u !== normalized)
    if (next.length !== list.length) {
      state.mutedUsers[chatId] = next
      scheduleSaveState()
      return true
    }
    return false
  },
  async getGroupSetting(chatId, key) {
    ensureDb()
    const group = getNamespace('groupSettings')[chatId] || {}
    return group[key] || {}
  },
  async setGroupSetting(chatId, key, value) {
    const group = ensureNested('groupSettings', chatId)
    group[key] = value
    scheduleSaveState()
    return group[key]
  },
  async getAntilink(chatId) {
    ensureDb()
    return getOrDefault('antilink', chatId, { enabled: false, action: 'delete' })
  },
  async setAntilink(chatId, value) {
    return setNs('antilink', chatId, value)
  },
  async getAntibadword(chatId) {
    ensureDb()
    return getOrDefault('antibadword', chatId, { enabled: false, words: [], action: 'delete' })
  },
  async setAntibadword(chatId, value) {
    return setNs('antibadword', chatId, value)
  },
  async setChatbotEnabled(chatId, value) {
    return setNs('chatbot', chatId, value)
  },
  async isChatbotEnabled(chatId) {
    ensureDb()
    return getOrDefault('chatbot', chatId, false)
  },
  async isWelcomeEnabled(chatId) {
    ensureDb()
    return getOrDefault('welcome', chatId, false)
  },
  async setWelcome(chatId, value) {
    return setNs('welcome', chatId, value)
  },
  async isGoodbyeEnabled(chatId) {
    ensureDb()
    return getOrDefault('goodbye', chatId, false)
  },
  async setGoodbye(chatId, value) {
    return setNs('goodbye', chatId, value)
  },
  async getBannedUsers() {
    return getArray('bannedUsers')
  },
  async getMutedUsers(chatId) {
    return ensureList('mutedUsers', chatId)
  },
  async getArray(ns) {
    return getArray(ns)
  },
}
