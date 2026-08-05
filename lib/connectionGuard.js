function createSingleFlight(fn) {
    const inFlight = new Map()

    return function singleFlight(key, ...args) {
        const cacheKey = key == null ? '__default__' : String(key)
        const existing = inFlight.get(cacheKey)
        if (existing) return existing

        const promise = (async () => {
            try {
                return await fn(...args)
            } finally {
                if (inFlight.get(cacheKey) === promise) {
                    inFlight.delete(cacheKey)
                }
            }
        })()

        inFlight.set(cacheKey, promise)
        return promise
    }
}

module.exports = {
    createSingleFlight,
}
