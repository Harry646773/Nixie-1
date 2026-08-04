async function isAdmin(sock, chatId, senderId, participantAlt = null) {
    try {
        const participant = participantAlt || senderId;
        
        // Get group metadata
        const groupMetadata = await sock.groupMetadata(chatId);
        
        // Check if sender is admin
        const isSenderAdmin = groupMetadata.participants.some(p => 
            p.id === participant && (p.admin === 'admin' || p.admin === 'superadmin')
        );
        
        // Check if bot is admin
        const botId = sock.user.id.replace(/:\d+/, '');
        const isBotAdmin = groupMetadata.participants.some(p => 
            p.id === botId && (p.admin === 'admin' || p.admin === 'superadmin')
        );
        
        return { isSenderAdmin, isBotAdmin };
    } catch (error) {
        console.error('Error checking admin status:', error);
        return { isSenderAdmin: false, isBotAdmin: false };
    }
}

module.exports = isAdmin;
