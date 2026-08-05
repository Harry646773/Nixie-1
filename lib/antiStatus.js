const fs = require('fs');
const path = require('path');
const isAdmin = require('./isAdmin');

const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'antiStatusSettings.json');
const WARNINGS_PATH = path.join(__dirname, '..', 'data', 'antiStatusWarnings.json');

if (!fs.existsSync(SETTINGS_PATH)) fs.writeFileSync(SETTINGS_PATH, JSON.stringify({}));
if (!fs.existsSync(WARNINGS_PATH)) fs.writeFileSync(WARNINGS_PATH, JSON.stringify({}));

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8') || '{}');
  } catch (e) {
    console.error('antistatus: failed to load settings', e);
    return {};
  }
}

function saveSettings(v) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(v, null, 2));
    return true;
  } catch (e) {
    console.error('antistatus: failed to save settings', e);
    return false;
  }
}

function loadWarnings() {
  try {
    return JSON.parse(fs.readFileSync(WARNINGS_PATH, 'utf8') || '{}');
  } catch (e) {
    console.error('antistatus: failed to load warnings', e);
    return {};
  }
}

function saveWarnings(v) {
  try {
    fs.writeFileSync(WARNINGS_PATH, JSON.stringify(v, null, 2));
    return true;
  } catch (e) {
    console.error('antistatus: failed to save warnings', e);
    return false;
  }
}

function extractStatusContent(msg) {
  try {
    const m = msg && (msg.messages && msg.messages[0]) ? msg.messages[0] : msg;
    const message = m && m.message ? m.message : m;

    const text = (message && (message.conversation ||
      (message.extendedTextMessage && message.extendedTextMessage.text) ||
      (message.imageMessage && message.imageMessage.caption) ||
      (message.videoMessage && message.videoMessage.caption) ||
      (message.documentMessage && message.documentMessage.caption))) || '';

    const mentioned = (message && message.extendedTextMessage && message.extendedTextMessage.contextInfo && message.extendedTextMessage.contextInfo.mentionedJid) || (message && message.contextInfo && message.contextInfo.mentionedJid) || [];

    return { text: String(text), mentioned: Array.isArray(mentioned) ? mentioned : [] };
  } catch (e) {
    return { text: '', mentioned: [] };
  }
}

