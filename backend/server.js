const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Store active users and game sessions
const users = new Map();
const gameSessions = new Map();
let stockPrices = {
    APPL: 150.25,
    GOOG: 2800.50,
    MSFT: 330.75,
    AMZN: 3400.25,
    TSLA: 900.50
};

// WebSocket connection handling
io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User joins a game session
    socket.on('joinSession', (data) => {
        const { username, sessionId } = data;
        users.set(socket.id, { username, sessionId, portfolio: { cash: 10000, stocks: {} } });
        socket.join(sessionId);

        io.to(sessionId).emit('userJoined', {
            username,
            userId: socket.id,
            totalUsers: users.size
        });

        console.log(`${username} joined session ${sessionId}`);
    });

    // Handle buy stock order
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

    // Handle sell stock order
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
            socket.emit('orderError', { message: 'Insufficient stocks to sell' });
        }
    });

    // Broadcast current stock prices
    socket.on('requestPrices', () => {
        socket.emit('priceUpdate', stockPrices);
    });

    // Handle price updates (from server or admin)
    socket.on('updatePrice', (data) => {
        const { symbol, price } = data;
        if (stockPrices[symbol]) {
            stockPrices[symbol] = price;
            io.emit('priceUpdate', stockPrices);
        }
    });

    // Send leaderboard
    socket.on('requestLeaderboard', () => {
        const leaderboard = Array.from(users.values())
            .filter(u => u.sessionId === users.get(socket.id)?.sessionId)
            .map(u => ({
                username: u.username,
                portfolio_value: u.portfolio.cash + Object.keys(u.portfolio.stocks).reduce((sum, stock) => sum + (u.portfolio.stocks[stock] * stockPrices[stock]), 0)
            }))
            .sort((a, b) => b.portfolio_value - a.portfolio_value);

        socket.emit('leaderboardUpdate', leaderboard);
    });

    // User disconnects
    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            io.to(user.sessionId).emit('userLeft', {
                username: user.username,
                userId: socket.id
            });
            users.delete(socket.id);
            console.log(`User disconnected: ${socket.id}`);
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WebSocket server running on http://localhost:${PORT}`);
});