// generar_audios_azure.mjs — ES Module
// ══════════════════════════════════════════════════════════════════
//   Generador de Audios — Registro Territorial Comunitario
//   Voz femenina natural (Azure Speech, neural, español de Colombia)
// ══════════════════════════════════════════════════════════════════
//
//  Reemplaza a generar_audios.mjs (que usaba Google Translate TTS,
//  con voz robótica). Este script usa Azure Speech — voces neuronales
//  mucho más naturales y expresivas.
//
//  CONFIGURACIÓN (una sola vez):
//    1. Crea una cuenta gratuita de Azure AI Speech:
//       https://portal.azure.com → "Crear un recurso" → "Speech"
//       (capa gratuita F0: 500.000 caracteres/mes, de sobra para esto)
//    2. Copia la "KEY 1" y la "Región" (ej: eastus) del recurso creado
//    3. Agrega a tu archivo .env:
//         AZURE_SPEECH_KEY=tu_clave_aqui
//         AZURE_SPEECH_REGION=eastus
//
//  USO:
//    node generar_audios_azure.mjs
//
//  Los archivos se guardan en  Preguntas/  (sin carpeta repetida) —
//  así es donde app.ts los busca (PREGUNTAS_DIR), mismos nombres que
//  antes. Si un audio ya existe se omite — para forzar la regeneración
//  de TODOS, borra la carpeta Preguntas/ antes de correr el script.
// ══════════════════════════════════════════════════════════════════

import 'dotenv/config'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { setTimeout as sleep } from 'timers/promises'
import https from 'https'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const AZURE_KEY    = process.env.AZURE_SPEECH_KEY
const AZURE_REGION = process.env.AZURE_SPEECH_REGION

if (!AZURE_KEY || !AZURE_REGION) {
    console.error('❌ Faltan AZURE_SPEECH_KEY y/o AZURE_SPEECH_REGION en tu archivo .env')
    console.error('   Ver instrucciones al inicio de este archivo (generar_audios_azure.mjs).')
    process.exit(1)
}

// Voz neuronal femenina, español de Colombia. Para escuchar el catálogo
// completo de voces: https://speech.microsoft.com/portal/voicegallery
const VOZ = 'es-CO-SalomeNeural'

// app.ts lee los audios de PREGUNTAS_DIR = 'Preguntas/' (sin carpeta
// repetida) — hay que escribir ahí, o el bot nunca los va a encontrar
// (AUDIO_CACHE quedaría vacío).
const OUTPUT_DIR = join(__dirname, 'Preguntas')
mkdirSync(OUTPUT_DIR, { recursive: true })

