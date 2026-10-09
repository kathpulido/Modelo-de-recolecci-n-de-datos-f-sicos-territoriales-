// ======================================================
// 🛠️ Aplica las migraciones de PostGIS y del perímetro territorial
//    (migrate_postgis.sql y migrate_perimetro.sql) sin necesitar psql.
//    Es seguro correrlo varias veces: ambos scripts SQL usan
//    IF NOT EXISTS / CREATE OR REPLACE, no borran datos.
//
// USO:
//   cd C:\TESIS\codigo_postgresql\base-ts-baileys-postgres
//   node scripts/aplicar-migracion-perimetro.mjs
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

// Orden importa: migrate_postgis.sql crea la extensión PostGIS que
// migrate_perimetro.sql necesita (GEOMETRY, ST_GeomFromGeoJSON, etc).
const migraciones = ['migrate_postgis.sql', 'migrate_perimetro.sql']

console.log(`🔍 Conectando a ${process.env.POSTGRES_DB_NAME}...`)

try {
    await pool.query('SELECT 1')
    console.log('✅ Conexión exitosa.\n')
} catch (err) {
    console.error('❌ No se pudo conectar a PostgreSQL:', err.message)
    process.exit(1)
}

for (const nombreArchivo of migraciones) {
    const ruta = path.join(process.cwd(), nombreArchivo)

    if (!fs.existsSync(ruta)) {
        console.error(`❌ No se encontró ${ruta}`)
        console.error('   Corre este comando desde la carpeta raíz del proyecto.')
        process.exit(1)
    }

    const sql = fs.readFileSync(ruta, 'utf-8')
    console.log(`🛠️ Aplicando ${nombreArchivo}...`)

    try {
        await pool.query(sql)
        console.log(`✅ ${nombreArchivo} aplicado correctamente.\n`)
    } catch (err) {
        console.error(`❌ Error aplicando ${nombreArchivo}:`, err.message)
        console.error('   Si el error menciona "postgis", tu servidor de PostgreSQL')
        console.error('   necesita tener instalada la extensión PostGIS primero.')
        process.exit(1)
    }
}

// Verificación final
try {
    const col = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tpc_predio'
          AND column_name IN ('geom', 'geom_perimetro', 'metodo_captura_perimetro',
                               'area_perimetro_calculada_ha', 'geojson_perimetro', 'puntos_recorrido_gps')
        ORDER BY column_name
    `)
    const tabla = await pool.query(`
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_name = 'tpc_captura_perimetro_pendiente'
        ) AS existe
    `)

    console.log('📋 Columnas de perímetro en tpc_predio:')
    col.rows.forEach(r => console.log(`   - ${r.column_name}`))
    console.log(`📋 Tabla tpc_captura_perimetro_pendiente existe: ${tabla.rows[0].existe}`)

    if (col.rows.length === 6 && tabla.rows[0].existe) {
        console.log('\n✅ Migración completa y verificada.')
        console.log('👉 Ahora reinicia el bot para que tome los cambios de app.ts.')
    } else {
        console.log('\n⚠️ Faltan columnas o la tabla — revisa los mensajes de error arriba.')
    }
} catch (err) {
    console.error('❌ Error verificando la migración:', err.message)
}

await pool.end()
