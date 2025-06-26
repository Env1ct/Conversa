import { PrismaClient } from '@prisma/client';

export class DatabaseService {
  private static instance: DatabaseService;
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
      errorFormat: 'pretty',
    });
  }

  // Singleton pattern
  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      DatabaseService.instance = new DatabaseService();
    }
    return DatabaseService.instance;
  }

  // Conectar a la base de datos
  public async connect(): Promise<void> {
    try {
      await this.prisma.$connect();
      console.log('✅ Conexión a base de datos establecida');
    } catch (error) {
      console.error('❌ Error conectando a la base de datos:', error);
      throw error;
    }
  }

  // Desconectar de la base de datos
  public async disconnect(): Promise<void> {
    try {
      await this.prisma.$disconnect();
      console.log('✅ Desconectado de la base de datos');
    } catch (error) {
      console.error('❌ Error desconectando de la base de datos:', error);
      throw error;
    }
  }

  // Obtener cliente Prisma
  public getClient(): PrismaClient {
    return this.prisma;
  }

  // Verificar salud de la base de datos
  public async healthCheck(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      console.error('❌ Health check falló:', error);
      return false;
    }
  }

  // Métodos de utilidad para operaciones comunes

  // Crear tenant con usuario inicial
  public async createTenantWithUser(data: {
    name: string;
    plan: string;
    user: {
      email: string;
      name: string;
      password: string;
    };
    stripe?: {
      customerId: string;
      subscriptionId: string;
    };
  }) {
    return this.prisma.$transaction(async (tx) => {
      // Crear tenant
      const tenant = await tx.tenant.create({
        data: {
          name: data.name,
          plan: data.plan,
          stripeCustomerId: data.stripe?.customerId,
          stripeSubscriptionId: data.stripe?.subscriptionId,
          features: this.getTenantFeatures(data.plan),
          limits: this.getTenantLimits(data.plan),
        },
      });

      // Crear usuario owner
      const user = await tx.user.create({
        data: {
          email: data.user.email,
          name: data.user.name,
          password: data.user.password,
          role: 'OWNER',
          tenantId: tenant.id,
        },
      });

      // Crear chatbot por defecto
      const chatbot = await tx.chatbot.create({
        data: {
          name: 'Asistente Principal',
          tenantId: tenant.id,
          model: data.plan === 'enterprise' ? 'claude-3.5-sonnet' : 'gpt-4',
          systemPrompt: `Eres un asistente virtual profesional para ${data.name}. Ayuda a los clientes de manera amigable, eficiente y profesional. Siempre mantén un tono cordial y busca resolver sus dudas de la mejor manera posible.`,
          welcomeMessage: `¡Hola! Soy el asistente virtual de ${data.name}. ¿En qué puedo ayudarte hoy?`,
        },
      });

      // Crear widget por defecto
      const widget = await tx.widget.create({
        data: {
          name: 'Widget Principal',
          tenantId: tenant.id,
          chatbotId: chatbot.id,
          config: {
            position: 'bottom-right',
            primaryColor: '#4F46E5',
            greeting: `¡Hola! Soy el asistente de ${data.name}`,
            placeholder: 'Escribe tu mensaje...',
            sendButtonText: 'Enviar',
          },
          theme: {
            primaryColor: '#4F46E5',
            backgroundColor: '#FFFFFF',
            textColor: '#1F2937',
            borderRadius: '12px',
          },
        },
      });

      return { tenant, user, chatbot, widget };
    });
  }

  // Obtener estadísticas del tenant
  public async getTenantStats(tenantId: string, days: number = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [
      totalConversations,
      recentConversations,
      totalMessages,
      recentMessages,
      activeWidgets,
    ] = await Promise.all([
      this.prisma.conversation.count({
        where: { tenantId },
      }),
      this.prisma.conversation.count({
        where: {
          tenantId,
          createdAt: { gte: startDate },
        },
      }),
      this.prisma.message.count({
        where: {
          conversation: { tenantId },
        },
      }),
      this.prisma.message.count({
        where: {
          conversation: { tenantId },
          createdAt: { gte: startDate },
        },
      }),
      this.prisma.widget.count({
        where: {
          tenantId,
          isActive: true,
        },
      }),
    ]);

    return {
      totalConversations,
      recentConversations,
      totalMessages,
      recentMessages,
      activeWidgets,
      avgMessagesPerConversation: totalConversations > 0 ? Math.round(totalMessages / totalConversations) : 0,
    };
  }

  // Verificar límites del tenant
  public async checkTenantLimits(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true, limits: true },
    });

    if (!tenant) {
      throw new Error('Tenant no encontrado');
    }

    const limits = tenant.limits as any;
    const currentMonth = new Date();
    currentMonth.setDate(1);
    currentMonth.setHours(0, 0, 0, 0);

    const [conversationCount, messageCount] = await Promise.all([
      this.prisma.conversation.count({
        where: {
          tenantId,
          createdAt: { gte: currentMonth },
        },
      }),
      this.prisma.message.count({
        where: {
          conversation: { tenantId },
          createdAt: { gte: currentMonth },
        },
      }),
    ]);

    return {
      conversations: {
        used: conversationCount,
        limit: limits.conversations || 0,
        exceeded: limits.conversations > 0 && conversationCount >= limits.conversations,
      },
      messages: {
        used: messageCount,
        limit: limits.messages || 0,
        exceeded: limits.messages > 0 && messageCount >= limits.messages,
      },
    };
  }

  // Funciones de utilidad para obtener características y límites
  private getTenantFeatures(plan: string): string[] {
    const features = {
      starter: ['basic_ai', 'widget', 'email_support'],
      professional: ['advanced_ai', 'widget', 'knowledge_base', 'analytics', 'email_support'],
      business: ['multi_model_ai', 'widget', 'knowledge_base', 'advanced_analytics', 'api', 'priority_support'],
      enterprise: ['premium_ai', 'widget', 'knowledge_base', 'advanced_analytics', 'api', 'webhooks', 'dedicated_support', 'compliance']
    };
    return features[plan as keyof typeof features] || features.starter;
  }

  private getTenantLimits(plan: string): Record<string, number> {
    const limits = {
      starter: { conversations: 500, messages: 2000, agents: 2 },
      professional: { conversations: 2000, messages: 10000, agents: 5 },
      business: { conversations: 5000, messages: 25000, agents: 10 },
      enterprise: { conversations: 15000, messages: 75000, agents: -1 }
    };
    return limits[plan as keyof typeof limits] || limits.starter;
  }
}

// Exportar instancia singleton
export const db = DatabaseService.getInstance();