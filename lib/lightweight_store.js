// Lightweight message store for delete command functionality
class LightweightStore {
    constructor() {
        this.messages = {};
        this.maxMessagesPerChat = 1000;
        this.cleanupInterval = 300000; // 5 minutes
        this.initCleanup();
    }

    initCleanup() {
        setInterval(() => {
            this.cleanup();
        }, this.cleanupInterval);
    }

    addMessage(chatId, message) {
        if (!this.messages[chatId]) {
            this.messages[chatId] = [];
        }
        
        // Add message if not already exists
        if (!this.messages[chatId].find(m => m.key.id === message.key.id)) {
            this.messages[chatId].push(message);
            
            // Keep only last N messages
            if (this.messages[chatId].length > this.maxMessagesPerChat) {
                this.messages[chatId] = this.messages[chatId].slice(-this.maxMessagesPerChat);
            }
        }
    }

    cleanup() {
        // Remove old messages to prevent memory leaks
        const now = Date.now();
        const maxAge = 3600000; // 1 hour
        
        Object.keys(this.messages).forEach(chatId => {
            this.messages[chatId] = this.messages[chatId].filter(message => {
                const messageTime = message.messageTimestamp * 1000;
                return (now - messageTime) < maxAge;
            });
            
            // Remove empty chat arrays
            if (this.messages[chatId].length === 0) {
                delete this.messages[chatId];
            }
        });
    }

    getMessages(chatId) {
        return this.messages[chatId] || [];
    }
}

const store = new LightweightStore();

module.exports = store;
