// ======================================================
// 🛠️ Crea las tablas necesarias en PostgreSQL a partir de schema.sql,
//    sin necesitar psql instalado.
//
// USO:
//   cd C:\TESIS\codigo_postgresql\base-ts-baileys-postgres
//   node scripts/aplicar-schema.mjs
// ======================================================

import 'dotenv/config'
import { Pool } from 'pg'
import fs from 'fs'
import path from 'path'

const pool = new Pool({
    host:     process.env.POSTGRES_DB_HOST,
    user:     process.env.POSTGRES_DB_USER,
    database: process.env.POSTGRES_DB_NAME,
    password: process.env.POSTGRES_DB_PASSWORD,
    port:     +(process.env.POSTGRES_DB_PORT ?? 5432),
    ssl:      process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
})

const rutaSchema = path.join(process.cwd(), 'schema.sql')

if (!fs.existsSync(rutaSchema)) {
    console.error(`❌ No se encontró ${rutaSchema}`)
    console.error('   Corre este comando desde la carpeta raíz del proyecto.')
    process.exit(1)
}

const sql = fs.readFileSync(rutaSchema, 'utf-8')

console.log(`🔍 Conectando a ${process.env.POSTGRES_DB_NAME}...`)

try {
    await pool.query('SELECT 1')
    console.log('✅ Conexión exitosa.\n')
} catch (err) {
    console.error('❌ No se pudo conectar a PostgreSQL:', err.message)
    process.exit(1)
}

console.log('🛠️ Aplicando schema.sql (crea tablas solo si no existen — no borra nada)...\n')

try {
    await pool.query(sql)
    console.log('✅ Schema aplicado correctamente.\n')

    const res = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name
    `)
    console.log('📋 Tablas en la base de datos ahora:')
    res.rows.forEach(r => console.log(`   - ${r.table_name}`))

    console.log('\n👉 Ahora corre: node scripts/verificar-bd.mjs')
} catch (err) {
    console.error('❌ Error aplicando el schema:', err.message)
    process.exit(1)
}

await pool.end()
