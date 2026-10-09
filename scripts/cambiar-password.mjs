// ======================================================
// 🔐 Cambiar la contraseña de un usuario del geovisor
//
//    Uso:  node scripts/cambiar-password.mjs
//
//    Por qué existe: la migración inicial crea el usuario "admin" con la
//    contraseña 'admin123'. Mientras el visor solo corría en tu computador
//    eso era tolerable; en cuanto quede publicado en internet, cualquiera
//    que la adivine entra a los datos de las comunidades — polígonos,
//    nombres y documentos de las autoridades. Cámbiala ANTES de publicar.
//
//    La contraseña no se escribe en pantalla mientras la tecleas, no queda
//    en el historial de la terminal y se guarda cifrada con bcrypt (nunca
//    en texto plano).
// ======================================================

import 'dotenv/config'
import { Pool } from 'pg'
import bcrypt from 'bcryptjs'
import readline from 'node:readline'

const pool = new Pool({
    host:     process.env.POSTGRES_DB_HOST,
    user:     process.env.POSTGRES_DB_USER,
    database: process.env.POSTGRES_DB_NAME,
    password: process.env.POSTGRES_DB_PASSWORD,
    port:     +(process.env.POSTGRES_DB_PORT ?? 5432),
})

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const preguntar = (t) => new Promise((r) => rl.question(t, (x) => r(x.trim())))

/**
 * Igual que preguntar(), pero enmascarando lo que se teclea: en cada tecla
 * se reescribe la linea con asteriscos, para que la contrasena no quede
 * visible en pantalla.
 */
const preguntarOculto = (t) =>
    new Promise((resolver) => {
        const alEscribir = (c) => {
            const s = String(c)
            if (s === '\n' || s === '\r' || s === '\u0004') {   // Enter / Ctrl-D
                process.stdin.removeListener('data', alEscribir)
                return
            }
            if (process.stdout.clearLine) {
                process.stdout.clearLine(0)
                process.stdout.cursorTo(0)
            }
            process.stdout.write(t + '*'.repeat(rl.line.length))
        }
        process.stdin.on('data', alEscribir)
        rl.question(t, (valor) => {
            process.stdin.removeListener('data', alEscribir)
            process.stdout.write('\n')
            resolver(valor.trim())
        })
    })

const problemasDe = (p) => {
    const fallos = []
    if (p.length < 10) fallos.push('debe tener al menos 10 caracteres')
    if (!/[a-z]/.test(p) || !/[A-Z]/.test(p)) fallos.push('debe combinar mayúsculas y minúsculas')
    if (!/\d/.test(p)) fallos.push('debe incluir al menos un número')
    const comunes = ['admin123', 'password', '12345678', 'catastro', 'admin1234', 'qwerty123']
    if (comunes.some((c) => p.toLowerCase().includes(c))) fallos.push('es demasiado predecible')
    return fallos
}

const main = async () => {
    console.log('\n🔐 Cambiar contraseña — Geovisor Catastro Étnico\n')

    try {
        await pool.query('SELECT 1')
    } catch (err) {
        console.error('❌ No se pudo conectar a PostgreSQL:', err.message)
        console.error('   Revisa las variables POSTGRES_* de tu archivo .env\n')
        process.exit(1)
    }

    const { rows: usuarios } = await pool.query(
        'SELECT username, nombre, rol FROM geovisor_users WHERE activo = true ORDER BY id'
    )
    if (!usuarios.length) {
        console.error('❌ No hay usuarios activos en geovisor_users.\n')
        process.exit(1)
    }

    console.log('Usuarios activos:')
    usuarios.forEach((u) => console.log(`   • ${u.username}  (${u.nombre ?? 'sin nombre'} — ${u.rol})`))
    console.log('')

    const usuario = (await preguntar('Usuario a modificar [admin]: ')) || 'admin'
    if (!usuarios.some((u) => u.username === usuario)) {
        console.error(`\n❌ El usuario "${usuario}" no existe o está inactivo.\n`)
        process.exit(1)
    }

    let nueva
    while (true) {
        nueva = await preguntarOculto('Nueva contraseña: ')
        const fallos = problemasDe(nueva)
        if (fallos.length) {
            console.log('⚠️  La contraseña ' + fallos.join(', ') + '.\n')
            continue
        }
        const repetida = await preguntarOculto('Repítela para confirmar: ')
        if (nueva !== repetida) {
            console.log('⚠️  Las dos contraseñas no coinciden. Intente de nuevo.\n')
            continue
        }
        break
    }

    const hash = await bcrypt.hash(nueva, 12)
    await pool.query('UPDATE geovisor_users SET password_hash = $1 WHERE username = $2', [hash, usuario])

    console.log(`\n✅ Contraseña de "${usuario}" actualizada y guardada cifrada.`)
    console.log('   Las sesiones abiertas siguen siendo válidas hasta que caduquen (8 horas).')
    console.log('   Si sospecha que alguien tenía acceso, cambie también GEOVISOR_JWT_SECRET')
    console.log('   en el .env: eso invalida de inmediato todas las sesiones.\n')

    rl.close()
    await pool.end()
}

main().catch((err) => {
    console.error('\n❌ Error:', err.message, '\n')
    process.exit(1)
})
