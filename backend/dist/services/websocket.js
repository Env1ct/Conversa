"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketService = void 0;
class WebSocketService {
    constructor(io) {
        this.connectedUsers = new Map();
        this.io = io;
    }
    initialize() {
        this.io.on('connection', (socket) => {
            console.log(`🔌 Cliente conectado: ${socket.id}`);
            socket.on('authenticate', (data) => {
                this.connectedUsers.set(socket.id, {
                    id: socket.id,
                    conversationId: data.conversationId,
                    tenantId: data.tenantId,
                    isAgent: data.isAgent || false,
                });
                if (data.conversationId) {
                    socket.join(`conversation_${data.conversationId}`);
                    console.log(`👥 Usuario ${socket.id} unido a conversación ${data.conversationId}`);
                }
                if (data.isAgent && data.tenantId) {
                    socket.join(`tenant_${data.tenantId}`);
                    console.log(`🏢 Agente ${socket.id} unido a tenant ${data.tenantId}`);
                }
                socket.emit('authenticated', { success: true });
            });
            socket.on('join_conversation', (conversationId) => {
                socket.join(`conversation_${conversationId}`);
                const user = this.connectedUsers.get(socket.id);
                if (user) {
                    user.conversationId = conversationId;
                    this.connectedUsers.set(socket.id, user);
                }
                console.log(`👥 Usuario ${socket.id} unido a conversación ${conversationId}`);
                socket.to(`conversation_${conversationId}`).emit('user_joined', {
                    userId: socket.id,
                    timestamp: new Date().toISOString(),
                });
            });
            socket.on('leave_conversation', (conversationId) => {
                socket.leave(`conversation_${conversationId}`);
                const user = this.connectedUsers.get(socket.id);
                if (user) {
                    user.conversationId = undefined;
                    this.connectedUsers.set(socket.id, user);
                }
                console.log(`👋 Usuario ${socket.id} salió de conversación ${conversationId}`);
                socket.to(`conversation_${conversationId}`).emit('user_left', {
                    userId: socket.id,
                    timestamp: new Date().toISOString(),
                });
            });
            socket.on('typing_start', (data) => {
                socket.to(`conversation_${data.conversationId}`).emit('user_typing', {
                    userId: socket.id,
                    isTyping: true,
                    timestamp: new Date().toISOString(),
                });
            });
            socket.on('typing_stop', (data) => {
                socket.to(`conversation_${data.conversationId}`).emit('user_typing', {
                    userId: socket.id,
                    isTyping: false,
                    timestamp: new Date().toISOString(),
                });
            });
            socket.on('send_message', async (data) => {
                try {
                    socket.to(`conversation_${data.conversationId}`).emit('message_sent', {
                        conversationId: data.conversationId,
                        content: data.content,
                        sender: socket.id,
                        timestamp: new Date().toISOString(),
                    });
                }
                catch (error) {
                    console.error('Error procesando mensaje:', error);
                    socket.emit('error', { message: 'Error al enviar mensaje' });
                }
            });
            socket.on('request_human_agent', (data) => {
                const user = this.connectedUsers.get(socket.id);
                if (user?.tenantId) {
                    this.io.to(`tenant_${user.tenantId}`).emit('agent_request', {
                        conversationId: data.conversationId,
                        reason: data.reason,
                        timestamp: new Date().toISOString(),
                        requesterInfo: {
                            socketId: socket.id,
                            conversationId: user.conversationId,
                        },
                    });
                    socket.emit('agent_requested', {
                        message: 'Solicitud de agente enviada. Te conectaremos pronto.',
                    });
                }
            });
            socket.on('agent_take_conversation', (data) => {
                const user = this.connectedUsers.get(socket.id);
                if (user?.isAgent) {
                    this.io.to(`conversation_${data.conversationId}`).emit('agent_joined', {
                        agentId: socket.id,
                        timestamp: new Date().toISOString(),
                    });
                    if (user.tenantId) {
                        socket.to(`tenant_${user.tenantId}`).emit('conversation_taken', {
                            conversationId: data.conversationId,
                            agentId: socket.id,
                        });
                    }
                }
            });
            socket.on('disconnect', () => {
                const user = this.connectedUsers.get(socket.id);
                console.log(`🔌 Cliente desconectado: ${socket.id}`);
                if (user?.conversationId) {
                    socket.to(`conversation_${user.conversationId}`).emit('user_left', {
                        userId: socket.id,
                        timestamp: new Date().toISOString(),
                    });
                }
                this.connectedUsers.delete(socket.id);
            });
            socket.on('error', (error) => {
                console.error(`❌ Error en socket ${socket.id}:`, error);
            });
        });
        console.log('✅ WebSocket service inicializado');
    }
    sendMessageToConversation(conversationId, message) {
        this.io.to(`conversation_${conversationId}`).emit('new_message', {
            ...message,
            timestamp: new Date().toISOString(),
        });
    }
    notifyTenantAgents(tenantId, notification) {
        this.io.to(`tenant_${tenantId}`).emit('notification', {
            ...notification,
            timestamp: new Date().toISOString(),
        });
    }
    sendBotTyping(conversationId, isTyping) {
        this.io.to(`conversation_${conversationId}`).emit('bot_typing', {
            isTyping,
            timestamp: new Date().toISOString(),
        });
    }
    getConnectionStats() {
        const users = Array.from(this.connectedUsers.values());
        return {
            totalConnections: users.length,
            activeConversations: new Set(users.filter(u => u.conversationId).map(u => u.conversationId)).size,
            connectedAgents: users.filter(u => u.isAgent).length,
        };
    }
    disconnectUser(socketId, reason) {
        const socket = this.io.sockets.sockets.get(socketId);
        if (socket) {
            socket.emit('forced_disconnect', { reason });
            socket.disconnect(true);
        }
    }
    broadcast(event, data) {
        this.io.emit(event, {
            ...data,
            timestamp: new Date().toISOString(),
        });
    }
}
exports.WebSocketService = WebSocketService;
//# sourceMappingURL=websocket.js.map