// ======================================================
// 🎧 Muestra qué archivos de audio quedaron guardados en la base de
//    datos (las rutas se guardan en las columnas audio_url y
//    audio_observaciones_url) y si esos archivos todavía existen en
//    disco, en la carpeta audios/.
//
// USO:
//   cd C:\TESIS\codigo_postgresql\base-ts-baileys-postgres
//   node scripts/ver-archivos.mjs
// ======================================================

import 'dotenv/config'
import { Pool } from 'pg'
import fs from 'fs'

const pool = new Pool({
    host:     process.env.POSTGRES_DB_HOST,
    user:     process.env.POSTGRES_DB_USER,
    database: process.env.POSTGRES_DB_NAME,
    password: process.env.POSTGRES_DB_PASSWORD,
    port:     +(process.env.POSTGRES_DB_PORT ?? 5432),
    ssl:      process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
})

const revisarArchivo = (ruta) => {
    if (!ruta) return '— (no se envió audio)'
    if (!fs.existsSync(ruta)) return `⚠️ Ruta guardada pero el archivo YA NO EXISTE: ${ruta}`
    const kb = Math.round(fs.statSync(ruta).size / 1024)
    return `✅ ${ruta} (${kb} KB)`
}

try {
    await pool.query('SELECT 1')
} catch (err) {
    console.error('❌ No se pudo conectar a PostgreSQL:', err.message)
    process.exit(1)
}

const res = await pool.query(`
    SELECT
        c.id,
        c.nombre_comunidad,
        c.fecha_registro,
        h.audio_url               AS audio_historia,
        v.audio_observaciones_url AS audio_validacion
    FROM tpc_interesado_comunidad c
    LEFT JOIN ext_historia_territorio    h ON h.comunidad_id = c.id
    LEFT JOIN ext_validacion_comunitaria v ON v.comunidad_id = c.id
    ORDER BY c.fecha_registro DESC
`)

if (res.rows.length === 0) {
    console.log('📭 Todavía no hay ningún registro guardado en la base de datos.')
} else {
    console.log(`📋 ${res.rows.length} registro(s) encontrado(s):\n`)
    for (const r of res.rows) {
        console.log('─'.repeat(60))
        console.log(`#${r.id} — ${r.nombre_comunidad}  (${r.fecha_registro})`)
        console.log(`  🎙️ Audio de historia del territorio: ${revisarArchivo(r.audio_historia)}`)
        console.log(`  🎙️ Audio de validación/observaciones: ${revisarArchivo(r.audio_validacion)}`)
    }
    console.log('─'.repeat(60))
}

await pool.end()
