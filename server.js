const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');

const app = express();
const PORT = process.env.PORT || 3000;

// Configs from Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME; // @task_and_earn_online
const WEBSITE_URL = process.env.WEBSITE_URL; // e.g., https://your-app.onrender.com

// Initialize Bot
const bot = new Telegraf(BOT_TOKEN);

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to SQLite Database.');
});

// Database schema configuration
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        balance REAL DEFAULT 0.00,
        spins INTEGER DEFAULT 1,
        referred_by TEXT,
        is_joined INTEGER DEFAULT 0
    )`);
});

// Helper: Check Telegram Membership
async function checkTelegramMembership(userId) {
    if (!userId || userId.startsWith('User_')) return false; // Simulation user bypass
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${CHANNEL_USERNAME}&user_id=${userId}`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.ok) {
            const status = data.result.status;
            return ['member', 'administrator', 'creator'].includes(status);
        }
        return false;
    } catch (error) {
        return false;
    }
}

// ================= TELEGRAM BOT LOGIC =================

bot.start(async (ctx) => {
    const tgUser = ctx.from.id.toString();
    const startPayload = ctx.payload; // For referral links or verification redirects
    
    const isJoined = await checkTelegramMembership(tgUser);

    db.get('SELECT * FROM users WHERE telegram_id = ?', [tgUser], (err, user) => {
        if (err) return;

        if (!user) {
            let referrerId = null;
            // Check if user came via referral link: start=ref_USERID
            if (startPayload && startPayload.startsWith('ref_')) {
                referrerId = startPayload.replace('ref_', '');
                if (referrerId === tgUser) referrerId = null; // Self-referral protection
            }

            db.run(
                'INSERT INTO users (telegram_id, balance, spins, referred_by, is_joined) VALUES (?, 0.00, 1, ?, ?)',
                [tgUser, referrerId, isJoined ? 1 : 0],
                function(err) {
                    if (!err && referrerId && isJoined) {
                        // Reward the referrer with +1 spin immediately
                        db.run('UPDATE users SET spins = spins + 1 WHERE telegram_id = ?', [referrerId]);
                    }
                }
            );
        } else {
            db.run('UPDATE users SET is_joined = ? WHERE telegram_id = ?', [isJoined ? 1 : 0, tgUser]);
        }
    });

    if (isJoined) {
        return ctx.reply(
            `🎉 Welcome back to TASK AND EARN!\n\nYour account is fully verified. Click the button below to open the 3D Spin Wheel and earn real money!`,
            Markup.inlineKeyboard([
                [Markup.button.webApp('🎡 Open Spin App', `${WEBSITE_URL}/?telegram_id=${tgUser}`)]
            ])
        );
    } else {
        // Build dynamic deep link back to start with payload to preserve invite chain
        let startParam = `verify_${tgUser}`;
        if (startPayload && startPayload.startsWith('ref_')) {
            startParam = startPayload; // Keep referral payload intact
        }
        
        return ctx.reply(
            `⚠️ Access Denied!\n\nYou must join our official Telegram Channel to use this app.\n\n1. Join: ${CHANNEL_USERNAME}\n2. After joining, click "Verify & Start" below!`,
            Markup.inlineKeyboard([
                [Markup.button.url('📢 Join Channel', `https://t.me/${CHANNEL_USERNAME.replace('@', '')}`)],
                [Markup.button.callback('✅ Verify & Start', `verify_user:${startParam}`)]
            ])
        );
    }
});

