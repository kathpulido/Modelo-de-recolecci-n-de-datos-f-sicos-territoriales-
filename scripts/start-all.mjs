// ======================================================
// 🚀 Arranca Cloudflare Tunnel (cloudflared) primero, corrige
//    BOT_PUBLIC_URL en tu .env, y SOLO DESPUÉS arranca el bot —
//    en un solo comando: npm run start:all
//
// Por qué en ese orden: el bot lee BOT_PUBLIC_URL de tu .env una
// única vez, al arrancar. Si el bot arrancara antes de que el túnel
// avisara su URL pública, se quedaría con el valor viejo (localhost)
// en memoria para siempre, aunque el archivo .env se corrija después.
//
// Qué hace, en orden:
//   1. Lanza cloudflared con un "Quick Tunnel" gratuito — no necesita
//      cuenta ni configuración previa:
//        cloudflared tunnel --url http://localhost:3008
//   2. Espera a que cloudflared imprima su URL pública
//      (algo como https://palabras-al-azar.trycloudflare.com).
//   3. Si BOT_PUBLIC_URL en tu .env no coincide con esa URL, la
//      corrige automáticamente ANTES de seguir.
//   4. Recién ahí lanza "npm run dev" (tu bot), que va a leer el
//      .env ya corregido.
//
// POR QUÉ CLOUDFLARE Y NO NGROK: a diferencia de ngrok, un Quick
// Tunnel de Cloudflare NO le muestra ninguna pantalla de aviso
// ("Visit Site") a quien abre el enlace — ese aviso era el que se
// quedaba pegado en Safari/iOS al abrir el croquis desde WhatsApp.
//
// LO QUE HAY QUE SABER DE UN QUICK TUNNEL GRATIS:
//   - Es gratis, sin cuenta, sin configuración.
//   - La URL (https://algo-random.trycloudflare.com) CAMBIA cada vez
//     que reinicias este script — no hay forma de fijarla sin tener
//     un dominio propio agregado a Cloudflare. Si reinicias, toca
//     actualizar también el Webhook en Meta for Developers
//     (App → WhatsApp → Configuración → Webhook) con la URL nueva.
//
// INSTALAR cloudflared EN WINDOWS (una sola vez):
//   Opción rápida, con winget (viene incluido en Windows 10/11):
//     winget install --id Cloudflare.cloudflared
//   Alternativa manual: descargar el instalador .msi desde
//     https://github.com/cloudflare/cloudflared/releases/latest
//     (elige cloudflared-windows-amd64.msi para la mayoría de PCs)
//   Después de instalar, ABRE UNA TERMINAL NUEVA (para que reconozca
//   el comando) y verifica escribiendo:  cloudflared --version
//
// Detener todo: Ctrl+C una sola vez (cierra las dos cosas).
// ======================================================

import 'dotenv/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ENV_PATH = path.join(process.cwd(), '.env')
const PUERTO = process.env.PORT || 3008

// Si defines estas dos en tu .env, se usa un túnel FIJO con tu dominio y
// la URL deja de cambiar en cada reinicio (ver PUBLICAR.md):
//   TUNEL_NOMBRE=catastro
//   TUNEL_DOMINIO=midominio.org      → el bot queda en https://bot.midominio.org
const TUNEL_NOMBRE  = process.env.TUNEL_NOMBRE?.trim()
const TUNEL_DOMINIO = process.env.TUNEL_DOMINIO?.trim()
const URL_FIJA = (TUNEL_NOMBRE && TUNEL_DOMINIO) ? `https://bot.${TUNEL_DOMINIO}` : null

function lanzar(nombre, comando, args, envExtra = {}) {
    const proceso = spawn(comando, args, {
        stdio: 'inherit',
        shell: true,
        // OJO: no basta con corregir BOT_PUBLIC_URL en el archivo .env.
        // Este proceso hijo hereda por defecto el process.env de este
        // script (start-all.mjs), que ya cargó el .env VIEJO al arrancar
        // (antes de que supiéramos la URL nueva de Cloudflare). Y como
        // dotenv nunca pisa una variable que ya viene puesta, el bot se
        // quedaría para siempre con el valor viejo aunque el archivo en
        // disco ya esté corregido. Por eso se lo pasamos explícito aquí.
        env: { ...process.env, ...envExtra },
    })
    proceso.on('exit', (codigo) => {
        console.log(`\n⏹️  [${nombre}] terminó (código ${codigo}). Cerrando todo...`)
        process.exit(codigo ?? 0)
    })
    return proceso
}

// Actualiza (o agrega) la línea BOT_PUBLIC_URL=... dentro de .env,
// sin tocar el resto del archivo.
function actualizarBotPublicUrlEnEnv(nuevaUrl) {
    if (!fs.existsSync(ENV_PATH)) return false
    const contenido = fs.readFileSync(ENV_PATH, 'utf-8')
    const linea = `BOT_PUBLIC_URL=${nuevaUrl}`
    let actualizado
    if (/^BOT_PUBLIC_URL=.*$/m.test(contenido)) {
        actualizado = contenido.replace(/^BOT_PUBLIC_URL=.*$/m, linea)
    } else {
        actualizado = contenido.trimEnd() + `\n${linea}\n`
    }
    if (actualizado === contenido) return false
    fs.writeFileSync(ENV_PATH, actualizado)
    return true
}

