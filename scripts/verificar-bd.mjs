// ======================================================
// 🔍 Verifica si la base de datos PostgreSQL tiene las tablas
//    necesarias, y muestra cuántos registros hay guardados.
//
// USO:
//   cd C:\TESIS\codigo_postgresql\base-ts-baileys-postgres
//   node scripts/verificar-bd.mjs
//
// No necesita psql — usa el mismo paquete "pg" que ya usa el bot.
// ======================================================

import 'dotenv/config'
import { Pool } from 'pg'

const pool = new Pool({
    host:     process.env.POSTGRES_DB_HOST,
    user:     process.env.POSTGRES_DB_USER,
    database: process.env.POSTGRES_DB_NAME,
    password: process.env.POSTGRES_DB_PASSWORD,
    port:     +(process.env.POSTGRES_DB_PORT ?? 5432),
    ssl:      process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
})

const TABLAS_ESPERADAS = [
    'tpc_interesado_comunidad',
    'tpc_representante_legal',
    'tpc_territorio_propiedad_colectiva',
    'tpc_predio',
    'tpc_derecho',
    'tpc_restriccion',
    'tpc_fuente_espacial',
    'ext_historia_territorio',
    'ext_uso_territorio',
    'ext_validacion_comunitaria',
]

console.log('🔍 Verificando conexión y tablas en la base de datos...')
console.log(`   host=${process.env.POSTGRES_DB_HOST}  db=${process.env.POSTGRES_DB_NAME}  user=${process.env.POSTGRES_DB_USER}\n`)

try {
    await pool.query('SELECT 1')
    console.log('✅ Conexión a PostgreSQL exitosa.\n')
} catch (err) {
    console.error('❌ No se pudo conectar a PostgreSQL:', err.message)
    console.error('\n   Revisa en tu .env: POSTGRES_DB_HOST, POSTGRES_DB_USER, POSTGRES_DB_NAME, POSTGRES_DB_PASSWORD, POSTGRES_DB_PORT.')
    process.exit(1)
}

const res = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
`)
const existentes = new Set(res.rows.map(r => r.table_name))

const faltantes = TABLAS_ESPERADAS.filter(t => !existentes.has(t))

if (faltantes.length > 0) {
    console.log('❌ Faltan estas tablas en tu base de datos:')
    faltantes.forEach(t => console.log(`   - ${t}`))
    console.log('\n👉 Para crearlas, corre:')
    console.log('   node scripts/aplicar-schema.mjs')
} else {
    console.log('✅ Las 10 tablas necesarias existen.\n')

    const total = await pool.query('SELECT count(*) AS n, max(fecha_registro) AS ultimo FROM tpc_interesado_comunidad')
    console.log(`📊 Registros guardados: ${total.rows[0].n}`)
    console.log(`🕐 Último registro: ${total.rows[0].ultimo ?? '(ninguno todavía)'}`)

    if (Number(total.rows[0].n) > 0) {
        const ultimos = await pool.query(`
            SELECT id, nombre_comunidad, fecha_registro
            FROM tpc_interesado_comunidad
            ORDER BY fecha_registro DESC
            LIMIT 5
        `)
        console.log('\n📋 Últimos registros:')
        for (const r of ultimos.rows) {
            console.log(`   #${r.id} — ${r.nombre_comunidad} — ${r.fecha_registro}`)
        }
    }
}

await pool.end()
