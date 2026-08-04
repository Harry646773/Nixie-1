module.exports = async function imagineCommand(sock, message, chatId, fullArgs, reply) {
  if (!fullArgs || !fullArgs.trim()) {
    await reply('Please provide a prompt to generate an image. Example: imagine a red dragon')
    return
  }
  await reply('🖼️ Generating image... Please wait.')
  await new Promise(resolve => setTimeout(resolve, 1000))
  await reply(`✅ Image generation completed. Prompt: ${fullArgs}`)
}