// Lanza cloudflared con salida "pipe" (en vez de "inherit") para
// poder leer su texto y detectar la URL — pero igual la va
// imprimiendo en pantalla en tiempo real, como antes.
function lanzarCloudflared() {
    const args = URL_FIJA
        ? ['tunnel', 'run', TUNEL_NOMBRE]                       // túnel fijo, con tu dominio
        : ['tunnel', '--url', `http://localhost:${PUERTO}`]     // túnel temporal, URL al azar

    if (URL_FIJA) {
        console.log(`🚀 Iniciando el túnel fijo "${TUNEL_NOMBRE}" (dominio ${TUNEL_DOMINIO})...\n`)
    } else {
        console.log(`🚀 Iniciando Cloudflare Tunnel (cloudflared) hacia http://localhost:${PUERTO}...\n`)
    }

    const proceso = spawn('cloudflared', args, { shell: true })
    proceso.on('error', (err) => {
        console.error(`\n❌ No se pudo iniciar cloudflared: ${err.message}`)
        console.error('   ¿Ya lo instalaste? Ver instrucciones al inicio de este archivo (start-all.mjs).')
        process.exit(1)
    })
    proceso.on('exit', (codigo) => {
        console.log(`\n⏹️  [CLOUDFLARED] terminó (código ${codigo}). Cerrando todo...`)
        process.exit(codigo ?? 0)
    })
    return proceso
}

// Espera a que cloudflared imprima su URL pública en la consola
// (la escribe por stderr, mezclada con el resto de sus logs).
function esperarUrlCloudflared(proceso, timeoutMs = 45000) {
    return new Promise((resolve) => {
        let resuelto = false
        const patron = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

        const revisar = (chunk) => {
            const texto = chunk.toString()
            process.stdout.write(texto) // seguimos viendo el log de cloudflared en pantalla
            if (resuelto) return
            const m = texto.match(patron)
            if (m) {
                resuelto = true
                resolve(m[0])
            }
        }

        proceso.stdout.on('data', revisar)
        proceso.stderr.on('data', revisar)

        setTimeout(() => {
            if (!resuelto) {
                resuelto = true
                resolve(null)
            }
        }, timeoutMs)
    })
}

async function main() {
    const cloudflared = lanzarCloudflared()
    // Con un túnel fijo la dirección ya se conoce: no hay que esperar a que
    // cloudflared la anuncie ni adivinarla leyendo su registro.
    const url = URL_FIJA ?? await esperarUrlCloudflared(cloudflared)

    if (!url) {
        console.log('⚠️ No se pudo leer la URL de Cloudflare Tunnel automáticamente en 45 segundos.')
        console.log('   Revisa el mensaje de arriba: si dice algo como "no se reconoce el comando"')
        console.log('   o "command not found", cloudflared no está instalado — ver instrucciones al')
        console.log('   inicio de este archivo. Sin la URL, el bot va a arrancar igual, pero los')
        console.log('   enlaces de croquis/recorrido van a seguir mostrando localhost.')
    } else {
        console.log('\n' + '='.repeat(60))
        console.log(`🌐 URL pública (Cloudflare Tunnel): ${url}`)
        console.log(`🔗 URL de webhook para Meta: ${url}/webhook`)

        const urlActualEnEnv = process.env.BOT_PUBLIC_URL?.trim()
        if (urlActualEnEnv !== url) {
            const ok = actualizarBotPublicUrlEnEnv(url)
            if (ok) {
                console.log('')
                console.log(`✏️  BOT_PUBLIC_URL en .env se corrigió automáticamente a: ${url}`)
                console.log('    El bot va a arrancar ahora mismo ya con este valor correcto.')
            } else {
                console.log('')
                console.log('⚠️  No pude actualizar BOT_PUBLIC_URL en tu .env automáticamente.')
                console.log(`    Actualízalo a mano: BOT_PUBLIC_URL=${url}`)
            }
        } else {
            console.log('✅ BOT_PUBLIC_URL en tu .env ya coincide con esta URL — no hace falta cambiar nada.')
        }

        console.log('')
        if (URL_FIJA) {
            console.log('📌 Dirección fija: no cambia aunque reinicies, así que el webhook de Meta')
            console.log('   queda configurado una sola vez.')
            console.log(`   Visor geográfico: https://visor.${TUNEL_DOMINIO}`)
        } else {
            console.log('⚠️  Recuerda: esta URL es temporal y va a cambiar la próxima vez que reinicies —')
            console.log('    toca actualizarla también en Meta for Developers (App → WhatsApp →')
            console.log('    Configuración → Webhook).')
            console.log('    Para tener una dirección fija, ver PUBLICAR.md')
        }
        console.log('='.repeat(60) + '\n')
    }

    console.log('🚀 Arrancando el bot...\n')
    const bot = lanzar('BOT', 'npm', ['run', 'dev'], url ? { BOT_PUBLIC_URL: url } : {})

    process.on('SIGINT', () => {
        bot.kill()
        cloudflared.kill()
        process.exit(0)
    })
}

main()