async function checkStatusForViolations(sock, msg) {
  try {
    const sender = msg?.key?.participant || msg?.key?.remoteJid || '';
    if (!sender) return;
    const { text, mentioned } = extractStatusContent(msg);
    const lower = (text || '').toLowerCase();

    const hasAtAll = /@all|@everyone|@here/i.test(text);
    const hasMentions = Array.isArray(mentioned) && mentioned.length > 0;
    const hasMultipleMentions = Array.isArray(mentioned) && mentioned.length >= 2;
    const hasManualAtPattern = /@\d{6,}/.test(text);

    if (!(hasAtAll || hasMentions || hasMultipleMentions || hasManualAtPattern)) {
      return;
    }

    const settings = loadSettings();
    const warnings = loadWarnings();

    for (const [groupId, cfg] of Object.entries(settings)) {
      try {
        if (!cfg || !cfg.enabled) continue;

        let metadata;
        try {
          metadata = await sock.groupMetadata(groupId);
        } catch (err) {
          continue;
        }

        const participants = (metadata && metadata.participants) || [];
        const isMember = participants.some(p => {
          const pid = p.id || p.lid || '';
          const phone = (pid.includes(':') ? pid.split(':')[0] : (pid.includes('@') ? pid.split('@')[0] : pid));
          const senderPhone = sender.includes(':') ? sender.split(':')[0] : (sender.includes('@') ? sender.split('@')[0] : sender);
          return phone === senderPhone || pid === sender || pid === sender.split('@')[0];
        });

        if (!isMember) continue;

        const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, groupId, sender);
        if (isSenderAdmin) {
          console.log(`antistatus: sender ${sender} is admin in ${groupId}; skipping`);
          continue;
        }

        warnings[groupId] = warnings[groupId] || {};
        warnings[groupId][sender] = (warnings[groupId][sender] || 0) + 1;
        const userWarns = warnings[groupId][sender];
        saveWarnings(warnings);

        const warnText = `⚠️ @${sender.split('@')[0]}, You are warned ${userWarns}/3. Please stop tagging the group.`;
        try {
          await sock.sendMessage(groupId, { text: warnText, contextInfo: { mentionedJid: [sender] } });
        } catch (e) {
          console.error('antistatus: failed to send warning message in group', e);
        }

        if (cfg.notifyAdmins) {
          try {
            const adminJids = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id || p.lid).filter(Boolean);
            if (adminJids.length > 0) {
              const adminMsg = `📣 Admins: @${sender.split('@')[0]} posted a status tag in the group and has received warning from Nixie ${userWarns}/3.`;
              await sock.sendMessage(groupId, { text: adminMsg, contextInfo: { mentionedJid: adminJids } });
            }
          } catch (e) {
            console.error('antistatus: failed notifying admins in group', e);
          }
        }

        const threshold = cfg.autoKickCount || 3;
        if (userWarns >= threshold) {
          if (isBotAdmin) {
            try {
              await sock.groupParticipantsUpdate(groupId, [sender], 'remove');
              const kickedMsg = `⛔ @${sender.split('@')[0]} has been kicked from the group after ${userWarns} warnings.`;
              await sock.sendMessage(groupId, { text: kickedMsg, contextInfo: { mentionedJid: [sender] } });

              if (cfg.logGroupJid) {
                try {
                  await sock.sendMessage(cfg.logGroupJid, { text: `Log: Removed ${sender} from ${groupId} after ${userWarns} warnings by Nixie for tagging the group.` });
                } catch (logErr) {
                  console.error('antistatus: failed to send log to logGroupJid', logErr);
                }
              }

              warnings[groupId][sender] = 0;
              saveWarnings(warnings);
            } catch (kickErr) {
              console.error('antistatus: failed to kick user', kickErr);
            }
          } else {
            try {
              await sock.sendMessage(groupId, { text: `⚠️ I would have removed @${sender.split('@')[0]} for status tagging, but Nixie is not admin.`, contextInfo: { mentionedJid: [sender] } });
            } catch (e) {}

            if (cfg.logGroupJid) {
              try {
                await sock.sendMessage(cfg.logGroupJid, { text: `Nixie Would remove ${sender} from ${groupId} after ${userWarns} warnings, but Nixie lacks admin privileges.` });
              } catch (e) {}
            }
          }
        }

        try {
          if (!cfg.logGroupJid && cfg.logAttempts) {
            const LPATH = path.join(__dirname, '..', 'data', 'antiStatusAttempts.log');
            const entry = `${new Date().toISOString()} | ${groupId} | ${sender} | warnings=${userWarns} | text="${text.replace(/\n/g, ' ')}"\n`;
            fs.appendFileSync(LPATH, entry);
          }
        } catch (e) {
          console.error('antistatus: failed to append attempt log', e);
        }
      } catch (grpErr) {
        console.error('antistatus: error processing group', grpErr);
      }
    }
  } catch (error) {
    console.error('antistatus: error checking status for violations', error);
  }
}