// ── Todos los audios (texto actualizado: sin mención a "módulos", con
//    las mismas transiciones cálidas que ahora aparecen en el chat) ──
const AUDIOS = {

  // ─── BIENVENIDA Y CONSENTIMIENTO ──────────────────────────────
  'Bienvenida.mp3':
    'Bienvenido o bienvenida al Registro Territorial Comunitario. ' +
    'Este espacio fue creado para recoger, con respeto y cuidado, ' +
    'la información del territorio de su comunidad. ' +
    'Los datos que comparta se van a usar únicamente para el reconocimiento ' +
    'y la protección de los derechos territoriales de su pueblo.',

  'Consentimiento.mp3':
    '¿Nos autoriza a recopilar esta información de forma voluntaria ' +
    'para el reconocimiento y protección de los derechos territoriales de su pueblo? ' +
    'Responda uno si acepta, o dos si no acepta.',

  'Continuar.mp3':
    '¿Está listo o lista para continuar con el registro ahora? ' +
    'Responda uno para continuar ahora, o dos si prefiere hacerlo después.',

  'Preferencia audio.mp3':
    '¿Le gustaría escuchar cada pregunta en audio? ' +
    'Si activa esta opción, cada pregunta le va a llegar en un mensaje de voz ' +
    'y también en texto. ' +
    'Responda uno para activar el audio, o dos para solo texto.',

  'Modulo 0B modo uso.mp3':
    '¿Cómo desea completar el registro? ' +
    'Responda uno para hacerlo en línea, aquí mismo por WhatsApp, ' +
    'o dos si prefiere usar el formulario sin conexión a internet.',

  // ─── UBICACIÓN DEL TERRITORIO (ahora va primero) ──────────────
  'Modulo 4 gps.mp3':
    'Para arrancar, ubiquemos el territorio en el mapa, así avanzamos más rápido ' +
    'en el resto de las preguntas. ' +
    'Toque el clip y luego ubicación, para enviar su ubicación actual. ' +
    'Si prefiere no compartirla, escriba: no. Y seguimos escribiendo el lugar a mano.',

  'Modulo 4 departamento.mp3':
    '¿En qué departamento se encuentra el territorio?',

  'Modulo 4 municipio.mp3':
    '¿Y en qué municipio?',

  'Modulo 4 vereda.mp3':
    '¿Y en qué vereda o corregimiento está el territorio?',

  // ─── IDENTIDAD DE LA COMUNIDAD ─────────────────────────────────
  'Modulo 1 inicio.mp3':
    'Comenzamos conociéndoles. Estas preguntas nos ayudan a identificar correctamente su comunidad. ' +
    '¿Cuál es el nombre con el que se identifica su comunidad? ' +
    'Escriba el nombre completo tal como lo usan oficialmente.',

  'Pregunta 2.mp3':
    '¿Cómo describiría el tipo de comunidad a la que pertenece? ' +
    'Las opciones son: ' +
    'número uno, Comunidad negra o consejo comunitario. ' +
    'Número dos, Cabildo indígena. ' +
    'Número tres, Parcialidad. ' +
    'Número cuatro, Resguardo indígena. ' +
    'Número cinco, Territorio colectivo.',

  'Pregunta 3.mp3':
    '¿A qué pueblo indígena o grupo étnico pertenece su comunidad? ' +
    'Escriba el nombre de su pueblo o grupo étnico.',

  'Pregunta 4.mp3':
    '¿Cómo se organizan como comunidad? ' +
    'Las opciones son: ' +
    'número uno, Cabildo. ' +
    'Número dos, Autoridades tradicionales. ' +
    'Número tres, Asamblea comunitaria. ' +
    'Número cuatro, Consejo comunitario. ' +
    'Número cinco, Otro.',

  'Pregunta 5.mp3':
    '¿Cuántas familias viven aproximadamente en el territorio? ' +
    'Escriba solo el número. Por ejemplo: cuarenta y cinco.',

  'Pregunta 6.mp3':
    '¿Cuántas personas viven aproximadamente en el territorio? ' +
    'Escriba solo el número. Por ejemplo: trescientas veinte.',

  'Pregunta 7.mp3':
    '¿Cuántas son mujeres? ' +
    'Escriba solo el número aproximado. Por ejemplo: ciento sesenta.',

  'Pregunta 8.mp3':
    '¿Y cuántos son hombres? ' +
    'Escriba solo el número aproximado. Por ejemplo: ciento sesenta.',

  // ─── REPRESENTANTE LEGAL Y AUTORIDADES ─────────────────────────
  'Modulo 2 inicio.mp3':
    'Perfecto, ya sé quiénes son. Ahora hablemos de quién los representa ante las autoridades. ' +
    '¿Cuál es el nombre completo del representante legal o autoridad principal de la comunidad?',

  'Modulo 2 cargo.mp3':
    '¿Qué cargo ocupa esta persona dentro de la comunidad? ' +
    'Las opciones son: ' +
    'número uno, Gobernador o Gobernadora. ' +
    'Número dos, Capitán. ' +
    'Número tres, Cacique. ' +
    'Número cuatro, Autoridad tradicional. ' +
    'Número cinco, Representante legal del consejo comunitario. ' +
    'Número seis, Otro cargo.',

  'Modulo 2 documento.mp3':
    '¿Cuál es el número de documento de identidad del representante? ' +
    'Si no aplica, escriba: no aplica.',

  'Modulo 2 legitimidad.mp3':
    '¿Esta persona fue elegida o reconocida por la comunidad? ' +
    'Responda uno si sí fue elegida, o dos si está en proceso.',

  // ─── HISTORIA DEL TERRITORIO ────────────────────────────────────
  'Modulo 3 inicio.mp3':
    'Ahora me gustaría conocer la historia de su territorio. ' +
    'Esto es tan importante como los datos técnicos, así que tómese el tiempo que necesite. ' +
    '¿Desde cuándo habita su comunidad este territorio? ' +
    'Las opciones son: ' +
    'número uno, Desde siempre, es un territorio ancestral. ' +
    'Número dos, Desde hace muchos años, varias generaciones. ' +
    'Número tres, Desde una fecha aproximada que conocemos. ' +
    'Número cuatro, No conocemos la fecha exacta.',

  'Pregunta historia1.mp3':
    '¿Puede contarnos cómo llegaron a este territorio y por qué es importante para su comunidad? ' +
    'Puede enviar un mensaje de texto o de voz contando los detalles.',

  'Pregunta historia2.mp3':
    'Estamos listos para escucharle. Envíe su mensaje de voz contando la historia del territorio.',

  'Pregunta historia3.mp3':
    '¿Desea enviar un mensaje de voz contando con más detalle la historia del territorio? ' +
    'Su voz es importante y va a quedar guardada. ' +
    'Responda uno para enviar audio, o dos si el texto es suficiente.',

  // ─── TERRITORIO (nombre, predio, área, procedimiento, límites...) ─
  'Modulo 4 nombre territorio.mp3':
    'Gracias por compartir esa historia. Ahora sigamos con los datos formales del territorio. ' +
    '¿Cuál es el nombre oficial del territorio o resguardo?',

  'Modulo 4 predio.mp3':
    '¿Cuál es el nombre del predio según documentos oficiales? ' +
    'Si no tiene nombre registrado, escriba: sin nombre.',

  'Modulo 4 area.mp3':
    '¿Conoce el área aproximada del territorio en hectáreas? ' +
    'Escriba solo el número. Si no sabe, escriba: desconocida.',

  'Modulo 4 procedimiento.mp3':
    '¿Cuál fue el tipo de procedimiento de reconocimiento del territorio? ' +
    'Las opciones son: ' +
    'número uno, Ampliación de resguardo indígena. ' +
    'Número dos, Ampliación y saneamiento de resguardo. ' +
    'Número tres, Reestructuración de resguardo. ' +
    'Número cuatro, Conversión de reserva en resguardo. ' +
    'Número cinco, Titulación de comunidades negras. ' +
    'Número seis, En proceso o aún no reconocido.',

  'Modulo 4 limites.mp3':
    '¿Cómo describe su comunidad los límites del territorio? ' +
    'Las opciones son: ' +
    'número uno, Ríos y quebradas. ' +
    'Número dos, Montañas y cerros. ' +
    'Número tres, Caminos y senderos. ' +
    'Número cuatro, Hitos naturales como árboles o piedras. ' +
    'Número cinco, Documentos oficiales. ' +
    'Número seis, Combinación de los anteriores.',

  'Modulo 4 reconocimiento.mp3':
    '¿El territorio ha sido reconocido oficialmente por el Estado colombiano? ' +
    'Responda uno si sí está reconocido, ' +
    'dos si no está reconocido, ' +
    'o tres si no lo saben.',

  'Modulo 4 zonas.mp3':
    '¿Existen zonas especiales dentro del territorio? ' +
    'Por ejemplo: lugares sagrados, de conservación, o sitios de importancia cultural. ' +
    'Responda uno si sí existen, o dos si no existen.',

  // ─── DERECHOS Y RESTRICCIONES ────────────────────────────────────
  'Modulo 5 derecho.mp3':
    'Ya casi terminamos la parte del territorio. Ahora unas preguntas sobre los derechos ' +
    'y posibles restricciones que existan sobre él, esto es clave para el reconocimiento legal. ' +
    '¿Qué tipo de derecho tiene la comunidad sobre el territorio? ' +
    'Las opciones son: ' +
    'número uno, Propiedad colectiva reconocida. ' +
    'Número dos, Posesión ancestral sin título formal. ' +
    'Número tres, Uso y usufructo del territorio. ' +
    'Número cuatro, En proceso de legalización. ' +
    'Número cinco, Desconocemos el tipo de derecho.',

  'Modulo 5 restriccion.mp3':
    '¿Existen restricciones o servidumbres sobre el territorio? ' +
    'Las opciones son: ' +
    'número uno, Actividad minera. ' +
    'Número dos, Oleoducto o gasoducto. ' +
    'Número tres, Línea de energía eléctrica. ' +
    'Número cuatro, Acueducto o alcantarillado. ' +
    'Número cinco, Restricción legal por hidrocarburos. ' +
    'Número seis, No hay restricciones.',

  // ─── USO DEL TERRITORIO ───────────────────────────────────────────
  'Modulo 6 uso.mp3':
    'Ahora cuénteme cómo la comunidad usa y cuida el territorio en el día a día. ' +
    '¿Cuál es el uso principal que le da la comunidad al territorio? ' +
    'Las opciones son: ' +
    'número uno, Uso colectivo comunitario. ' +
    'Número dos, Uso tradicional y cultural. ' +
    'Número tres, Zonas compartidas con otras comunidades. ' +
    'Número cuatro, Uso mixto, colectivo y familiar.',

  'Modulo 6 reglas.mp3':
    '¿La comunidad tiene reglas o normas internas sobre el uso del territorio? ' +
    'Por ejemplo: acuerdos comunitarios, normas ancestrales o reglamentos. ' +
    'Responda uno si sí tienen reglas, o dos si no formalmente.',

  // ─── DOCUMENTOS LEGALES ────────────────────────────────────────────
  'Modulo 7 acto.mp3':
    'Vamos con los documentos oficiales del territorio, si es que existen. ' +
    'No se preocupe si todavía no los tienen, eso también es información válida. ' +
    '¿Existe algún documento oficial que reconozca el territorio? ' +
    'Las opciones son: ' +
    'número uno, Sí, una Resolución. ' +
    'Número dos, Sí, un Acuerdo. ' +
    'Número tres, Sí, un Folio de matrícula inmobiliaria. ' +
    'Número cuatro, No existe documento oficial todavía.',

  'Modulo 7 numero acto.mp3':
    '¿Cuál es el número del acto administrativo? ' +
    'Si no lo sabe, escriba: desconocido.',

  'Modulo 7 fecha acto.mp3':
    '¿Cuál es la fecha del acto administrativo? ' +
    'Use el formato: día, barra, mes, barra, año. ' +
    'Por ejemplo: quince barra cero tres barra dos mil cinco. ' +
    'Si no la sabe, escriba: desconocida.',

  // ─── CARTOGRAFÍA ──────────────────────────────────────────────────
  'Modulo 8 mapa.mp3':
    'Una última pregunta sobre cartografía: ' +
    '¿la comunidad cuenta con algún mapa o plano del territorio? ' +
    'Las opciones son: ' +
    'número uno, Sí, plano oficial del IGAC u otra entidad. ' +
    'Número dos, Sí, mapa comunitario propio. ' +
    'Número tres, No tenemos mapa.',

  'Modulo 8 plano.mp3':
    '¿Tiene número de plano o referencia cartográfica? ' +
    'Si no aplica, escriba: no aplica.',

  // ─── VALIDACIÓN COMUNITARIA ───────────────────────────────────────
  'Modulo 9 validacion.mp3':
    'Ya estamos en la recta final. Estas últimas preguntas son sobre la validación comunitaria, ' +
    'garantizan que todo lo registrado sea legítimo y reconocido por su comunidad. ' +
    '¿La información registrada fue revisada y aprobada por su comunidad? ' +
    'Las opciones son: ' +
    'número uno, Sí, validada en asamblea comunitaria. ' +
    'Número dos, Revisada por las autoridades. ' +
    'Número tres, Aún no ha sido validada.',

  'Modulo 9 observaciones.mp3':
    '¿Desea agregar alguna observación, comentario o aclaración final? ' +
    'Si no tiene observaciones, escriba: ninguna.',

  'Modulo 9 audio final.mp3':
    '¿Desea enviar un mensaje de voz con observaciones o palabras finales de la comunidad? ' +
    'Su voz es importante. ' +
    'Responda uno para grabar audio, o dos si ya terminó.',

  // ─── CIERRE ─────────────────────────────────────────────────────────
  'Cierre.mp3':
    'Gracias por participar en este proceso. ' +
    'Su información contribuye al reconocimiento oficial de los derechos territoriales de su comunidad. ' +
    'Estamos guardando su registro de forma segura. Un momento por favor.',
}

