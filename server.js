
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configs
const BOT_TOKEN = '8746177274:AAFcEAj_F8p-rtHGOcWegcp_DQ4_cS1bAzU';
const CHANNEL_USERNAME = '@task_and_earn_online'; 

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup (SQLite)
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('Database connection error:', err);
    else console.log('Connected to SQLite Database.');
});

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id TEXT PRIMARY KEY,
        balance REAL DEFAULT 0.00,
        spins INTEGER DEFAULT 1,
        referred_by TEXT,
        is_joined INTEGER DEFAULT 0
    )`);
});

// Helper function to check if user joined Telegram Channel
async function checkTelegramMembership(userId) {
    try {
        const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember?chat_id=${CHANNEL_USERNAME}&user_id=${userId}`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.ok) {
            const status = data.result.status;
            // member, administrator, or creator means they are in the channel
            return ['member', 'administrator', 'creator'].includes(status);
        }
        return false;
    } catch (error) {
        console.error('Error verifying Telegram membership:', error);
        return false;
    }
}

// Endpoint 1: User Login & Register with Invite Logic
app.post('/api/auth', async (req, res) => {
    const { telegramId, referrerId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'Telegram ID is required' });

    // 1. Real-time check Telegram status
    const isJoined = await checkTelegramMembership(telegramId);
    
    db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });

        if (user) {
            // User exists, update status
            db.run('UPDATE users SET is_joined = ? WHERE telegram_id = ?', [isJoined ? 1 : 0, telegramId]);
            return res.json({ 
                telegram_id: telegramId, 
                balance: user.balance, 
                spins: user.spins, 
                is_joined: isJoined 
            });
        } else {
            // New User Registration
            const initialSpins = 1;
            let finalReferredBy = null;

            // Simple self-refer check
            if (referrerId && referrerId !== telegramId) {
                finalReferredBy = referrerId;
            }

            db.run(
                'INSERT INTO users (telegram_id, balance, spins, referred_by, is_joined) VALUES (?, 0.00, ?, ?, ?)',
                [telegramId, initialSpins, finalReferredBy, isJoined ? 1 : 0],
                function(err) {
                    if (err) return res.status(500).json({ error: err.message });
                    
                    // If referred by someone, give them +1 Spin on real join
                    if (finalReferredBy && isJoined) {
                        db.run('UPDATE users SET spins = spins + 1 WHERE telegram_id = ?', [finalReferredBy]);
                    }

                    res.json({ 
                        telegram_id: telegramId, 
                        balance: 0.00, 
                        spins: initialSpins, 
                        is_joined: isJoined 
                    });
                }
            );
        }
    });
});

// Endpoint 2: Safe Server-Side Spin Logic
// Yahan fixed rewards hain ₹ wale aur fixed mathematically weighted probability hai taki kam paise hi milein!
app.post('/api/spin', async (req, res) => {
    const { telegramId } = req.body;
    
    // Check if user is verified member first
    const isJoined = await checkTelegramMembership(telegramId);
    if (!isJoined) {
        return res.status(403).json({ error: 'Access Denied. You are not a channel member!' });
    }

    db.get('SELECT spins, balance FROM users WHERE telegram_id = ?', [telegramId], (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'User not found' });
        if (user.spins <= 0) return res.status(400).json({ error: 'No spins left' });

        // Wheel visual options index:
        // [Index 0: ₹0.05, Index 1: ₹1.00, Index 2: ₹0.10, Index 3: ₹2.00, Index 4: ₹0.15, Index 5: ₹5.00]
        // Safe algorithm: High amounts (₹1, ₹2, ₹5) are shown on wheel, but probability (chance) is almost 0%.
        // 98% times landing on ₹0.05, ₹0.10, or ₹0.15.
        
        const roll = Math.random() * 100;
        let selectedIndex = 0; // Default ₹0.05
        let prizeMoney = 0.05;

        if (roll < 45) {
            // 45% chance for ₹0.05
            selectedIndex = 0;
            prizeMoney = 0.05;
        } else if (roll < 85) {
            // 40% chance for ₹0.10
            selectedIndex = 2;
            prizeMoney = 0.10;
        } else if (roll < 98) {
            // 13% chance for ₹0.15
            selectedIndex = 4;
            prizeMoney = 0.15;
        } else if (roll < 99) {
            // 1% super rare chance for ₹1.00
            selectedIndex = 1;
            prizeMoney = 1.00;
        } else {
            // 1% super rare chance for ₹2.00
            selectedIndex = 3;
            prizeMoney = 2.00;
        }

        const newSpins = user.spins - 1;
        const newBalance = user.balance + prizeMoney;

        db.run('UPDATE users SET spins = ?, balance = ? WHERE telegram_id = ?', [newSpins, newBalance, telegramId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            
            res.json({
                success: true,
                targetIndex: selectedIndex, // Frontend listens to this index to spin properly
                prize: prizeMoney,
                newBalance: newBalance,
                newSpins: newSpins
            });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
                      