async function antistatusCommand(sock, chatId, message, args) {
  try {
    if (!chatId.endsWith('@g.us')) {
      await sock.sendMessage(chatId, { text: '⚠️ This command can only be used in groups.' }, { quoted: message });
      return;
    }

    const sender = message.key.participant || message.key.remoteJid;
    const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, sender);
    if (!isSenderAdmin && !message.key.fromMe) {
      await sock.sendMessage(chatId, { text: '❌ Only group admins can manage anti-status.' }, { quoted: message });
      return;
    }

    let settings = loadSettings();
    const cfg = settings[chatId] || { enabled: false, notifyAdmins: false, autoKickCount: 3, mentionThreshold: 2, logGroupJid: null, logAttempts: false };

    const cmd = (args && args[0]) ? args[0].toLowerCase() : 'status';

    if (cmd === 'on') {
      cfg.enabled = true;
      settings[chatId] = cfg;
      saveSettings(settings);
      await sock.sendMessage(chatId, { text: '✅ Anti-status tagging is ON for this group.' }, { quoted: message });
      return;
    }

    if (cmd === 'off') {
      cfg.enabled = false;
      settings[chatId] = cfg;
      saveSettings(settings);
      await sock.sendMessage(chatId, { text: '❌ Anti-status tagging is OFF for this group.' }, { quoted: message });
      return;
    }

    if (cmd === 'status') {
      const enabledText = cfg.enabled ? 'enabled' : 'disabled';
      await sock.sendMessage(chatId, { text: `🔍 Anti-status is currently *${enabledText}* for this group.\nNotify admins: ${cfg.notifyAdmins ? '✅' : '❌'}\nAuto-kick at: ${cfg.autoKickCount} warnings\nMention threshold: ${cfg.mentionThreshold || 2}\nLog group: ${cfg.logGroupJid || 'not set'}` }, { quoted: message });
      return;
    }

    if (cmd === 'notify') {
      const sub = (args && args[1]) ? args[1].toLowerCase() : null;
      if (!sub || (sub !== 'on' && sub !== 'off')) {
        await sock.sendMessage(chatId, { text: 'Usage: antistatus notify on|off' }, { quoted: message });
        return;
      }
      cfg.notifyAdmins = sub === 'on';
      settings[chatId] = cfg;
      saveSettings(settings);
      await sock.sendMessage(chatId, { text: `Notify admins set to ${cfg.notifyAdmins ? 'on' : 'off'}` }, { quoted: message });
      return;
    }

    if (cmd === 'setlog') {
      const jid = (args && args[1]) ? args[1] : null;
      if (!jid) {
        await sock.sendMessage(chatId, { text: 'Usage: antistatus setlog <admin-group-jid>' }, { quoted: message });
        return;
      }
      cfg.logGroupJid = jid;
      settings[chatId] = cfg;
      saveSettings(settings);
      await sock.sendMessage(chatId, { text: `Log group set to ${jid}` }, { quoted: message });
      return;
    }

    if (cmd === 'setkick') {
      const n = parseInt((args && args[1]) ? args[1] : '', 10);
      if (!n || n < 1 || n > 10) {
        await sock.sendMessage(chatId, { text: 'Usage: antistatus setkick <num> (1-10)' }, { quoted: message });
        return;
      }
      cfg.autoKickCount = n;
      settings[chatId] = cfg;
      saveSettings(settings);
      await sock.sendMessage(chatId, { text: `Auto-kick threshold set to ${n} warnings.` }, { quoted: message });
      return;
    }

    if (cmd === 'setmention') {
      const n = parseInt((args && args[1]) ? args[1] : '', 10);
      if (!n || n < 1 || n > 50) {
        await sock.sendMessage(chatId, { text: 'Usage: antistatus setmention <num> (1-50)' }, { quoted: message });
        return;
      }
      cfg.mentionThreshold = n;
      settings[chatId] = cfg;
      saveSettings(settings);
      await sock.sendMessage(chatId, { text: `Mention threshold set to ${n} mentions for anti-status in this group.` }, { quoted: message });
      return;
    }

    if (cmd === 'reset') {
      let warnings = loadWarnings();
      if (warnings[chatId]) delete warnings[chatId];
      saveWarnings(warnings);
      await sock.sendMessage(chatId, { text: '✅ Warnings for this group have been reset.' }, { quoted: message });
      return;
    }

    await sock.sendMessage(chatId, { text: 'AntiStatus usage:\n%antistatus on|off|status|notify on|notify off|setlog <jid>|setkick <n>|reset' }, { quoted: message });
  } catch (error) {
    console.error('Error in antistatusCommand:', error);
    await sock.sendMessage(chatId, { text: '❌ Error executing anti-status command.' }, { quoted: message });
  }
}

