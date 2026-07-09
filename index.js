require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg'); // Conector correcto para la nube
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);


// Configuración de la Base de Datos en la Nube (Supabase)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Crear la tabla automáticamente en Supabase si no existe
const crearTablaQuery = `
    CREATE TABLE IF NOT EXISTS comandas (
        id SERIAL PRIMARY KEY,
        mesa TEXT,
        pedido TEXT,
        fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        estado TEXT DEFAULT 'PENDIENTE'
    );
`;
pool.query(crearTablaQuery)
    .then(() => console.log("💾 Conectado exitosamente a Supabase en la nube."))
    .catch(err => console.error("❌ Error al crear tabla en Supabase:", err.message));

app.use(express.static(path.join(__dirname, 'public')));

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

bot.start((ctx) => ctx.reply('¡Bienvenido a Armandazo! Envía los pedidos usando el formato:\nMesa X - productos\n\nEjemplo:\nMesa 4 - 2 asados, 1 coca cola'));

// --- PROCESADOR DE TEXTO GRATUITO ---
bot.on('text', async (ctx) => {
    const texto = ctx.message.text;
    if (texto.startsWith('/')) return;

    if (texto.toLowerCase().includes('mesa') && texto.includes('-')) {
        const partes = texto.split('-');
        const parteMesa = partes[0];
        const partePedido = partes[1].trim();
        const mesa = parteMesa.replace(/[^0-9]/g, '').trim() || "General";

        guardarYEnviarComanda(mesa, partePedido, ctx);
    } else {
        ctx.reply('⚠️ Formato incorrecto. Recuerda usar el guión. Ejemplo:\nMesa 3 - 2 hamburguesas');
    }
});

async function guardarYEnviarComanda(mesa, pedidoLimpio, ctx) {
    const query = "INSERT INTO comandas (mesa, pedido) VALUES ($1, $2) RETURNING id";
    try {
        const res = await pool.query(query, [mesa, pedidoLimpio]);
        const idPedido = res.rows[0].id;

        // Mandar a la tablet mediante Sockets en tiempo real
        io.emit('nueva_comanda', {
            id: idPedido,
            mesa: mesa,
            pedido: pedidoLimpio
        });

        ctx.reply(`✅ ¡Enviado a Cocina!\n📌 **Mesa ${mesa}**\n📋 ${pedidoLimpio}`);
    } catch (err) {
        console.error(err);
        ctx.reply("❌ Error al guardar en la base de datos de la nube.");
    }
}

// Cambiar estado cuando la cocina le dé a la X
io.on('connection', (socket) => {
    socket.on('completar_pedido', async (id) => {
        try {
            await pool.query("UPDATE comandas SET estado = 'COMPLETADO' WHERE id = $1", [id]);
        } catch (err) {
            console.error("Error al completar pedido:", err.message);
        }
    });
});

// --- COMANDO REPORTE EN LA NUBE ---
bot.command('reporte', async (ctx) => {
    try {
        const res = await pool.query("SELECT pedido FROM comandas WHERE estado = 'COMPLETADO'");
        if (res.rows.length === 0) return ctx.reply("📊 No hay ventas registradas para el reporte hoy.");

        let conteo = {};
        res.rows.forEach(fila => {
            const items = fila.pedido.split(',');
            items.forEach(item => {
                const limpio = item.trim().toLowerCase();
                conteo[limpio] = (conteo[limpio] || 0) + 1;
            });
        });

        let msg = "📊 **REPORTE DE VENTAS - ARMANDAZO** 📊\n\n";
        for (const [plato, total] of Object.entries(conteo)) {
            msg += `🔹 ${total}x ${plato.charAt(0).toUpperCase() + plato.slice(1)}\n`;
        }
        ctx.reply(msg);
    } catch (err) {
        ctx.reply("❌ Error al generar el reporte.");
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor de Armandazo Nube activo en el puerto ${PORT}`);
});

bot.launch();
// --- COMANDO SECRETO PARA LIMPIAR LA BASE DE DATOS ---
bot.command('vaciar_todo', async (ctx) => {
    try {
        await pool.query("TRUNCATE TABLE comandas RESTART IDENTITY");
        ctx.reply("🧹 ¡Base de datos limpiada con éxito! Lista para los platos reales.");
    } catch (err) {
        ctx.reply("❌ Error al limpiar la base de datos.");
    }
});