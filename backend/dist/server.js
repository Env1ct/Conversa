"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const dotenv_1 = __importDefault(require("dotenv"));
const auth_1 = __importDefault(require("./routes/auth"));
const chat_1 = __importDefault(require("./routes/chat"));
const dashboard_1 = __importDefault(require("./routes/dashboard"));
const widget_1 = __importDefault(require("./routes/widget"));
const webhooks_1 = __importDefault(require("./routes/webhooks"));
const database_1 = require("./services/database");
const websocket_1 = require("./services/websocket");
dotenv_1.default.config();
const app = (0, express_1.default)();
const server = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
        credentials: true
    }
});
const databaseService = new database_1.DatabaseService();
const websocketService = new websocket_1.WebSocketService(io);
app.use((0, helmet_1.default)({
    contentSecurityPolicy: false,
}));
app.use((0, cors_1.default)({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true
}));
const limiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Demasiadas solicitudes desde esta IP'
});
app.use('/api/', limiter);
app.use('/api/webhooks', express_1.default.raw({ type: 'application/json' }));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
if (process.env.NODE_ENV === 'development') {
    app.use((req, res, next) => {
        console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
        next();
    });
}
app.use('/api/auth', auth_1.default);
app.use('/api/chat', chat_1.default);
app.use('/api/dashboard', dashboard_1.default);
app.use('/api/widget', widget_1.default);
app.use('/api/webhooks', webhooks_1.default);
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0'
    });
});
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Endpoint no encontrado' });
});
app.use((error, req, res, next) => {
    console.error('Error:', error);
    if (error.name === 'ValidationError') {
        return res.status(400).json({ error: 'Datos inválidos', details: error.message });
    }
    if (error.name === 'UnauthorizedError') {
        return res.status(401).json({ error: 'No autorizado' });
    }
    res.status(500).json({
        error: 'Error interno del servidor',
        ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
});
const PORT = process.env.PORT || 3001;
async function startServer() {
    try {
        await databaseService.connect();
        console.log('✅ Base de datos conectada');
        websocketService.initialize();
        console.log('✅ WebSocket inicializado');
        server.listen(PORT, () => {
            console.log(`🚀 Servidor Conversa.ai ejecutándose en puerto ${PORT}`);
            console.log(`📱 Frontend URL: ${process.env.FRONTEND_URL}`);
            console.log(`🔗 API URL: http://localhost:${PORT}`);
        });
    }
    catch (error) {
        console.error('❌ Error al iniciar servidor:', error);
        process.exit(1);
    }
}
process.on('SIGINT', async () => {
    console.log('🔄 Cerrando servidor...');
    try {
        await databaseService.disconnect();
        console.log('✅ Base de datos desconectada');
        server.close(() => {
            console.log('✅ Servidor cerrado');
            process.exit(0);
        });
    }
    catch (error) {
        console.error('❌ Error al cerrar:', error);
        process.exit(1);
    }
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', promise, 'reason:', reason);
    process.exit(1);
});
process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});
startServer();
exports.default = app;
//# sourceMappingURL=server.js.map