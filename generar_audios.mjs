// generar_audios.mjs  —  ES Module (compatible con "type":"module")
// ══════════════════════════════════════════════════════════════════
//   Generador de Audios — Registro Territorial Comunitario
//   Todos los módulos 0 al 9  ·  52 archivos MP3
// ══════════════════════════════════════════════════════════════════
//
//  INSTALACIÓN (una sola vez):
//    npm install node-gtts
//
//  USO:
//    node generar_audios.mjs
//
//  Los archivos se guardan en  Preguntas/  (junto a app.ts)
//  Requiere conexión a internet.
// ══════════════════════════════════════════════════════════════════

import { createRequire } from 'module'
import { existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { setTimeout as sleep } from 'timers/promises'

// node-gtts es CommonJS, lo cargamos con createRequire
const require  = createRequire(import.meta.url)
const gTTS     = require('node-gtts')
const gtts     = gTTS('es')

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

// ── Configuración ─────────────────────────────────────────────────
const OUTPUT_DIR = join(__dirname, 'Preguntas')
mkdirSync(OUTPUT_DIR, { recursive: true })

// ── Todos los audios ──────────────────────────────────────────────
const AUDIOS = {

  // ─── MÓDULO 0: CONSENTIMIENTO Y BIENVENIDA ────────────────────
  'Bienvenida.mp3':
    'Bienvenido o bienvenida al Registro Territorial Comunitario. ' +
    'Este espacio ha sido creado para recoger, con respeto y cuidado, ' +
    'la información del territorio de su comunidad. ' +
    'Los datos que comparta serán usados únicamente para el reconocimiento ' +
    'y protección de los derechos territoriales de su pueblo.',

  'Consentimiento.mp3':
    '¿Nos autoriza a recopilar esta información de forma voluntaria ' +
    'para el reconocimiento y protección de los derechos territoriales de su pueblo? ' +
    'Responda uno si acepta, o dos si no acepta.',

  'Continuar.mp3':
    '¿Está listo o lista para continuar con el registro ahora? ' +
    'Responda uno para continuar ahora, o dos si lo hará después.',

  'Preferencia audio.mp3':
    '¿Le gustaría escuchar cada pregunta en audio? ' +
    'Si activa esta opción, cada pregunta llegará primero en un mensaje de voz ' +
    'y luego en texto. ' +
    'Responda uno para activar el audio, o dos para solo texto.',

  // ✅ AGREGADO: esta pregunta (módulo 0B) no tenía audio asignado — se
  // enviaba solo como texto aunque la persona hubiera elegido "con audio".
  'Modulo 0B modo uso.mp3':
    '¿Cómo desea completar el registro? ' +
    'Responda uno para hacerlo en línea, aquí mismo por WhatsApp, ' +
    'o dos si prefiere usar el formulario sin conexión a internet.',

  // ─── MÓDULO 1: IDENTIDAD DE LA COMUNIDAD ─────────────────────
  'Modulo 1 inicio.mp3':
    'Módulo uno de nueve: Identidad de la comunidad. ' +
    'Comenzamos conociéndoles. ' +
    'Estas preguntas nos ayudan a identificar correctamente su comunidad.',

  'Pregunta 1.mp3':
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

  // ─── MÓDULO 2: REPRESENTANTE LEGAL ───────────────────────────
  'Modulo 2 inicio.mp3':
    'Módulo dos de nueve: Autoridades y representante legal. ' +
    '¿Cuál es el nombre completo del representante legal ' +
    'o autoridad principal de la comunidad?',

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

  // ─── MÓDULO 3: HISTORIA DEL TERRITORIO ───────────────────────
  'Modulo 3 inicio.mp3':
    'Módulo tres de nueve: Historia y memoria del territorio. ' +
    'La historia de su territorio es fundamental. ' +
    'Cuéntenos con confianza.',

  'Pregunta historia1.mp3':
    '¿Desde cuándo habita su comunidad este territorio? ' +
    'Las opciones son: ' +
    'número uno, Desde siempre, es un territorio ancestral. ' +
    'Número dos, Desde hace muchos años, varias generaciones. ' +
    'Número tres, Desde una fecha aproximada que conocemos. ' +
    'Número cuatro, No conocemos la fecha exacta.',

  'Pregunta historia2.mp3':
    '¿Puede contarnos brevemente cómo llegaron a este territorio ' +
    'y por qué es importante para su comunidad? ' +
    'Escriba lo que desee compartir.',

  'Pregunta historia3.mp3':
    '¿Desea enviar un mensaje de voz contando con más detalle ' +
    'la historia del territorio? Su voz es importante y quedará guardada. ' +
    'Responda uno para enviar audio, o dos si el texto es suficiente.',

  // ─── MÓDULO 4: TERRITORIO Y UBICACIÓN ────────────────────────
  'Modulo 4 inicio.mp3':
    'Módulo cuatro de nueve: Territorio y ubicación. ' +
    'Ahora registraremos la información del territorio que habita su comunidad.',

  'Modulo 4 nombre territorio.mp3':
    '¿Cuál es el nombre oficial del territorio o resguardo? ' +
    'Escriba el nombre completo como aparece en documentos oficiales.',

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
    'Por ejemplo: lugares sagrados, de conservación, ' +
    'o sitios de importancia cultural. ' +
    'Responda uno si sí existen, o dos si no existen.',

  'Modulo 4 gps.mp3':
    '¿Puede compartir la ubicación GPS del territorio? ' +
    'Esto nos ayuda a registrar las coordenadas exactas de forma automática. ' +
    'Responda uno para compartir la ubicación, ' +
    'o dos para ingresar los datos manualmente.',

  'Modulo 4 departamento.mp3':
    '¿En qué departamento se encuentra el territorio? ' +
    'Si ya lo detectamos correctamente, escriba: confirmo.',

  'Modulo 4 municipio.mp3':
    '¿En qué municipio se encuentra el territorio? ' +
    'Si ya está correcto, escriba: confirmo.',

  'Modulo 4 vereda.mp3':
    '¿En qué vereda o corregimiento está ubicado el territorio?',

  // ─── MÓDULO 5: DERECHOS Y RESTRICCIONES ──────────────────────
  'Modulo 5 inicio.mp3':
    'Módulo cinco de nueve: Derechos y restricciones del territorio. ' +
    'Esta sección es muy importante para el reconocimiento legal de su territorio.',

  'Modulo 5 derecho.mp3':
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

  // ─── MÓDULO 6: USO DEL TERRITORIO ────────────────────────────
  'Modulo 6 inicio.mp3':
    'Módulo seis de nueve: Uso del territorio. ' +
    'Cuéntenos cómo su comunidad usa y cuida el territorio que habita.',

  'Modulo 6 uso.mp3':
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

  // ─── MÓDULO 7: DOCUMENTOS LEGALES ────────────────────────────
  'Modulo 7 inicio.mp3':
    'Módulo siete de nueve: Documentos legales del territorio. ' +
    'Ahora registraremos los documentos oficiales que respaldan su territorio.',

  'Modulo 7 acto.mp3':
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

  // ─── MÓDULO 8: CARTOGRAFÍA ────────────────────────────────────
  'Modulo 8 inicio.mp3':
    'Módulo ocho de nueve: Cartografía y mapas del territorio. ' +
    'Los mapas y planos son herramientas importantes para la protección territorial.',

  'Modulo 8 mapa.mp3':
    '¿La comunidad cuenta con algún mapa o plano del territorio? ' +
    'Las opciones son: ' +
    'número uno, Sí, plano oficial del IGAC u otra entidad. ' +
    'Número dos, Sí, mapa comunitario propio. ' +
    'Número tres, No tenemos mapa.',

  'Modulo 8 plano.mp3':
    '¿Tiene número de plano o referencia cartográfica? ' +
    'Si no aplica, escriba: no aplica.',

  // ─── MÓDULO 9: VALIDACIÓN COMUNITARIA ────────────────────────
  'Modulo 9 inicio.mp3':
    'Módulo nueve de nueve: Validación comunitaria. ' +
    'Último módulo. La validación garantiza que la información ' +
    'sea legítima y reconocida por su comunidad.',

  'Modulo 9 validacion.mp3':
    '¿La información registrada fue revisada y aprobada por su comunidad? ' +
    'Las opciones son: ' +
    'número uno, Sí, validada en asamblea comunitaria. ' +
    'Número dos, Revisada por las autoridades. ' +
    'Número tres, Aún no ha sido validada.',

  'Modulo 9 observaciones.mp3':
    '¿Desea agregar alguna observación, comentario o aclaración final? ' +
    'Si no tiene observaciones, escriba: ninguna.',

  'Modulo 9 audio final.mp3':
    '¿Desea enviar un mensaje de voz con observaciones ' +
    'o palabras finales de la comunidad? ' +
    'Su voz es importante. ' +
    'Responda uno para grabar audio, o dos si ya terminó.',

  // ─── CIERRE ───────────────────────────────────────────────────
  'Cierre.mp3':
    'Gracias por participar en este proceso. ' +
    'Su información contribuye al reconocimiento oficial ' +
    'de los derechos territoriales de su comunidad. ' +
    'Estamos guardando su registro de forma segura. ' +
    'Un momento por favor.',
}

// ── Función que genera un audio con promesa ───────────────────────
function generarAudio (nombre, texto) {
  return new Promise((resolve) => {
    const ruta = join(OUTPUT_DIR, nombre)

    if (existsSync(ruta)) {
      console.log(`  ⏭  Ya existe: ${nombre}`)
      return resolve({ ok: true, omitido: true })
    }

    gtts.save(ruta, texto, (err) => {
      if (err) {
        console.log(`  ❌ Error en ${nombre}: ${err.message}`)
        resolve({ ok: false })
      } else {
        const kb = Math.round(statSync(ruta).size / 1024)
        console.log(`  ✅ ${nombre} (${kb} KB)`)
        resolve({ ok: true })
      }
    })
  })
}

// ── Ejecución principal ───────────────────────────────────────────
async function main () {
  const entradas = Object.entries(AUDIOS)
  let ok = 0
  const errores = []

  console.log('╔══════════════════════════════════════════════════════╗')
  console.log('║  Generador de Audios — Registro Territorial         ║')
  console.log('╚══════════════════════════════════════════════════════╝')
  console.log(`\n📁 Carpeta de salida: ${OUTPUT_DIR}`)
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

    // Pausa entre peticiones para no saturar la API de Google
    await sleep(400)
  }

  console.log('\n' + '═'.repeat(54))
  console.log(`✅ Completados: ${ok}/${entradas.length}`)
  if (errores.length > 0) {
    console.log(`❌ Con errores (${errores.length}):`)
    errores.forEach(e => console.log(`   - ${e}`))
  }
  console.log(`\n📂 Archivos en: ${OUTPUT_DIR}`)
  console.log('═'.repeat(54))
}

main()
