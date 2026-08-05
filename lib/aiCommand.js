/**
 * lib/aiCommand.js
 * NIXIE conversational AI handler for WhatsApp.
 * Uses Trustbit only for all AI text responses.
 */
'use strict'

const axios = require('axios')

const TRUSTBIT_AI_BASE = process.env.TRUSTBIT_AI_BASE || 'https://trustbit-api-devtrust.onrender.com/api/ai'
const TRUSTBIT_AI_MODEL = process.env.TRUSTBIT_AI_MODEL || 'gpt-5'

function buildTrustbitUrl(promptText) {
  const param = TRUSTBIT_AI_MODEL === 'aichat' ? 'prompt' : 'text'
  return `${TRUSTBIT_AI_BASE}/${TRUSTBIT_AI_MODEL}?${param}=${encodeURIComponent(promptText)}`
}

const conversationMemory = new Map()
const MAX_HISTORY = 10

function getConversationState(chatId, senderId) {
  const key = `${chatId}::${senderId}`
  if (!conversationMemory.has(key)) {
    conversationMemory.set(key, {
      history: [],
      name: null,
      topics: [],
      preferences: {}
    })
  }
  return conversationMemory.get(key)
}

function extractUserName(message) {
  return message.pushName || message.pushname || message.participant || 'User'
}

function appendConversation(chatState, role, text) {
  if (!text) return
  const entry = { role, text: text.trim() }
  chatState.history.push(entry)
  if (chatState.history.length > MAX_HISTORY) chatState.history.shift()
}

function appendTopic(chatState, prompt) {
  if (!prompt) return
  chatState.topics.push(prompt.trim())
  if (chatState.topics.length > MAX_HISTORY) chatState.topics.shift()
}

function buildHistoryPrompt(chatState) {
  if (!chatState.history.length) return ''
  return chatState.history.map(entry => {
    if (entry.role === 'user') return `User: ${entry.text}`
    return `NIXIE: ${entry.text}`
  }).join('\n')
}

function isBadAIResponse(text) {
  if (!text || typeof text !== 'string') return true
  const trimmed = text.trim()
  if (!trimmed) return true
  const badPatterns = [
    /^error\b/i,
    /^failed\b/i,
    /^timed out\b/i,
    /^timeout\b/i,
    /^request timed out\b/i,
    /^service unavailable\b/i,
    /^unavailable\b/i,
    /^internal server error\b/i,
    /^socket timeout\b/i,
    /^unable to connect\b/i,
    /^no response\b/i,
    /^invalid request\b/i
  ]
  return badPatterns.some((pattern) => pattern.test(trimmed))
}

function extractAICandidate(data) {
  if (!data) return null
  const keys = ['result', 'response', 'message', 'text', 'reply', 'answer', 'content']
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim()
      if (!isBadAIResponse(trimmed)) return trimmed
    }
  }
  return null
}

async function aiCommand(sock, message, chatId, fullArgs, reply) {
  try {
    const prompt = (fullArgs || '').trim()
    if (!prompt) {
      await reply([
        `👋 Hi — I'm NIXIE, your group AI assistant!`,
        ``,
        `• Ask me anything (questions, fun, ideas).`,
        `• Examples:`,
        `  • .nixie tell a joke`,
        `  • .nixie summarize the last messages`,
        `  • .nixie explain async/await`,
        ``,
        `Tip: Mention me in a group like "nixie what's the weather?" and I'll reply.`
      ].join('\n'))
      return
    }

    const senderId = message.key?.participant || message.key?.remoteJid || 'unknown'
    const chatState = getConversationState(chatId, senderId)
    const userName = extractUserName(message)
    if (userName && userName !== 'User') chatState.name = userName

    const historyPrompt = buildHistoryPrompt(chatState)
    const systemPrompt = 'You are NIXIE, a human-like assistant in WhatsApp. Speak naturally, show empathy, and avoid saying "I am a bot".'
    const fullPrompt = historyPrompt
      ? `${systemPrompt}\n${historyPrompt}\nUser: ${prompt}\nNIXIE:`
      : `${systemPrompt}\nUser: ${prompt}\nNIXIE:`

    const timeout = 30_000
    const trustbitUrl = buildTrustbitUrl(fullPrompt)
    const res = await axios.get(trustbitUrl, { timeout })
    const candidate = extractAICandidate(res?.data)

    if (!candidate) {
      console.error('[aiCommand] Trustbit returned no usable response', res?.data)
      await reply('❌ Failed to get AI response. Please try again later.')
      return
    }

    const cleaned = candidate.replace(/^NIXIE:\s*/i, '').trim()
    if (isBadAIResponse(cleaned)) {
      console.error('[aiCommand] rejected bad AI response after cleaning:', cleaned)
      await reply('❌ Failed to get AI response. Please try again later.')
      return
    }

    await reply(`NIXIE: ${cleaned}`)
    appendConversation(chatState, 'user', prompt)
    appendConversation(chatState, 'assistant', cleaned)
    appendTopic(chatState, prompt)
  } catch (err) {
    console.error('aiCommand error:', err?.message || err)
    try { await reply('❌ Failed to get AI response. Please try again later.') } catch {}
  }
}

module.exports = aiCommand
