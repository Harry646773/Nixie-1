const games = new Map()

function formatBoard(board) {
  if (!Array.isArray(board) || board.length !== 9) board = Array(9).fill(' ')
  return board.map((cell, idx) => cell || ' ').reduce((acc, value, idx) => {
    const sep = (idx + 1) % 3 === 0 && idx < 8 ? '\n───┼───┼───\n' : ''
    return acc + ` ${value} ` + sep
  }, '')
}

function startGame(chatId, starterId, botId, isAdmin) {
  if (games.has(chatId)) {
    return { success: false, message: 'A TicTacToe game is already in progress.' }
  }
  const game = {
    chatId,
    starter: starterId,
    players: [starterId],
    botId,
    board: Array(9).fill(' '),
    currentTurn: starterId,
    status: 'waiting',
    winner: null,
  }
  games.set(chatId, game)
  return { success: true, game, message: 'TicTacToe game started! Use a number 1-9 to play.' }
}

function getGame(chatId) {
  return games.get(chatId)
}

function joinGame(chatId, senderId) {
  const game = games.get(chatId)
  if (!game) return { success: false, message: 'No active game to join.' }
  if (game.players.includes(senderId)) return { success: false, message: 'You are already in the game.' }
  if (game.players.length >= 2) return { success: false, message: 'Game already has two players.' }
  game.players.push(senderId)
  game.status = 'playing'
  return { success: true, game, message: 'Joined TicTacToe game.' }
}

function resetGame(chatId) {
  const exists = games.has(chatId)
  games.delete(chatId)
  return { success: exists }
}

function surrenderGame(chatId, senderId) {
  const game = games.get(chatId)
  if (!game) return { success: false, message: 'No active game.' }
  if (!game.players.includes(senderId)) return { success: false, message: 'You are not in the game.' }
  games.delete(chatId)
  return { success: true, game: null, message: 'You surrendered the game.' }
}

function makeMove(chatId, senderId, position) {
  const game = games.get(chatId)
  if (!game) return { success: false, message: 'No active TicTacToe game.' }
  if (game.status === 'waiting') return { success: false, message: 'Waiting for another player to join.' }
  const pos = Number(position) - 1
  if (Number.isNaN(pos) || pos < 0 || pos > 8) return { success: false, message: 'Please choose a valid position 1-9.' }
  if (game.board[pos] !== ' ') return { success: false, message: 'That position is already taken.' }
  const marker = game.players.indexOf(senderId) === 0 ? 'X' : 'O'
  if (!marker) return { success: false, message: 'You are not a player in this game.' }
  game.board[pos] = marker
  game.currentTurn = game.players.find(p => p !== senderId) || senderId
  return { success: true, game, message: 'Move accepted.' }
}

module.exports = { startGame, getGame, joinGame, resetGame, surrenderGame, makeMove, formatBoard }