// ── Escapa caracteres especiales de XML/SSML ──────────────────────
const escaparSsml = (t) =>
    t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── Llama a la API REST de Azure Speech y guarda el MP3 ───────────
function generarAudio(nombre, texto) {
    return new Promise((resolve) => {
        const ruta = join(OUTPUT_DIR, nombre)

        if (existsSync(ruta)) {
            console.log(`  ⏭  Ya existe: ${nombre}`)
            return resolve({ ok: true, omitido: true })
        }

        const ssml =
            `<speak version='1.0' xml:lang='es-CO'>` +
            `<voice name='${VOZ}'>` +
            `<prosody rate='-3%'>${escaparSsml(texto)}</prosody>` +
            `</voice></speak>`

        const opciones = {
            hostname: `${AZURE_REGION}.tts.speech.microsoft.com`,
            path:     '/cognitiveservices/v1',
            method:   'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': AZURE_KEY,
                'Content-Type':              'application/ssml+xml',
                'X-Microsoft-OutputFormat':  'audio-24khz-48kbitrate-mono-mp3',
                'User-Agent':                'CatastroEtnicoBot',
            },
        }

        const req = https.request(opciones, (res) => {
            if (res.statusCode !== 200) {
                let cuerpo = ''
                res.on('data', (c) => (cuerpo += c))
                res.on('end', () => {
                    console.log(`  ❌ Error en ${nombre}: HTTP ${res.statusCode} ${cuerpo.slice(0, 200)}`)
                    resolve({ ok: false })
                })
                return
            }
            const partes = []
            res.on('data', (c) => partes.push(c))
            res.on('end', () => {
                const buffer = Buffer.concat(partes)
                writeFileSync(ruta, buffer)
                const kb = Math.round(statSync(ruta).size / 1024)
                console.log(`  ✅ ${nombre} (${kb} KB)`)
                resolve({ ok: true })
            })
        })

        req.on('error', (err) => {
            console.log(`  ❌ Error de red en ${nombre}: ${err.message}`)
            resolve({ ok: false })
        })

        req.write(ssml)
        req.end()
    })
}

