import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

// Importar rutas
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import dashboardRoutes from './routes/dashboard';
import widgetRoutes from './routes/widget';
import webhookRoutes from './routes/webhooks';

// Importar servicios
import { DatabaseService } from './services/database';
import { WebSocketService } from './services/websocket';

// Cargar variables de entorno
dotenv.config();

// Crear aplicación Express
const app = express();
const server = createServer(app);

// Configurar WebSocket
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true
  }
});

// Inicializar servicios
const databaseService = new DatabaseService();
const websocketService = new WebSocketService(io);

// Middleware de seguridad
app.use(helmet({
  contentSecurityPolicy: false, // Deshabilitado para desarrollo
}));

// CORS
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: 'Demasiadas solicitudes desde esta IP'
});

app.use('/api/', limiter);

// Parseo de JSON
app.use('/api/webhooks', express.raw({ type: 'application/json' })); // Webhooks necesitan raw
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Logging de requests en desarrollo
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
  });
}

// Rutas de API
app.use('/api/auth', authRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/widget', widgetRoutes);
app.use('/api/webhooks', webhookRoutes);

// Endpoint de salud
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint no encontrado' });
});

// Manejo de errores global
app.use((error: any, req: any, res: any, next: any) => {
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

// Inicializar servidor
const PORT = process.env.PORT || 3001;

async function startServer() {
  try {
    // Inicializar base de datos
    await databaseService.connect();
    console.log('✅ Base de datos conectada');
    
    // Inicializar WebSocket
    websocketService.initialize();
    console.log('✅ WebSocket inicializado');
    
    // Iniciar servidor
    server.listen(PORT, () => {
      console.log(`🚀 Servidor Conversa.ai ejecutándose en puerto ${PORT}`);
      console.log(`📱 Frontend URL: ${process.env.FRONTEND_URL}`);
      console.log(`🔗 API URL: http://localhost:${PORT}`);
    });
    
  } catch (error) {
    console.error('❌ Error al iniciar servidor:', error);
    process.exit(1);
  }
}

// Limpieza al cerrar
process.on('SIGINT', async () => {
  console.log('🔄 Cerrando servidor...');
  
  try {
    await databaseService.disconnect();
    console.log('✅ Base de datos desconectada');
    
    server.close(() => {
      console.log('✅ Servidor cerrado');
      process.exit(0);
    });
  } catch (error) {
    console.error('❌ Error al cerrar:', error);
    process.exit(1);
  }
});

// Manejar errores no capturados
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Iniciar el servidor
startServer();

export default app;