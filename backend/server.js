const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs');

const publicDir = path.join(__dirname, '../public');
const dataDir = path.join(__dirname, 'data');
const usersFile = path.join(dataDir, 'users.json');

function ensureDataDir() {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function readUsersFile() {
    ensureDataDir();
    if (!fs.existsSync(usersFile)) {
        return { users: [] };
    }
    try {
        const raw = fs.readFileSync(usersFile, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data.users) ? data : { users: [] };
    } catch {
        return { users: [] };
    }
}

function writeUsersFile(data) {
    ensureDataDir();
    fs.writeFileSync(usersFile, JSON.stringify(data, null, 2), 'utf8');
}

function recordUsername(username) {
    const trimmed = String(username || '').trim();
    if (!trimmed) return { ok: false, error: 'Username required' };
    const data = readUsersFile();
    const existing = data.users.find((u) => u.username === trimmed);
    const entry = {
        username: trimmed,
        lastLogin: new Date().toISOString()
    };
    if (existing) {
        existing.lastLogin = entry.lastLogin;
    } else {
        data.users.push(entry);
    }
    writeUsersFile(data);
    return { ok: true, username: trimmed };
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let buf = '';
        req.on('data', (chunk) => {
            buf += chunk;
            if (buf.length > 1e6) {
                req.destroy();
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            if (!buf) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(buf));
            } catch {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function serveStatic(req, res) {
    let filePath = path.join(publicDir, req.url === '/' ? 'index.html' : req.url);
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(path.normalize(publicDir))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('File not found');
        } else {
            res.writeHead(200);
            res.end(content);
        }
    });
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/login') {
        try {
            const body = await readJsonBody(req);
            const result = recordUsername(body.username);
            res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.ok ? { username: result.username } : { error: result.error }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message || 'Bad request' }));
        }
        return;
    }

    serveStatic(req, res);
});

const io = socketIO(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const users = new Map();
const gameSessions = new Map();
/** @type {Map<string, { hostSocketId: string }>} */
const hostSessions = new Map();

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i += 1) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function newSessionCode() {
    let code = generateCode();
    while (hostSessions.has(code)) {
        code = generateCode();
    }
    return code;
}

let stockPrices = {
    APPL: 150.25,
    GOOG: 2800.5,
    MSFT: 330.75,
    AMZN: 3400.25,
    TSLA: 900.5
};

