require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg'); 
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Configuración de la Base de Datos en Neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Mensaje de conexión limpia
pool.query("SELECT NOW()")
    .then(() => console.log("💾 Conectado exitosamente a Neon (Base de datos Inteligente)."))
    .catch(err => console.error("❌ Error de conexión en Neon:", err.message));

app.use(express.static(path.join(__dirname, 'public')));

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

bot.start((ctx) => ctx.reply('¡Bienvenido al sistema inteligente de El Armandazo!\nEnvía los pedidos de forma natural.\n\nEjemplos:\n- Mesa 4 2 pollos broaster, 1 chicha morada jarra grande\n- Mesa 2 un mostrito y una salchipapa'));

// --- PROCESADOR DE TEXTO FLEXIBLE (CON O SIN GUIONES / AUDIOS DICTADOS) ---
bot.on('text', async (ctx, next) => {
    const texto = ctx.message.text;
    
    // Si el texto es un comando, dejamos que pasen los comandos abajo y detenemos este procesador de texto
    if (texto.startsWith('/')) {
        return next();
    }

    const textoMinuscula = texto.toLowerCase();

    // Validamos que el mensaje mencione la palabra mesa
    if (textoMinuscula.includes('mesa')) {
        // Expresión regular para buscar "mesa" seguido de cualquier espacio y un número
        const matchMesa = textoMinuscula.match(/mesa\s*(\d+)/i);
        
        if (matchMesa) {
            const mesa = matchMesa[1]; // Extrae el número de mesa limpiamente
            
            // Extrae el pedido removiendo el texto "mesa X" y caracteres como guiones o dos puntos si existieran
            let pedidoLimpio = textoMinuscula
                .replace(/mesa\s*\d+/i, '')
                .replace(/^[:\-\s]+/, '')
                .trim();

            if (!pedidoLimpio) {
                return ctx.reply('⚠️ Detecté la mesa, pero el pedido está vacío. Inténtalo de nuevo.');
            }

            guardarYEnviarComanda(mesa, pedidoLimpio, ctx);
        } else {
            ctx.reply('⚠️ No logré identificar el número de mesa. Recuerda decir por ejemplo: "Mesa 3 2 chifas"');
        }
    } else {
        ctx.reply('⚠️ Por favor inicia el pedido mencionando el número de mesa. Ejemplo: "Mesa 5 un mostrito"');
    }
});

async function guardarYEnviarComanda(mesa, pedidoLimpio, ctx) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Insertar la comanda principal en estado PENDIENTE
        const resComanda = await client.query(
            "INSERT INTO comandas (mesa, estado, total_comanda) VALUES ($1, 'PENDIENTE', 0.00) RETURNING id",
            [mesa]
        );
        const comandaId = resComanda.rows[0].id;

        // 2. Procesar los platos para calcular precios automáticamente
        const items = pedidoLimpio.split(/,|\by\b/); 
        let totalComanda = 0;
        let resumenProductos = [];

        for (let item of items) {
            item = item.trim();
            if (!item) continue;

            // Extraer la cantidad numérica al inicio del plato (si no hay, por defecto es 1)
            const matchCantidad = item.match(/^(\d+)/);
            let cantidad = 1;
            let nombrePlatoBuscar = item;

            if (matchCantidad) {
                cantidad = parseInt(matchCantidad[1]);
                nombrePlatoBuscar = item.replace(/^\d+/, '').trim();
            }

            // Quitar palabras conectoras secundarias
            nombrePlatoBuscar = nombrePlatoBuscar.replace(/^(un|una|de|unos|unas)\s+/i, '').trim();

            // Buscar el plato en la base de datos (haciendo una búsqueda flexible)
            const resMenu = await client.query(
                "SELECT id, nombre, precio FROM menu WHERE LOWER(nombre) LIKE $1 LIMIT 1",
                [`%${nombrePlatoBuscar}%`]
            );

            if (resMenu.rows.length > 0) {
                const plato = resMenu.rows[0];
                const subtotal = plato.precio * cantidad;
                totalComanda += subtotal;

                // Insertar el desglose exacto en los detalles
                await client.query(
                    "INSERT INTO detalle_comandas (comanda_id, menu_id, cantidad, precio_unitario, subtotal) VALUES ($1, $2, $3, $4, $5)",
                    [comandaId, plato.id, cantidad, plato.precio, subtotal]
                );
                resumenProductos.push(`🔹 ${cantidad}x ${plato.nombre} (S/. ${subtotal.toFixed(2)})`);
            } else {
                // Si no se encuentra exactamente, se guarda con precio 0 e ID nulo en el detalle para no romper el flujo
                await client.query(
                    "INSERT INTO detalle_comandas (comanda_id, menu_id, cantidad, precio_unitario, subtotal) VALUES ($1, NULL, $2, 0.00, 0.00)",
                    [comandaId, cantidad]
                );
                resumenProductos.push(`❓ ${cantidad}x ${nombrePlatoBuscar} (No listado en Carta)`);
            }
        }

        // 3. Actualizar el valor total calculado de la comanda
        await client.query(
            "UPDATE comandas SET total_comanda = $1 WHERE id = $2",
            [totalComanda, comandaId]
        );

        await client.query('COMMIT');

        // Mandar a la web de la cocina mediante Sockets en tiempo real
        io.emit('nueva_comanda', {
            id: comandaId,
            mesa: mesa,
            pedido: pedidoLimpio,
            total: totalComanda.toFixed(2)
        });

        // Respuesta limpia al celular del mesero
        ctx.reply(`✅ **¡Enviado a Cocina!**\n📌 **Mesa ${mesa}**\n\n${resumenProductos.join('\n')}\n\n💰 **Total estimado: S/. ${totalComanda.toFixed(2)}**`);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        ctx.reply("❌ Error al procesar el pedido en el sistema.");
    } finally {
        client.release();
    }
}

