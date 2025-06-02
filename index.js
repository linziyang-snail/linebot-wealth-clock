const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { MessagingApiClient, WebhookRequestHandler } = require('@line/bot-sdk-openapi');

dotenv.config();

const app = express();
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'userData.json');

function loadUserData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE));
}

function saveUserData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function getCryptoPrices(symbols = []) {
    const ids = symbols.join('%2C');
    const response = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`
    );
    return response.data;
}

function cryptoSymbolToId(symbol) {
    const map = { btc: 'bitcoin', eth: 'ethereum', usdt: 'tether' };
    return map[symbol.toLowerCase()] || null;
}

const client = new MessagingApiClient({
    accessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

const handler = new WebhookRequestHandler({
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    onMessage: async (event) => {
        if (event.message.type !== 'text') return;

        const userId = event.source.userId;
        const msg = event.message.text.trim();
        const [cmd, symbol, amount] = msg.split(' ');

        const userData = loadUserData();
        userData[userId] = userData[userId] || { goal: 0, assets: {} };

        if (cmd === '/add' && symbol && amount) {
            userData[userId].assets[symbol.toLowerCase()] = parseFloat(amount);
            saveUserData(userData);
            await client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: `✅ 已新增 ${symbol.toUpperCase()} 數量：${amount}` }],
            });
        } else if (cmd === '/setgoal' && symbol) {
            userData[userId].goal = parseInt(symbol);
            saveUserData(userData);
            await client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: `🎯 已設定財富目標為：${symbol} 元` }],
            });
        } else if (cmd === '/status') {
            const assets = userData[userId].assets;
            const symbols = Object.keys(assets);
            const ids = symbols.map(cryptoSymbolToId).filter(Boolean);
            const prices = await getCryptoPrices(ids);

            let totalUSD = 0;
            let detail = '';

            for (const s of symbols) {
                const id = cryptoSymbolToId(s);
                if (!prices[id]) continue;
                const price = prices[id].usd;
                const value = price * assets[s];
                totalUSD += value;
                detail += `${s.toUpperCase()}：${assets[s]} 顆 x $${price} = $${value.toFixed(2)}\n`;
            }

            const totalTWD = totalUSD * 32;
            const goal = userData[userId].goal || 0;
            const percent = goal > 0 ? ((totalTWD / goal) * 100).toFixed(2) : 'N/A';

            const text =
                `📊 幣圈資產總覽：\n\n` +
                `${detail}--------------------------\n` +
                `💰 資產總值：$${totalUSD.toFixed(2)}（約 NT$${totalTWD.toLocaleString()}）\n` +
                `🎯 目標進度：${percent}%`;

            await client.replyMessage({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text }],
            });
        } else {
            await client.replyMessage({
                replyToken: event.replyToken,
                messages: [
                    {
                        type: 'text',
                        text: `📘 指令說明：\n/add [幣種] [數量]\n/setgoal [目標金額]\n/status 查看資產總值與進度`,
                    },
                ],
            });
        }
    },
});

app.post('/webhook', handler); // handler 是 Express middleware

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ LINE bot is running on port ${PORT}`);
});