// ── Ejecución principal ───────────────────────────────────────────
async function main() {
    const entradas = Object.entries(AUDIOS)
    let ok = 0
    const errores = []

    console.log('╔══════════════════════════════════════════════════════╗')
    console.log('║  Generador de Audios (Azure Speech) — Voz natural    ║')
    console.log('╚══════════════════════════════════════════════════════╝')
    console.log(`\n📁 Carpeta de salida: ${OUTPUT_DIR}`)
    console.log(`🎙️  Voz: ${VOZ}`)
    console.log(`🔊 Audios a generar:  ${entradas.length}\n`)

    for (let i = 0; i < entradas.length; i++) {
        const [nombre, texto] = entradas[i]
        const num = String(i + 1).padStart(2, '0')
        console.log(`[${num}/${entradas.length}]`, nombre)

        const resultado = await generarAudio(nombre, texto)
        if (resultado.ok) {
            ok++
        } else {
            errores.push(nombre)
        }

        // Pausa breve entre peticiones
        await sleep(300)
    }

    console.log('\n' + '═'.repeat(54))
    console.log(`✅ Completados: ${ok}/${entradas.length}`)
    if (errores.length > 0) {
        console.log(`❌ Con errores (${errores.length}):`)
        errores.forEach((e) => console.log(`   - ${e}`))
    }
    console.log(`\n📂 Archivos en: ${OUTPUT_DIR}`)
    console.log('═'.repeat(54))
}

main()
