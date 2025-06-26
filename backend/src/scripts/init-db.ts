import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

// Cargar variables de entorno
dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log('🔄 Inicializando base de datos...');

  try {
    // Verificar conexión
    await prisma.$connect();
    console.log('✅ Conectado a la base de datos');

    // Aplicar migraciones
    console.log('📦 Aplicando migraciones...');
    
    // Crear tenant de ejemplo para desarrollo
    if (process.env.NODE_ENV === 'development') {
      const existingTenant = await prisma.tenant.findFirst({
        where: { name: 'Conversa.ai Demo' }
      });

      if (!existingTenant) {
        const hashedPassword = await bcrypt.hash('demo123456', 12);

        const tenant = await prisma.tenant.create({
          data: {
            name: 'Conversa.ai Demo',
            plan: 'professional',
            features: ['advanced_ai', 'widget', 'knowledge_base', 'analytics', 'email_support'],
            limits: { conversations: 2000, messages: 10000, agents: 5 },
            isActive: true,
          }
        });

        const user = await prisma.user.create({
          data: {
            email: 'demo@conversa.ai',
            name: 'Usuario Demo',
            password: hashedPassword,
            role: 'OWNER',
            tenantId: tenant.id,
            isActive: true,
          }
        });

        const chatbot = await prisma.chatbot.create({
          data: {
            name: 'Asistente Demo',
            tenantId: tenant.id,
            model: 'gpt-4',
            systemPrompt: 'Eres un asistente virtual profesional para Conversa.ai Demo. Ayuda a los usuarios con información sobre nuestra plataforma de chatbots con IA. Mantén un tono amigable y profesional.',
            welcomeMessage: '¡Hola! Soy el asistente de Conversa.ai Demo. ¿En qué puedo ayudarte hoy?',
            isActive: true,
          }
        });

        const widget = await prisma.widget.create({
          data: {
            name: 'Widget Demo',
            tenantId: tenant.id,
            chatbotId: chatbot.id,
            config: {
              position: 'bottom-right',
              primaryColor: '#4F46E5',
              greeting: '¡Hola! Soy el asistente de Conversa.ai',
              placeholder: 'Escribe tu mensaje...',
              sendButtonText: 'Enviar',
            },
            theme: {
              primaryColor: '#4F46E5',
              backgroundColor: '#FFFFFF',
              textColor: '#1F2937',
              borderRadius: '12px',
            },
            isActive: true,
          }
        });

        console.log('✅ Datos de ejemplo creados:');
        console.log(`   📧 Email: demo@conversa.ai`);
        console.log(`   🔑 Password: demo123456`);
        console.log(`   🤖 Chatbot ID: ${chatbot.id}`);
        console.log(`   🔗 Widget ID: ${widget.id}`);
      } else {
        console.log('ℹ️  Datos de ejemplo ya existen');
      }
    }

    console.log('✅ Base de datos inicializada correctamente');

  } catch (error) {
    console.error('❌ Error inicializando base de datos:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((error) => {
    console.error('❌ Error fatal:', error);
    process.exit(1);
  });