const AUTO_RESET_DELAY_MS = 5_000
const DEFAULT_BOARD = ['1','2','3','4','5','6','7','8','9']
const WIN_PATTERNS = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
]

const games = Object.create(null)
const cleanupTimers = Object.create(null)

function cloneGame(game) {
  if (!game) return null
  return {
    board: [...game.board],
    players: { ...game.players },
    turn: game.turn,
    status: game.status,
    createdAt: game.createdAt,
    lastActionAt: game.lastActionAt,
  }
}

function createBoard() {
  return [...DEFAULT_BOARD]
}

function formatCell(cell) {
  if (cell === 'X') return '❌'
  if (cell === 'O') return '⭕'
  return cell
}

function formatBoard(board) {
  const row = (cells) => `║ ${formatCell(cells[0])} ║ ${formatCell(cells[1])} ║ ${formatCell(cells[2])} ║`
  return [
    '╔═══╦═══╦═══╗',
    row(board.slice(0, 3)),
    '╠═══╬═══╬═══╣',
    row(board.slice(3, 6)),
    '╠═══╬═══╬═══╣',
    row(board.slice(6, 9)),
    '╚═══╩═══╩═══╝',
  ].join('\n')
}

function cleanupGame(chatId) {
  if (cleanupTimers[chatId]) {
    clearTimeout(cleanupTimers[chatId])
    delete cleanupTimers[chatId]
  }
  delete games[chatId]
}

function scheduleCleanup(chatId) {
  if (cleanupTimers[chatId]) clearTimeout(cleanupTimers[chatId])
  cleanupTimers[chatId] = setTimeout(() => cleanupGame(chatId), AUTO_RESET_DELAY_MS)
  if (cleanupTimers[chatId]?.unref) cleanupTimers[chatId].unref()
}

function getPlayerSymbol(game, userId) {
  if (!game) return null
  if (game.players.X === userId) return 'X'
  if (game.players.O === userId) return 'O'
  return null
}

function getOpponentSymbol(symbol) {
  return symbol === 'X' ? 'O' : 'X'
}

function getWinner(board) {
  for (const pattern of WIN_PATTERNS) {
    const [a, b, c] = pattern
    if (board[a] === board[b] && board[b] === board[c]) {
      return board[a]
    }
  }
  return null
}

function getGame(chatId) {
  return cloneGame(games[chatId])
}

function getGameForPlayer(chatId, userId) {
  const game = games[chatId]
  if (!game) return null
  const symbol = getPlayerSymbol(game, userId)
  return symbol ? cloneGame(game) : null
}

function hasGame(chatId) {
  return Boolean(games[chatId])
}

function startGame(chatId, playerX, botMode = 'public', isAdmin = false) {
  if (hasGame(chatId)) return { success: false, error: 'existing' }
  if (botMode === 'private' && !isAdmin) return { success: false, error: 'private' }

  games[chatId] = {
    board: createBoard(),
    players: { X: playerX, O: null },
    turn: 'X',
    status: 'waiting',
    createdAt: Date.now(),
    lastActionAt: Date.now(),
  }

  return { success: true, game: cloneGame(games[chatId]) }
}

function joinGame(chatId, playerO) {
  const game = games[chatId]
  if (!game) return { success: false, error: 'no-game' }
  if (game.status !== 'waiting') return { success: false, error: 'existing' }
  if (game.players.X === playerO) return { success: false, error: 'already-player' }

  game.players.O = playerO
  game.status = 'active'
  game.lastActionAt = Date.now()

  return { success: true, game: cloneGame(game) }
}

function makeMove(chatId, playerId, position) {
  const game = games[chatId]
  if (!game) return { success: false, error: 'no-game' }
  if (game.status !== 'active') return { success: false, error: 'no-active-game' }

  const symbol = getPlayerSymbol(game, playerId)
  if (!symbol) return { success: false, error: 'not-in-game' }
  if (game.turn !== symbol) return { success: false, error: 'not-your-turn' }
  if (!Number.isInteger(position) || position < 1 || position > 9) return { success: false, error: 'invalid' }

  const index = position - 1
  if (game.board[index] === 'X' || game.board[index] === 'O') return { success: false, error: 'cell-taken' }

  game.board[index] = symbol
  game.turn = getOpponentSymbol(symbol)
  game.lastActionAt = Date.now()

  const winner = getWinner(game.board)
  const isDraw = !winner && game.board.every((cell) => cell === 'X' || cell === 'O')

  if (winner || isDraw) {
    game.status = 'finished'
    scheduleCleanup(chatId)
  }

  return {
    success: true,
    game: cloneGame(game),
    winner,
    draw: isDraw,
  }
}

function surrenderGame(chatId, playerId) {
  const game = games[chatId]
  if (!game) return { success: false, error: 'no-game' }
  const symbol = getPlayerSymbol(game, playerId)
  if (!symbol) return { success: false, error: 'not-in-game' }

  const opponentSymbol = getOpponentSymbol(symbol)
  const opponentId = game.players[opponentSymbol]

  if (!opponentId) {
    cleanupGame(chatId)
    return { success: true, surrender: true }
  }

  game.status = 'finished'
  scheduleCleanup(chatId)
  return { success: true, winner: opponentId, surrender: true }
}

function resetGame(chatId) {
  if (!hasGame(chatId)) return { success: false, error: 'no-game' }
  cleanupGame(chatId)
  return { success: true }
}

module.exports = {
  startGame,
  joinGame,
  makeMove,
  surrenderGame,
  resetGame,
  getGame,
  getGameForPlayer,
  formatBoard,
  hasGame,
}
