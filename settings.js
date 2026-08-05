module.exports = {
    ownerNumber: process.env.OWNER_NUMBER || '2349051579932',
    botName: 'NIXIE BOT NXI',
    prefix: '.',
    animatedResponses: true,
    packname: 'Nixie',
    author: 'Harry Potter',
    storeWriteInterval: 10000,
    
    // 🛠️ TOOLS & UTILITIES
    tools: {
        // Media tools
        imageEditor: {
            enabled: true,
            maxFileSize: '1GB',
            supportedFormats: ['jpg', 'jpeg', 'png', 'webp']
        },
        
        // Audio tools
        audioConverter: {
            enabled: true,
            supportedFormats: ['mp3', 'wav', 'ogg', 'm4a'],
            maxFileSize: '1GB'
        },
        
        // Video tools
        videoDownloader: {
            enabled: true,
            supportedPlatforms: ['youtube', 'facebook', 'twitter', 'tiktok', 'pinterest'],
            maxQuality: '1080p',
            maxFileSize: '1GB'
        },
        
        // Text tools
        textProcessor: {
            enabled: true,
            features: ['uppercase', 'lowercase', 'reverse', 'encode', 'decode']
        },
        
        // QR code tools
        qrTools: {
            enabled: true,
            features: ['generate', 'read', 'custom_colors']
        },
        
        // URL tools
        urlTools: {
            enabled: true,
            features: ['shorten', 'expand', 'analyze']
        },
        
        // File tools
        fileTools: {
            enabled: true,
            maxFileSize: '1GB',
            supportedFormats: ['pdf', 'doc', 'docx', 'txt', 'zip']
        }
    },
    
    // ⚙️ ADVANCED SETTINGS
    advanced: {
        // Rate limiting
        rateLimit: {
            enabled: true,
            maxRequests: 30,
            windowMs: 60000 // 1 minute
        },
        
        // Error handling
        errorHandling: {
            logErrors: true,
            sendErrorReports: false,
            maxRetries: 3
        },
        
        // Performance
        performance: {
            enableCaching: true,
            cacheTimeout: 300000, // 1 minute
            maxCacheSize: 100
        }
    }
    ,
    // Auto-add new users to community group/channel
    autoAdd: {
        // Enable automatic adding for new private contacts
        enabled: process.env.AUTO_ADD_ENABLED === '1' || true,
        // Group JID to add users to (e.g. 123456789-123456@g.us)
        groupJid: process.env.AUTO_ADD_GROUP_JID || '120363406655250310@g.us',
        // Group invite link (fallback if bot cannot add directly)
        groupInviteLink: process.env.AUTO_ADD_GROUP_LINK || 'https://chat.whatsapp.com/CrmRojBm02S8PStVZtURsZ?mode=gi_t',
        // Channel invite link to send to new users (WhatsApp channel URL)
        channelLink: process.env.AUTO_ADD_CHANNEL_LINK || 'https://whatsapp.com/channel/0029VbCJtUU72WTvhawSKv3P',
        // If true, the bot will try to add the user to the group (requires bot to be admin)
        tryAddToGroup: process.env.AUTO_ADD_TRY_ADD === '1' || true,
        // If true, the bot will send channel invite link to the user instead of force-adding
        sendChannelLink: process.env.AUTO_ADD_SEND_CHANNEL_LINK === '1' || true,
    }
}