// Cambiar estado cuando la cocina complete la orden en el panel
io.on('connection', (socket) => {
    socket.on('completar_pedido', async (id) => {
        try {
            await pool.query("UPDATE comandas SET estado = 'COMPLETADO' WHERE id = $1", [id]);
        } catch (err) {
            console.error("Error al completar pedido:", err.message);
        }
    });
});

// --- COMANDO REPORTE CORREGIDO (Ignora el arroba/alias del bot si se manda en grupos) ---
bot.hears(/^\/reporte/i, async (ctx) => {
    try {
        // 1. Obtener totales de caja (tanto pendientes como completados para ver el movimiento real)
        const resCaja = await pool.query(`
            SELECT COUNT(id) AS total_pedidos, COALESCE(SUM(total_comanda), 0) AS ingresos_totales 
            FROM comandas 
            WHERE fecha AT TIME ZONE 'America/Lima' >= CURRENT_DATE
        `);

        // 2. Obtener conteo exacto usando LEFT JOIN (así muestra los platos aunque el mesero los haya escrito un poco diferente)
        const resPlatos = await pool.query(`
            SELECT 
                COALESCE(m.nombre, 'Plato personalizado/no identificado') AS nombre_plato, 
                SUM(dc.cantidad) AS total_vendido, 
                SUM(dc.subtotal) AS recaudado
            FROM detalle_comandas dc
            LEFT JOIN menu m ON dc.menu_id = m.id
            JOIN comandas c ON dc.comanda_id = c.id
            WHERE c.fecha AT TIME ZONE 'America/Lima' >= CURRENT_DATE
            GROUP BY m.id, m.nombre
            ORDER BY total_vendido DESC
        `);

        const caja = resCaja.rows[0] || { total_pedidos: 0, ingresos_totales: 0 };

        let msg = "📊 **REPORTE DE VENTAS - EL ARMANDAZO** 📊\n";
        msg += `📆 _Filtro: Ventas de Hoy_\n`;
        msg += `------------------------------------------\n`;
        msg += `📝 Comandas Totales: *${caja.total_pedidos}*\n`;
        msg += `💰 **INGRESO TOTAL DE CAJA: S/. ${parseFloat(caja. ingresos_totales).toFixed(2)}**\n`;
        msg += `------------------------------------------\n`;
        msg += `🍗 **CONTEO DE PLATOS EN TOTAL:**\n\n`;

        if (resPlatos.rows.length === 0) {
            msg += "_Aún no hay pedidos registrados el día de hoy._";
        } else {
            resPlatos.rows.forEach(fila => {
                msg += `🔹 ${fila.total_vendido}x ${fila.nombre_plato} (S/. ${parseFloat(fila.recaudado).toFixed(2)})\n`;
            });
        }

        ctx.replyWithMarkdown(msg);
    } catch (err) {
        console.error("Error en reporte:", err);
        ctx.reply("❌ Error al generar el reporte financiero.");
    }
});

// --- COMANDO PARA REINICIAR LAS COMANDAS ---
bot.command('vaciar_todo', async (ctx) => {
    try {
        await pool.query("TRUNCATE TABLE comandas, detalle_comandas RESTART IDENTITY CASCADE");
        ctx.reply("🧹 ¡Sistema en cero! Todas las comandas archivadas. Contador reiniciado en #1.");
    } catch (err) {
        console.error(err);
        ctx.reply("❌ Error al limpiar los registros diarios.");
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor de El Armandazo activo en el puerto ${PORT}`);
});

bot.launch();