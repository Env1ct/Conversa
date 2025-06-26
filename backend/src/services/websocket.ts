import { Server } from 'socket.io';
import { DefaultEventsMap } from 'socket.io/dist/typed-events';

export interface SocketUser {
  id: string;
  conversationId?: string;
  tenantId?: string;
  isAgent?: boolean;
}

export class WebSocketService {
  private io: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;
  private connectedUsers: Map<string, SocketUser> = new Map();

  constructor(io: Server) {
    this.io = io;
  }

  public initialize(): void {
    this.io.on('connection', (socket) => {
      console.log(`🔌 Cliente conectado: ${socket.id}`);

      // Manejar autenticación del socket
      socket.on('authenticate', (data: { conversationId?: string; tenantId?: string; isAgent?: boolean }) => {
        this.connectedUsers.set(socket.id, {
          id: socket.id,
          conversationId: data.conversationId,
          tenantId: data.tenantId,
          isAgent: data.isAgent || false,
        });

        // Unir a la sala de la conversación si existe
        if (data.conversationId) {
          socket.join(`conversation_${data.conversationId}`);
          console.log(`👥 Usuario ${socket.id} unido a conversación ${data.conversationId}`);
        }

        // Unir a la sala del tenant si es un agente
        if (data.isAgent && data.tenantId) {
          socket.join(`tenant_${data.tenantId}`);
          console.log(`🏢 Agente ${socket.id} unido a tenant ${data.tenantId}`);
        }

        socket.emit('authenticated', { success: true });
      });

      // Manejar unirse a una conversación
      socket.on('join_conversation', (conversationId: string) => {
        socket.join(`conversation_${conversationId}`);
        
        const user = this.connectedUsers.get(socket.id);
        if (user) {
          user.conversationId = conversationId;
          this.connectedUsers.set(socket.id, user);
        }

        console.log(`👥 Usuario ${socket.id} unido a conversación ${conversationId}`);
        
        // Notificar a otros en la conversación
        socket.to(`conversation_${conversationId}`).emit('user_joined', {
          userId: socket.id,
          timestamp: new Date().toISOString(),
        });
      });

      // Manejar salir de una conversación
      socket.on('leave_conversation', (conversationId: string) => {
        socket.leave(`conversation_${conversationId}`);
        
        const user = this.connectedUsers.get(socket.id);
        if (user) {
          user.conversationId = undefined;
          this.connectedUsers.set(socket.id, user);
        }

        console.log(`👋 Usuario ${socket.id} salió de conversación ${conversationId}`);
        
        // Notificar a otros en la conversación
        socket.to(`conversation_${conversationId}`).emit('user_left', {
          userId: socket.id,
          timestamp: new Date().toISOString(),
        });
      });

      // Manejar indicador de "escribiendo"
      socket.on('typing_start', (data: { conversationId: string }) => {
        socket.to(`conversation_${data.conversationId}`).emit('user_typing', {
          userId: socket.id,
          isTyping: true,
          timestamp: new Date().toISOString(),
        });
      });

      socket.on('typing_stop', (data: { conversationId: string }) => {
        socket.to(`conversation_${data.conversationId}`).emit('user_typing', {
          userId: socket.id,
          isTyping: false,
          timestamp: new Date().toISOString(),
        });
      });

      // Manejar mensajes en tiempo real (opcional, para validación adicional)
      socket.on('send_message', async (data: { 
        conversationId: string; 
        content: string; 
        type?: string 
      }) => {
        try {
          // Aquí podrías agregar validaciones adicionales
          // Por ahora, solo retransmitimos el evento
          socket.to(`conversation_${data.conversationId}`).emit('message_sent', {
            conversationId: data.conversationId,
            content: data.content,
            sender: socket.id,
            timestamp: new Date().toISOString(),
          });
        } catch (error) {
          console.error('Error procesando mensaje:', error);
          socket.emit('error', { message: 'Error al enviar mensaje' });
        }
      });

      // Manejar transferencia a agente humano
      socket.on('request_human_agent', (data: { conversationId: string; reason?: string }) => {
        const user = this.connectedUsers.get(socket.id);
        if (user?.tenantId) {
          // Notificar a todos los agentes del tenant
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

      // Manejar agente tomando una conversación
      socket.on('agent_take_conversation', (data: { conversationId: string }) => {
        const user = this.connectedUsers.get(socket.id);
        if (user?.isAgent) {
          // Notificar al cliente que un agente tomó la conversación
          this.io.to(`conversation_${data.conversationId}`).emit('agent_joined', {
            agentId: socket.id,
            timestamp: new Date().toISOString(),
          });

          // Notificar a otros agentes que la conversación fue tomada
          if (user.tenantId) {
            socket.to(`tenant_${user.tenantId}`).emit('conversation_taken', {
              conversationId: data.conversationId,
              agentId: socket.id,
            });
          }
        }
      });

      // Manejar desconexión
      socket.on('disconnect', () => {
        const user = this.connectedUsers.get(socket.id);
        console.log(`🔌 Cliente desconectado: ${socket.id}`);

        if (user?.conversationId) {
          // Notificar a otros en la conversación
          socket.to(`conversation_${user.conversationId}`).emit('user_left', {
            userId: socket.id,
            timestamp: new Date().toISOString(),
          });
        }

        // Limpiar usuario de la memoria
        this.connectedUsers.delete(socket.id);
      });

      // Manejar errores
      socket.on('error', (error) => {
        console.error(`❌ Error en socket ${socket.id}:`, error);
      });
    });

    console.log('✅ WebSocket service inicializado');
  }

  // Métodos públicos para enviar eventos desde otros servicios

  // Enviar mensaje a una conversación específica
  public sendMessageToConversation(conversationId: string, message: any): void {
    this.io.to(`conversation_${conversationId}`).emit('new_message', {
      ...message,
      timestamp: new Date().toISOString(),
    });
  }

  // Enviar notificación a todos los agentes de un tenant
  public notifyTenantAgents(tenantId: string, notification: any): void {
    this.io.to(`tenant_${tenantId}`).emit('notification', {
      ...notification,
      timestamp: new Date().toISOString(),
    });
  }

  // Enviar evento de bot escribiendo
  public sendBotTyping(conversationId: string, isTyping: boolean): void {
    this.io.to(`conversation_${conversationId}`).emit('bot_typing', {
      isTyping,
      timestamp: new Date().toISOString(),
    });
  }

  // Obtener estadísticas de conexiones
  public getConnectionStats(): {
    totalConnections: number;
    activeConversations: number;
    connectedAgents: number;
  } {
    const users = Array.from(this.connectedUsers.values());
    
    return {
      totalConnections: users.length,
      activeConversations: new Set(users.filter(u => u.conversationId).map(u => u.conversationId)).size,
      connectedAgents: users.filter(u => u.isAgent).length,
    };
  }

  // Desconectar usuario específico
  public disconnectUser(socketId: string, reason?: string): void {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.emit('forced_disconnect', { reason });
      socket.disconnect(true);
    }
  }

  // Broadcast a todos los usuarios conectados
  public broadcast(event: string, data: any): void {
    this.io.emit(event, {
      ...data,
      timestamp: new Date().toISOString(),
    });
  }
}