// Bot callback verification with dynamic parameter handling
bot.action(/verify_user:(.+)/, async (ctx) => {
    const tgUser = ctx.from.id.toString();
    const payload = ctx.match[1];
    const isJoined = await checkTelegramMembership(tgUser);

    if (isJoined) {
        db.get('SELECT * FROM users WHERE telegram_id = ?', [tgUser], (err, user) => {
            if (!user) {
                let referrerId = null;
                if (payload && payload.startsWith('ref_')) {
                    referrerId = payload.replace('ref_', '');
                    if (referrerId === tgUser) referrerId = null;
                }
                db.run(
                    'INSERT INTO users (telegram_id, balance, spins, referred_by, is_joined) VALUES (?, 0.00, 1, ?, 1)',
                    [tgUser, referrerId],
                    function(err) {
                        if (!err && referrerId) {
                            db.run('UPDATE users SET spins = spins + 1 WHERE telegram_id = ?', [referrerId]);
                        }
                    }
                );
            } else {
                db.run('UPDATE users SET is_joined = 1 WHERE telegram_id = ?', [tgUser]);
            }
        });

        await ctx.answerCbQuery('Success! Account Verified. 🎉');
        return ctx.editMessageText(
            `🎉 Verification Successful!\n\nYou can now open the spin wheel app and start earning.`,
            Markup.inlineKeyboard([
                [Markup.button.webApp('🎡 Open Spin App', `${WEBSITE_URL}/?telegram_id=${tgUser}`)]
            ])
        );
    } else {
        return ctx.answerCbQuery('❌ You have not joined the channel yet! Please join and try again.', { show_alert: true });
    }
});

// Launch Telegram Bot
bot.launch().then(() => console.log('Telegram Bot is running...')).catch(err => console.error("Bot launch failed:", err));

// ================= WEB API ENDPOINTS =================

// Secure auth route that strictly validates and registers user session
app.post('/api/auth', async (req, res) => {
    const { telegramId, referrerId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Telegram ID is required' });

    const isJoined = await checkTelegramMembership(telegramId);
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });

        if (user) {
            // User exists, just update their channel joining status and return data
            db.run('UPDATE users SET is_joined = ? WHERE telegram_id = ?', [isJoined ? 1 : 0, telegramId], (updErr) => {
                return res.json({ 
                    telegram_id: telegramId, 
                    balance: user.balance, 
                    spins: user.spins, 
                    is_joined: isJoined ? true : false 
                });
            });
        } else {
            // New web visitor - Register them securely
            let finalReferredBy = null;
            if (referrerId && referrerId !== telegramId && !referrerId.startsWith('User_')) {
                finalReferredBy = referrerId;
            }

            db.run(
                'INSERT INTO users (telegram_id, balance, spins, referred_by, is_joined) VALUES (?, 0.00, 1, ?, ?)',
                [telegramId, finalReferredBy, isJoined ? 1 : 0],
                function(insErr) {
                    if (insErr) return res.status(500).json({ error: insErr.message });
                    
                    // Award referrer only if the newly registered user has actually joined the channel
                    if (finalReferredBy && isJoined) {
                        db.run('UPDATE users SET spins = spins + 1 WHERE telegram_id = ?', [finalReferredBy]);
                    }

                    return res.json({ 
                        telegram_id: telegramId, 
                        balance: 0.00, 
                        spins: 1, 
                        is_joined: isJoined ? true : false 
                    });
                }
            );
        }
    });
});

app.post('/api/spin', async (req, res) => {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Telegram ID is required' });
    
    const isJoined = await checkTelegramMembership(telegramId);
    if (!isJoined) {
        return res.status(403).json({ error: 'Access Denied. Join channel first!' });
    }

    db.get('SELECT spins, balance FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'User not found' });
        if (user.spins <= 0) return res.status(400).json({ error: 'No spins left' });
        
        // Spin logic calculations
        const roll = Math.random() * 100;
        let selectedIndex = 0; 
        let prizeMoney = 0.05;

        if (roll < 45) {
            selectedIndex = 0;
            prizeMoney = 0.05;
        } else if (roll < 85) {
            selectedIndex = 2;
            prizeMoney = 0.10;
        } else if (roll < 98) {
            selectedIndex = 4;
            prizeMoney = 0.15;
        } else if (roll < 99) {
            selectedIndex = 1;
            prizeMoney = 1.00;
        } else {
            selectedIndex = 3;
            prizeMoney = 2.00;
        }

        const newSpins = user.spins - 1;
        const newBalance = user.balance + prizeMoney;

        db.run('UPDATE users SET spins = ?, balance = ? WHERE telegram_id = ?', [newSpins, newBalance, telegramId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            res.json({
                success: true,
                targetIndex: selectedIndex, 
                prize: prizeMoney,
                newBalance: newBalance,
                newSpins: newSpins
            });
        });
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Web Server is running on port ${PORT}`);
});
               