async function checkMessageForViolations(sock, msg) {
  try {
    const chatId = msg.key.remoteJid;
    if (!chatId || !chatId.endsWith('@g.us')) return;

    const sender = msg.key.participant || msg.key.remoteJid;
    if (!sender) return;
    if (msg.key.fromMe) return;

    const settings = loadSettings();
    const cfg = settings[chatId];
    if (!cfg || !cfg.enabled) return;

    const messageObj = msg.message || msg;
    const text = (messageObj.conversation || (messageObj.extendedTextMessage && messageObj.extendedTextMessage.text) || (messageObj.imageMessage && messageObj.imageMessage.caption) || (messageObj.videoMessage && messageObj.videoMessage.caption) || '') || '';
    const mentioned = (messageObj.extendedTextMessage && messageObj.extendedTextMessage.contextInfo && messageObj.extendedTextMessage.contextInfo.mentionedJid) || (messageObj.contextInfo && messageObj.contextInfo.mentionedJid) || [];

    const hasAtAll = /@all|@everyone|@here/i.test(text);
    const hasMultipleMentions = Array.isArray(mentioned) && mentioned.length >= (cfg.mentionThreshold || 2);

    if (!(hasAtAll || hasMultipleMentions)) return;

    const { isSenderAdmin, isBotAdmin } = await isAdmin(sock, chatId, sender);
    if (isSenderAdmin) return;

    try {
      await sock.sendMessage(chatId, { delete: msg.key });
      console.log('antistatus: deleted offending message from', sender, 'in', chatId);
    } catch (delErr) {
      console.error('antistatus: failed to delete offending message', delErr);
    }

    const warnings = loadWarnings();
    warnings[chatId] = warnings[chatId] || {};
    warnings[chatId][sender] = (warnings[chatId][sender] || 0) + 1;
    const userWarns = warnings[chatId][sender];
    saveWarnings(warnings);

    try {
      await sock.sendMessage(chatId, { text: `⚠️ @${sender.split('@')[0]}, tagging many members is not allowed. This is warning ${userWarns}/${cfg.autoKickCount || 3}.`, contextInfo: { mentionedJid: [sender] } });
    } catch (e) {
      console.error('antistatus: failed to send warning message in group', e);
    }

    if (cfg.notifyAdmins) {
      try {
        const metadata = await sock.groupMetadata(chatId);
        const participants = metadata.participants || [];
        const adminJids = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id || p.lid).filter(Boolean);
        if (adminJids.length > 0) {
          const adminMsg = `📣 Admins: @${sender.split('@')[0]} mentioned Group and has been warned ${userWarns}/${cfg.autoKickCount || 3}.`;
          await sock.sendMessage(chatId, { text: adminMsg, contextInfo: { mentionedJid: adminJids } });
        }
      } catch (e) {
        console.error('antistatus: failed notifying admins in group', e);
      }
    }

    const threshold = cfg.autoKickCount || 3;
    if (userWarns >= threshold) {
      if (isBotAdmin) {
        try {
          await sock.groupParticipantsUpdate(chatId, [sender], 'remove');
          const kickedMsg = `⛔ @${sender.split('@')[0]} has been kicked from the group after ${userWarns} warnings.`;
          await sock.sendMessage(chatId, { text: kickedMsg, contextInfo: { mentionedJid: [sender] } });

          if (cfg.logGroupJid) {
            try { await sock.sendMessage(cfg.logGroupJid, { text: `Log: Kicked ${sender} from ${chatId} after ${userWarns} warnings for mass-mentioning.` }); } catch (logErr) { console.error('antistatus: failed to send log to logGroupJid', logErr); }
          }

          warnings[chatId][sender] = 0;
          saveWarnings(warnings);
        } catch (kickErr) {
          console.error('antistatus: failed to kick user', kickErr);
        }
      } else {
        try { await sock.sendMessage(chatId, { text: `⚠️ Nixie would kick @${sender.split('@')[0]} for repeated mass-mentioning, but Nixie is not admin.`, contextInfo: { mentionedJid: [sender] } }); } catch (e) {}
        if (cfg.logGroupJid) {
          try { await sock.sendMessage(cfg.logGroupJid, { text: `Log: Nixie would remove ${sender} from ${chatId} after ${userWarns} warnings, but Nixie lacks admin privileges.` }); } catch (e) {}
        }
      }
    }
  } catch (error) {
    console.error('antistatus: error checking message for violations', error);
  }
}

module.exports = {
  antistatusCommand,
  checkStatusForViolations,
  checkMessageForViolations,
  extractStatusContent,
};