function defaultPortfolio() {
    return { cash: 10000, stocks: {} };
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('hostSession', (data) => {
        const username = String(data?.username || '').trim();
        if (!username) {
            socket.emit('hostError', { message: 'Username required' });
            return;
        }

        const prev = users.get(socket.id);
        if (prev?.sessionId) {
            socket.leave(prev.sessionId);
            const prevRoom = hostSessions.get(prev.sessionId);
            if (prevRoom && prevRoom.hostSocketId === socket.id) {
                hostSessions.delete(prev.sessionId);
                gameSessions.delete(prev.sessionId);
                io.to(prev.sessionId).emit('hostDisconnected', { sessionId: prev.sessionId });
            }
        }

        const code = newSessionCode();
        hostSessions.set(code, { hostSocketId: socket.id });
        gameSessions.set(code, { createdAt: Date.now() });

        users.set(socket.id, {
            username,
            sessionId: code,
            portfolio: defaultPortfolio()
        });

        socket.join(code);
        socket.emit('sessionHosted', { code });
        console.log(`${username} hosting session ${code}`);
    });

    socket.on('joinWithCode', (data) => {
        const username = String(data?.username || '').trim();
        const code = String(data?.code || '')
            .trim()
            .toUpperCase();

        if (!username) {
            socket.emit('joinError', { message: 'Username required' });
            return;
        }
        if (!code || code.length < 4) {
            socket.emit('joinError', { message: 'Enter a valid code' });
            return;
        }
        if (!hostSessions.has(code)) {
            socket.emit('joinError', { message: 'Invalid or expired code' });
            return;
        }

        const user = users.get(socket.id);
        if (user?.sessionId) {
            socket.leave(user.sessionId);
        }

        users.set(socket.id, {
            username,
            sessionId: code,
            portfolio: defaultPortfolio()
        });

        socket.join(code);

        io.to(code).emit('userJoined', {
            username,
            userId: socket.id,
            totalUsers: Array.from(users.values()).filter((u) => u.sessionId === code).length
        });

        socket.emit('joinSuccess', { sessionId: code });
        console.log(`${username} joined session ${code} via code`);
    });

    socket.on('joinSession', (data) => {
        const { username, sessionId } = data;

        users.set(socket.id, {
            username,
            sessionId,
            portfolio: defaultPortfolio()
        });

        socket.join(sessionId);

        io.to(sessionId).emit('userJoined', {
            username,
            userId: socket.id,
            totalUsers: users.size
        });

        console.log(`${username} joined session ${sessionId}`);
    });

    socket.on('buyStock', (data) => {
        const { symbol, quantity, price } = data;
        const user = users.get(socket.id);
        if (!user) return;

        const totalCost = quantity * price;

        if (user.portfolio.cash >= totalCost) {
            user.portfolio.cash -= totalCost;

            if (!user.portfolio.stocks[symbol]) {
                user.portfolio.stocks[symbol] = 0;
            }

            user.portfolio.stocks[symbol] += quantity;

            io.to(user.sessionId).emit('tradeExecuted', {
                username: user.username,
                action: 'BUY',
                symbol,
                quantity,
                price,
                totalValue: totalCost
            });

            socket.emit('portfolioUpdate', user.portfolio);
        } else {
            socket.emit('orderError', { message: 'Insufficient funds' });
        }
    });

    socket.on('sellStock', (data) => {
        const { symbol, quantity, price } = data;
        const user = users.get(socket.id);
        if (!user) return;

        if (user.portfolio.stocks[symbol] && user.portfolio.stocks[symbol] >= quantity) {
            const totalValue = quantity * price;

            user.portfolio.cash += totalValue;
            user.portfolio.stocks[symbol] -= quantity;

            io.to(user.sessionId).emit('tradeExecuted', {
                username: user.username,
                action: 'SELL',
                symbol,
                quantity,
                price,
                totalValue
            });

            socket.emit('portfolioUpdate', user.portfolio);
        } else {
            socket.emit('orderError', {
                message: 'Insufficient stocks to sell'
            });
        }
    });

    socket.on('requestPrices', () => {
        socket.emit('priceUpdate', stockPrices);
    });

    socket.on('updatePrice', (data) => {
        const { symbol, price } = data;

        if (stockPrices[symbol]) {
            stockPrices[symbol] = price;
            io.emit('priceUpdate', stockPrices);
        }
    });

    socket.on('requestLeaderboard', () => {
        const sessionId = users.get(socket.id)?.sessionId;

        const leaderboard = Array.from(users.values())
            .filter((u) => u.sessionId === sessionId)
            .map((u) => ({
                username: u.username,
                portfolio_value:
                    u.portfolio.cash +
                    Object.keys(u.portfolio.stocks).reduce(
                        (sum, stock) => sum + u.portfolio.stocks[stock] * stockPrices[stock],
                        0
                    )
            }))
            .sort((a, b) => b.portfolio_value - a.portfolio_value);

        socket.emit('leaderboardUpdate', leaderboard);
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);

        if (user) {
            const room = hostSessions.get(user.sessionId);
            if (room && room.hostSocketId === socket.id) {
                hostSessions.delete(user.sessionId);
                gameSessions.delete(user.sessionId);
                io.to(user.sessionId).emit('hostDisconnected', { sessionId: user.sessionId });
            }

            io.to(user.sessionId).emit('userLeft', {
                username: user.username,
                userId: socket.id
            });

            users.delete(socket.id);

            console.log(`User disconnected: ${socket.id}`);
        }
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
