module.exports = async function aiCommand(sock, message, chatId, fullArgs, reply) {
  if (!fullArgs || !fullArgs.trim()) {
    await reply('Please send a question or prompt for AI. Example: ai tell me a joke')
    return
  }
  await reply('🤖 Thinking... Please wait.')
  await new Promise(resolve => setTimeout(resolve, 1000))
  await reply(`🧠 AI reply: ${fullArgs}`)
}
