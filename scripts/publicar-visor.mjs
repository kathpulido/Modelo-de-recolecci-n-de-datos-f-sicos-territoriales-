// ======================================================
// 🌍 Publica el visor geográfico en tu dominio fijo de ngrok
//
//    Uso:  npm run geovisor:publico
//
//    Levanta el visor (puerto 3009) y lo expone en la dirección fija que
//    ya tienes reservada en ngrok — la misma en todos los reinicios, así
//    que el enlace que le pases a tu director o al jurado no se vence.
//
//    Requiere en el .env:
//      NGROK_STATIC_DOMAIN=algo.ngrok-free.dev
//
//    Nota sobre el plan gratuito de ngrok: a quien abre el enlace por
//    primera vez le aparece una pantalla de aviso ("You are about to
//    visit...") y debe tocar "Visit Site". En computador funciona sin
//    problema; en Safari de celular a veces se queda pegada — por eso el
//    chatbot usa Cloudflare y el visor usa ngrok.
//
//    El chatbot se sigue arrancando aparte, con: npm run start:all
//    (son dos túneles distintos y no se estorban).
// ======================================================

import 'dotenv/config'
import { spawn } from 'node:child_process'

const PUERTO  = process.env.GEOVISOR_PORT || 3009
const DOMINIO = process.env.NGROK_STATIC_DOMAIN?.trim()

if (!DOMINIO) {
    console.error('\n❌ Falta NGROK_STATIC_DOMAIN en tu archivo .env')
    console.error('   Reclama tu dominio fijo gratuito en https://dashboard.ngrok.com/domains')
    console.error('   y agrégalo así:  NGROK_STATIC_DOMAIN=algo.ngrok-free.dev\n')
    process.exit(1)
}

const procesos = []

function lanzar(nombre, comando, args) {
    const p = spawn(comando, args, { stdio: 'inherit', shell: true })
    p.on('error', (err) => {
        console.error(`\n❌ No se pudo iniciar ${nombre}: ${err.message}`)
        if (nombre === 'NGROK') {
            console.error('   ¿Está instalado? Verifica con:  ngrok version\n')
        }
        cerrarTodo(1)
    })
    p.on('exit', (codigo) => {
        console.log(`\n⏹️  [${nombre}] terminó (código ${codigo}). Cerrando todo...`)
        cerrarTodo(codigo ?? 0)
    })
    procesos.push(p)
    return p
}

function cerrarTodo(codigo) {
    procesos.forEach((p) => { try { p.kill() } catch { /* ya estaba cerrado */ } })
    process.exit(codigo)
}

console.log('\n' + '='.repeat(62))
console.log('🌍  Visor geográfico — Registro Territorial Comunitario')
console.log('='.repeat(62))
console.log(`   Dirección pública : https://${DOMINIO}`)
console.log(`   Local             : http://localhost:${PUERTO}`)
console.log('')
console.log('   La primera vez que alguien abra el enlace verá un aviso de')
console.log('   ngrok: debe tocar "Visit Site" para continuar. Es normal.')
console.log('='.repeat(62) + '\n')

// El túnel primero, para que la dirección ya esté viva cuando el visor
// termine de levantar y alguien abra el enlace.
lanzar('NGROK', 'ngrok', ['http', `--url=https://${DOMINIO}`, String(PUERTO), '--log=stdout'])
lanzar('VISOR', 'npm', ['run', 'geovisor'])

process.on('SIGINT', () => cerrarTodo(0))
