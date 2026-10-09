import 'dotenv/config'

import { createBot, createProvider, createFlow, addKeyword, utils } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
// ✅ CAMBIO A WHATSAPP CLOUD API (Meta oficial): la API oficial siempre
// entrega el número real del remitente (nunca un @lid opaco), a diferencia
// de baileys/WhatsApp Web no oficial — que sufre el bug de resolución LID
// documentado en https://github.com/WhiskeySockets/Baileys/issues/2263
import { MetaProvider as Provider } from '@builderbot/provider-meta'
import { Pool } from 'pg'
import fs from 'fs'
import path from 'path'
import BetterSqlite3 from 'better-sqlite3'
import Groq from 'groq-sdk'
import { randomUUID } from 'crypto'

const PORT = Number(process.env.PORT) || 3008

// ──────────────────────────────────────────────
// 🛡️ RED DE SEGURIDAD: nunca dejar que un error en la conversación de
// una persona tumbe el bot para todas las demás. Sin esto, cualquier
// falla no atrapada (un audio corrupto, una llamada de red que falla,
// etc.) cierra el proceso completo con "uncaughtException" y hay que
// reiniciar manualmente el servidor.
// ──────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
    console.error('🛡️ Error no controlado (unhandledRejection) — el bot sigue funcionando:', err)
})
process.on('uncaughtException', (err) => {
    console.error('🛡️ Error no controlado (uncaughtException) — el bot sigue funcionando:', err)
})

/* ======================================================
📁 DIRECTORIOS BASE
====================================================== */
const DATA_DIR      = path.join(process.cwd(), 'data')
const AUDIOS_DIR    = path.join(process.cwd(), 'audios')
// Fotos opcionales que adjunta la comunidad (documentos, planos, linderos…)
const FOTOS_DIR     = path.join(process.cwd(), 'fotos')
// Los archivos MP3 generados por generar_audios_azure.mjs quedan
// directo en Preguntas/ (sin carpeta repetida) — confirmado con Katherine.
const PREGUNTAS_DIR = path.join(process.cwd(), 'Preguntas')

for (const dir of [DATA_DIR, AUDIOS_DIR, FOTOS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

// Cache de archivos de audio disponibles en Preguntas/
const AUDIO_CACHE = new Set<string>(
    fs.existsSync(PREGUNTAS_DIR) ? fs.readdirSync(PREGUNTAS_DIR) : []
)
console.log(`🔊 Audio cache: ${AUDIO_CACHE.size} archivo(s) en Preguntas/`)

/* ======================================================
🎤 GROQ WHISPER – TRANSCRIPCIÓN DE VOZ
====================================================== */
let groqClient: Groq | null = null
if (process.env.GROQ_API_KEY) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY })
    console.log('✅ Groq Whisper listo para transcripción de audio')
} else {
    console.warn('⚠️ GROQ_API_KEY no configurado — transcripción de audio desactivada')
}

const transcribirAudio = async (filepath: string): Promise<string | null> => {
    if (!groqClient) return null
    try {
        const transcription = await groqClient.audio.transcriptions.create({
            file:     fs.createReadStream(filepath),
            model:    'whisper-large-v3-turbo',
            language: 'es',
        })
        const texto = transcription.text?.trim() ?? ''
        console.log(`🎙️ Transcripción Whisper: "${texto.slice(0, 120)}"`)
        return texto || null
    } catch (err) {
        console.warn('⚠️ Error en transcripción Whisper:', (err as Error).message)
        return null
    }
}

/* ======================================================
🗄️ SQLITE – COLA OFFLINE
====================================================== */
const sqlitePath = path.join(DATA_DIR, 'offline_queue.db')
const sqlite = new BetterSqlite3(sqlitePath)

sqlite.exec(`
    CREATE TABLE IF NOT EXISTS offline_queue (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        data        TEXT    NOT NULL,
        created_at  TEXT    DEFAULT (datetime('now','localtime')),
        retry_count INTEGER DEFAULT 0,
        status      TEXT    DEFAULT 'pending',
        error_msg   TEXT
    );
    CREATE TABLE IF NOT EXISTS sync_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        queue_id  INTEGER,
        pg_id     INTEGER,
        synced_at TEXT    DEFAULT (datetime('now','localtime'))
    );
`)

/* ======================================================
📦 JSON BACKUP – copia de seguridad legible
====================================================== */
const JSON_QUEUE_PATH = path.join(DATA_DIR, 'offline_backup.json')

const appendToJsonQueue = (data: any, offlineId: string) => {
    const linea = JSON.stringify({
        _offline_id: offlineId, data,
        timestamp: new Date().toISOString(), synced: false,
    })
    fs.appendFileSync(JSON_QUEUE_PATH, linea + '\n')
    console.log(`💾 Backup JSON: ${offlineId}`)
}

const markJsonAsSynced = (offlineId: string, pgId: number) => {
    const linea = JSON.stringify({
        _sync_record: true, _offline_id: offlineId,
        pg_id: pgId, synced: true, synced_at: new Date().toISOString(),
    })
    try { fs.appendFileSync(JSON_QUEUE_PATH, linea + '\n') } catch {}
}

/* ======================================================
🔌 CONEXIÓN POSTGRESQL
====================================================== */
const pool = new Pool({
    host:                    process.env.POSTGRES_DB_HOST,
    user:                    process.env.POSTGRES_DB_USER,
    database:                process.env.POSTGRES_DB_NAME,
    password:                process.env.POSTGRES_DB_PASSWORD,
    port:                    +(process.env.POSTGRES_DB_PORT ?? 5432),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis:       60000,
    max:                     10,
    ssl:                     process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
})

let pgOnline = false

const checkPgConnection = async (): Promise<boolean> => {
    try {
        await pool.query('SELECT 1')
        pgOnline = true
        return true
    } catch {
        pgOnline = false
        return false
    }
}

/* ======================================================
🧭 ¿ESTÁ APLICADA LA MIGRACIÓN LADM?

   migrate_ladm.sql agrega columnas y tablas que este código usa
   (tipo_documento, telefono, numero_predial, col_rrrfuente...). Si
   todavía no se ha corrido, esas columnas no existen y el INSERT
   fallaría, tumbando el registro entero de la comunidad.

   En vez de arriesgar eso, se comprueba una sola vez al arrancar y el
   guardado usa la versión que corresponda. Así el bot funciona igual
   antes y después de la migración, y en la consola queda dicho qué
   falta correr.
====================================================== */
let ladmAplicado = false

const verificarMigracionLadm = async (): Promise<void> => {
    try {
        const r = await pool.query(`
            SELECT to_regclass('public.col_rrrfuente')   IS NOT NULL AS tablas,
                   EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'tpc_representante_legal'
                             AND column_name = 'primer_nombre')      AS columnas
        `)
        ladmAplicado = r.rows[0].tablas === true && r.rows[0].columnas === true
    } catch {
        ladmAplicado = false
    }

    if (ladmAplicado) {
        console.log('✅ Modelo LADM-COL al día')
    } else {
        console.warn(
            '⚠️  Falta la migración LADM. El bot funciona, pero no guardará\n' +
            '    el tipo de documento, el teléfono, el número predial ni la\n' +
            '    fuente administrativa. Para activarlos, una sola vez:\n' +
            '    psql -U postgres -d catastro_etnico -f migrate_ladm.sql'
        )
    }
}

/* ======================================================
💾 GUARDAR EN POSTGRESQL
====================================================== */
const saveToDatabase = async (state: any): Promise<number> => {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        // 1. Comunidad
        const comunidadRes = await client.query(
            `INSERT INTO tpc_interesado_comunidad
              (nombre_comunidad, tipo_comunidad, tipo_organizacion_filial, pueblo,
               numero_familias, numero_personas, numero_mujeres, numero_hombres,
               consentimiento, fecha_registro)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING id`,
            [
                state.nombre_comunidad         ?? null,
                state.tipo_comunidad           ?? null,
                state.tipo_organizacion_filial ?? null,
                state.pueblo_indigena          ?? null,
                parseInt(state.familias_aprox) || null,
                parseInt(state.personas_aprox) || null,
                parseInt(state.numero_mujeres) || null,
                parseInt(state.numero_hombres) || null,
                state.consentimiento           ?? 'Sí',
            ]
        )
        const comunidadId = comunidadRes.rows[0].id

        // 2. Representante legal
        //
        //    El nombre se guarda dos veces a propósito: completo tal como
        //    lo dictó la persona, y repartido en los cuatro campos que
        //    pide el modelo. La separación la hace fn_descomponer_nombre
        //    en la base, para que el criterio sea uno solo y no dependa de
        //    qué parte del sistema escriba la fila.
        if (ladmAplicado) {
            await client.query(
                // Los ::text no son decorativos: PostgreSQL deduce el tipo de
                // cada $n al preparar la consulta, antes de mirar los valores.
                // Si el mismo parámetro aparece una vez como columna VARCHAR y
                // otra como argumento TEXT de una función, la deducción entra
                // en conflicto y la consulta ni siquiera llega a ejecutarse.
                `INSERT INTO tpc_representante_legal
                   (comunidad_id, nombres_autoridades, cargo, legitimidad,
                    tipo_documento, numero_documento_representante, telefono,
                    tipo_acto_administrativo, numero_acto_administrativo,
                    fecha_acto_administrativo,
                    primer_nombre, segundo_nombre, primer_apellido, segundo_apellido)
                 SELECT $1,$2::text,$3,$4,$5,$6,$7,$8,$9,$10::text,
                        d.primer_nombre, d.segundo_nombre, d.primer_apellido, d.segundo_apellido
                 FROM fn_descomponer_nombre($2::text) d`,
                [
                    comunidadId,
                    state.autoridades                    ?? null,
                    state.cargo_autoridad                ?? null,
                    state.legitimidad                    ?? null,
                    state.tipo_documento                 ?? null,
                    state.numero_documento_representante ?? null,
                    state.telefono                       ?? null,
                    state.tipo_acto_administrativo       ?? null,
                    state.numero_acto_administrativo     ?? null,
                    state.fecha_acto_administrativo      ?? null,
                ]
            )
        } else {
            // Sin la migración no existen tipo_documento ni los cuatro
            // campos del nombre; se guarda lo de siempre y nada se pierde.
            await client.query(
                `INSERT INTO tpc_representante_legal
                   (comunidad_id, nombres_autoridades, cargo, legitimidad,
                    numero_documento_representante, telefono,
                    tipo_acto_administrativo, numero_acto_administrativo,
                    fecha_acto_administrativo)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [
                    comunidadId,
                    state.autoridades                    ?? null,
                    state.cargo_autoridad                ?? null,
                    state.legitimidad                    ?? null,
                    state.numero_documento_representante ?? null,
                    state.telefono                       ?? null,
                    state.tipo_acto_administrativo       ?? null,
                    state.numero_acto_administrativo     ?? null,
                    state.fecha_acto_administrativo      ?? null,
                ]
            )
        }

        // 3. Territorio
        await client.query(
            `INSERT INTO tpc_territorio_propiedad_colectiva
              (comunidad_id, nombre_territorio, tipo_procedimiento)
             VALUES ($1,$2,$3)`,
            [comunidadId, state.nombre_territorio ?? null, state.tipo_procedimiento ?? null]
        )

        // 4. Predio
        //
        //    numero_predial y estructura_geometrica solo existen después de
        //    la migración LADM; sin ella se guarda el resto igual que antes.
        //    La topología del lindero (COL_Punto / COL_CadenaDeLimite /
        //    COL_CarasLindero) la genera sola la base de datos con un
        //    disparador sobre geom_perimetro — aquí no hay que hacer nada.
        //
        //    El reconocimiento del Estado ya no se pregunta: se deduce del
        //    acto administrativo. Si la comunidad dice que no tiene ningún
        //    documento oficial, el territorio no está reconocido; en
        //    cualquier otro caso, el documento que nombró es la prueba de
        //    que sí. Antes se preguntaba aparte y podían quedar guardadas
        //    dos respuestas que se contradecían.
        const reconocimiento =
            !state.tipo_acto_administrativo            ? 'No_Sabemos'
          : state.tipo_acto_administrativo === 'Sin_Documento' ? 'No'
          : 'Sí'

        const columnasPredio = [
            'comunidad_id', 'departamento', 'municipio', 'vereda', 'corregimiento',
            'nombre_predio', 'area_acto_administrativo', 'reconocimiento_estado',
            'limites_territorio', 'latitud', 'longitud',
            'metodo_captura_perimetro', 'geojson_perimetro', 'puntos_recorrido_gps',
            'whatsapp_id',
        ]
        const valoresPredio: any[] = [
            comunidadId,
            state.departamento                         ?? null,
            state.municipio                            ?? null,
            state.vereda                               ?? null,
            state.corregimiento                        ?? null,
            state.nombre_predio                        ?? null,
            parseFloat(state.area_acto_administrativo) || null,
            reconocimiento,
            state.limites_territorio                   ?? null,
            state.latitud                              ?? null,
            state.longitud                             ?? null,
            // Si el perímetro se dejó pendiente (ver MÓDULO 4C), estos tres
            // quedan en null — geom_perimetro también queda null más abajo —
            // y el territorio se puede completar después, sin que nada de
            // esto bloquee el guardado del resto del registro.
            state.perimetro_metodo_capturado           ?? (ladmAplicado ? 'Sin_Metodo' : 'no_capturado'),
            state.perimetro_geojson                    ?? null,
            state.perimetro_puntos_gps                 ?? null,
            // Requerido para el recordatorio automático y para poder
            // retomar el perímetro más adelante (ver retomarPerimetroFlow).
            state.whatsapp_id                          ?? null,
        ]
        if (ladmAplicado) {
            columnasPredio.push('numero_predial', 'estructura_geometrica')
            valoresPredio.push(
                state.numero_predial ?? null,
                state.perimetro_geojson ? 'Topologia'
                    : (state.latitud != null ? 'No_Poligono' : null)
            )
        }
        // El polígono va aparte porque necesita convertirse de GeoJSON a
        // geometría, y reutiliza el mismo texto que ya viaja en la lista.
        //
        // El ::text::jsonb del lado de la columna es necesario: ese mismo
        // parámetro se usa más abajo como ::text dentro de ST_GeomFromGeoJSON,
        // y sin el cast PostgreSQL intenta deducir a la vez jsonb y text para
        // el mismo $n, no lo resuelve, y aborta antes de ejecutar nada.
        const iGeoJson = columnasPredio.indexOf('geojson_perimetro') + 1
        const predioRes = await client.query(
            `INSERT INTO tpc_predio (${columnasPredio.join(', ')}, geom_perimetro)
             VALUES (${columnasPredio
                        .map((_, i) => (i + 1 === iGeoJson ? `$${i + 1}::text::jsonb` : `$${i + 1}`))
                        .join(',')},
                     CASE WHEN $${iGeoJson}::text IS NULL THEN NULL
                          ELSE ST_SetSRID(ST_GeomFromGeoJSON($${iGeoJson}::text), 4326) END)
             RETURNING id`,
            valoresPredio
        )
        const predioId = predioRes.rows[0].id

        // 5. Derecho
        const derechoRes = await client.query(
            `INSERT INTO tpc_derecho (comunidad_id, tipo_derecho) VALUES ($1,$2) RETURNING id`,
            [comunidadId, state.tipo_derecho ?? null]
        )
        const derechoId = derechoRes.rows[0].id

        // 6. Restricción (solo si existe)
        let restriccionId: number | null = null
        if (state.restriccion_territorio && state.restriccion_territorio !== 'Ninguna') {
            const resRes = await client.query(
                `INSERT INTO tpc_restriccion (comunidad_id, tipo_restriccion) VALUES ($1,$2) RETURNING id`,
                [comunidadId, state.restriccion_territorio]
            )
            restriccionId = resRes.rows[0].id
        }

        // 6b. Fuente administrativa — el documento que sustenta el derecho
        //
        //     Esta tabla existía desde el principio y nunca recibía datos: el
        //     acto administrativo se guardaba dentro del representante legal,
        //     como si fuera un atributo suyo. En LADM el acto es una FUENTE
        //     que sustenta el derecho, y esa distinción es la que permite
        //     responder "¿qué documento respalda este territorio?".
        //
        //     Se guarda en las dos partes por ahora: aquí, donde corresponde,
        //     y en tpc_representante_legal, para no romper el visor ni las
        //     vistas que ya lo consultan de allá.
        const tipoActo = state.tipo_acto_administrativo ?? null
        // El folio de matrícula es una fuente registral, no un acto
        // administrativo; y "sin documento" no es ninguno de los dos.
        const tipoFuente =
            tipoActo === 'Sin_Documento'    ? 'Sin_Documento'
          : tipoActo === 'Folio_Matricula'  ? 'Documento_Publico'
          : tipoActo === 'Sentencia'        ? 'Sentencia_Judicial'
          : 'Acto_Administrativo'

        const fuenteAdmRes = await client.query(
            ladmAplicado
                ? `INSERT INTO tpc_fuente_administrativa
                     (comunidad_id, tipo_fuente, tipo_acto_administrativo,
                      numero_acto_administrativo, fecha_acto_administrativo, fecha_documento)
                   VALUES ($1,$2,$3,$4,$5::text, fn_texto_a_fecha($5::text)) RETURNING id`
                : `INSERT INTO tpc_fuente_administrativa
                     (comunidad_id, tipo_fuente, tipo_acto_administrativo,
                      numero_acto_administrativo, fecha_acto_administrativo)
                   VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [
                comunidadId,
                tipoFuente,
                tipoActo,
                state.numero_acto_administrativo ?? null,
                state.fecha_acto_administrativo  ?? null,
            ]
        )
        const fuenteAdmId = fuenteAdmRes.rows[0].id

        // 6c. La asociación fuente ↔ derecho: es lo que cierra la cadena
        //     COL_Fuente → COL_DRR → COL_UnidadAdministrativaBasica.
        if (ladmAplicado) {
            await client.query(
                `INSERT INTO col_rrrfuente (fuente_administrativa_id, derecho_id) VALUES ($1,$2)`,
                [fuenteAdmId, derechoId]
            )
            if (restriccionId !== null) {
                await client.query(
                    `INSERT INTO col_rrrfuente (fuente_administrativa_id, restriccion_id) VALUES ($1,$2)`,
                    [fuenteAdmId, restriccionId]
                )
            }
        }

        // 7. Fuente espacial
        //
        //    El método de producción se hereda de cómo se capturó el
        //    perímetro: el croquis dibujado es declarativo, el recorrido
        //    caminado es medición directa.
        const fuenteEspRes = await client.query(
            ladmAplicado
                ? `INSERT INTO tpc_fuente_espacial
                     (comunidad_id, tipo_fuente_espacial, numero_plano, metodo_produccion)
                   VALUES ($1,$2,$3,$4) RETURNING id`
                : `INSERT INTO tpc_fuente_espacial
                     (comunidad_id, tipo_fuente_espacial, numero_plano)
                   VALUES ($1,$2,$3) RETURNING id`,
            ladmAplicado
                ? [comunidadId, state.tipo_fuente_espacial ?? null, state.numero_plano ?? null,
                   state.perimetro_metodo_capturado ?? null]
                : [comunidadId, state.tipo_fuente_espacial ?? null, state.numero_plano ?? null]
        )

        // 7b. Qué insumo cartográfico produjo la geometría de este predio.
        if (ladmAplicado) {
            await client.query(
                `INSERT INTO col_uefuente (fuente_espacial_id, predio_id) VALUES ($1,$2)
                 ON CONFLICT DO NOTHING`,
                [fuenteEspRes.rows[0].id, predioId]
            )
        }

        // 8. Historia del territorio
        await client.query(
            `INSERT INTO ext_historia_territorio
              (comunidad_id, antiguedad_territorio, descripcion_historia, audio_url)
             VALUES ($1,$2,$3,$4)`,
            [
                comunidadId,
                state.antiguedad_territorio ?? null,
                // Preferir transcripción Whisper sobre texto manual si ambos existen
                state.descripcion_historia  ?? state.transcripcion_historia ?? null,
                state.audio_historia_url    ?? null,
            ]
        )

        // 9. Uso del territorio
        await client.query(
            `INSERT INTO ext_uso_territorio (predio_id, tipo_uso, reglas_internas)
             VALUES ($1,$2,$3)`,
            [predioId, state.uso_territorio ?? null, state.reglas_internas ?? null]
        )

        // 10. Validación comunitaria
        await client.query(
            `INSERT INTO ext_validacion_comunitaria
              (comunidad_id, validado_por_comunidad, observaciones_finales,
               audio_observaciones_url, fecha_validacion)
             VALUES ($1,$2,$3,$4,NOW())`,
            [
                comunidadId,
                state.validacion                                      ?? null,
                // ✅ 'Ninguna' es el valor por defecto cuando no escriben nada:
                // antes ganaba siempre y la transcripción del audio final
                // no llegaba nunca a guardarse.
                (state.observaciones_finales && state.observaciones_finales !== 'Ninguna')
                    ? state.observaciones_finales
                    : (state.transcripcion_validacion ?? state.observaciones_finales ?? null),
                state.audio_validacion_url                            ?? null,
            ]
        )

        // 11 y 12. Transcripciones y fotos.
        //
        //     Van dentro de un SAVEPOINT a propósito: si todavía no se
        //     corrió migrate_voz_fotos.sql, estas tablas no existen y el
        //     INSERT falla. Sin el savepoint ese error abortaría toda la
        //     transacción y se perdería el registro completo de la
        //     comunidad. Así, si algo falla aquí, se descarta solo esta
        //     parte, el registro principal se guarda igual, y queda un
        //     aviso claro en la consola diciendo qué hacer.
        await client.query('SAVEPOINT extras_voz_fotos')
        try {
        for (const t of (state.transcripciones ?? [])) {
            if (!t?.texto) continue
            await client.query(
                `INSERT INTO ext_transcripcion_respuesta
                  (comunidad_id, pregunta_clave, transcripcion, valor_interpretado)
                 VALUES ($1,$2,$3,$4)`,
                [comunidadId, t.pregunta ?? 'desconocida', t.texto, state[t.pregunta] ?? null]
            )
        }

        // 12. Fotos opcionales adjuntadas durante el registro
        for (const f of (state.fotos ?? [])) {
            if (!f?.ruta) continue
            await client.query(
                `INSERT INTO ext_foto_registro
                  (comunidad_id, predio_id, categoria, ruta_archivo, descripcion)
                 VALUES ($1,$2,$3,$4,$5)`,
                [comunidadId, predioId, f.categoria ?? 'sin_categoria', f.ruta, f.descripcion ?? null]
            )
        }
        } catch (errExtras) {
            await client.query('ROLLBACK TO SAVEPOINT extras_voz_fotos')
            console.warn(
                '⚠️ No se pudieron guardar las transcripciones/fotos:',
                (errExtras as Error).message
            )
            console.warn(
                '   Si dice que no existe la tabla, falta correr una sola vez:\n' +
                '   psql -U postgres -d catastro_etnico -f migrate_voz_fotos.sql\n' +
                '   (el registro de la comunidad sí quedó guardado)'
            )
        }

        await client.query('COMMIT')
        pgOnline = true
        return comunidadId

    } catch (err) {
        await client.query('ROLLBACK')
        pgOnline = false
        throw err
    } finally {
        client.release()
    }
}

/* ======================================================
👨‍👩‍👧 GUARDAR UNA PARCELA FAMILIAR

   Un levantamiento familiar no repite los datos del territorio — la
   comunidad, el representante y el título ya están guardados. Lo que se
   agrega es la tripleta del nivel interno:

       la familia  —  derecho de uso  —  su parcela dentro del territorio

   El derecho no se pregunta: en un territorio colectivo el título es
   inalienable, así que una familia no puede ser propietaria. Tiene uso y
   usufructo, salvo cuando ya estaba en el lugar antes de que se titulara
   el territorio — ahí lo que ejerce es posesión ancestral.
====================================================== */
const saveFamiliaToDatabase = async (state: any): Promise<number> => {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        const familiaRes = await client.query(
            `INSERT INTO tpc_interesado_familia
               (comunidad_id, nombre_familia, jefe_hogar,
                primer_nombre, segundo_nombre, primer_apellido, segundo_apellido,
                tipo_documento, numero_documento, telefono,
                numero_personas, numero_mujeres, numero_hombres,
                antiguedad_ocupacion, origen_asignacion)
             SELECT $1,$2,$3::text,
                    d.primer_nombre, d.segundo_nombre, d.primer_apellido, d.segundo_apellido,
                    $4,$5,$6,$7,$8,$9,$10,$11
             FROM fn_descomponer_nombre($3::text) d
             RETURNING id`,
            [
                state.comunidad_id_padre,
                state.nombre_familia   ?? null,
                state.jefe_hogar       ?? null,
                state.tipo_documento_familia   ?? null,
                state.numero_documento_familia ?? null,
                state.telefono_familia ?? null,
                parseInt(state.personas_familia) || null,
                parseInt(state.mujeres_familia)  || null,
                parseInt(state.hombres_familia)  || null,
                state.antiguedad_ocupacion ?? null,
                state.origen_asignacion    ?? null,
            ]
        )
        const familiaId = familiaRes.rows[0].id

        // La parcela: un predio más, pero colgando del territorio colectivo.
        // El disparador de topología la descompone en vértices y tramos igual
        // que al territorio, y el de agrupación la mete en la jerarquía LADM.
        const predioRes = await client.query(
            `INSERT INTO tpc_predio
               (comunidad_id, predio_matriz_id, nivel_tenencia,
                departamento, municipio, vereda, corregimiento,
                latitud, longitud, metodo_captura_perimetro,
                geojson_perimetro, puntos_recorrido_gps, estructura_geometrica, geom_perimetro)
             VALUES ($1,$2,'Familiar',$3,$4,$5,$6,$7,$8,$9,$10::text::jsonb,$11,$12,
                     CASE WHEN $10::text IS NULL THEN NULL
                          ELSE ST_SetSRID(ST_GeomFromGeoJSON($10::text), 4326) END)
             RETURNING id`,
            [
                state.comunidad_id_padre,
                state.predio_matriz_id,
                state.departamento ?? null,
                state.municipio    ?? null,
                state.vereda       ?? null,
                state.corregimiento ?? null,
                state.latitud      ?? null,
                state.longitud     ?? null,
                state.perimetro_metodo_capturado ?? 'Sin_Metodo',
                state.perimetro_geojson    ?? null,
                state.perimetro_puntos_gps ?? null,
                state.perimetro_geojson ? 'Topologia' : (state.latitud != null ? 'No_Poligono' : null),
            ]
        )
        const predioId = predioRes.rows[0].id

        await client.query(
            `INSERT INTO tpc_derecho (comunidad_id, familia_id, predio_id, tipo_derecho)
             VALUES ($1,$2,$3,$4)`,
            [
                state.comunidad_id_padre,
                familiaId,
                predioId,
                state.origen_asignacion === 'Ocupacion_Antigua' ? 'Posesion_Ancestral' : 'Uso_Usufructo',
            ]
        )

        if (state.uso_parcela) {
            await client.query(
                `INSERT INTO ext_uso_territorio (predio_id, tipo_uso, reglas_internas)
                 VALUES ($1,$2,NULL)`,
                [predioId, state.uso_parcela]
            )
        }

        // Transcripciones y fotos, aisladas igual que en el registro
        // colectivo: si algo falla aquí no se pierde la familia entera.
        await client.query('SAVEPOINT extras_familia')
        try {
            for (const t of (state.transcripciones ?? [])) {
                if (!t?.texto) continue
                await client.query(
                    `INSERT INTO ext_transcripcion_respuesta
                       (comunidad_id, pregunta_clave, transcripcion, valor_interpretado)
                     VALUES ($1,$2,$3,$4)`,
                    [state.comunidad_id_padre, `familia.${t.pregunta ?? 'desconocida'}`,
                     t.texto, state[t.pregunta] ?? null]
                )
            }
            for (const f of (state.fotos ?? [])) {
                if (!f?.ruta) continue
                await client.query(
                    `INSERT INTO ext_foto_registro
                       (comunidad_id, predio_id, categoria, ruta_archivo, descripcion)
                     VALUES ($1,$2,$3,$4,$5)`,
                    [state.comunidad_id_padre, predioId, f.categoria ?? 'sin_categoria',
                     f.ruta, f.descripcion ?? null]
                )
            }
        } catch (errExtras) {
            await client.query('ROLLBACK TO SAVEPOINT extras_familia')
            console.warn('⚠️ No se guardaron transcripciones/fotos de la familia:',
                (errExtras as Error).message)
        }

        await client.query('COMMIT')
        pgOnline = true
        return familiaId

    } catch (err) {
        await client.query('ROLLBACK')
        pgOnline = false
        throw err
    } finally {
        client.release()
    }
}

/**
 * Palabras que aparecen en casi todos los nombres de territorios
 * colectivos en Colombia y por lo tanto no sirven para distinguir uno de
 * otro. Van sin tildes porque la comparación se hace normalizada.
 */
const PALABRAS_GENERICAS = new Set([
    'territorio', 'territorios', 'comunidad', 'comunidades', 'comunitario',
    'comunitaria', 'consejo', 'resguardo', 'cabildo', 'parcialidad',
    'indigena', 'indigenas', 'negra', 'negras', 'colectivo', 'colectiva',
    'afrocolombiana', 'pueblo', 'del', 'las', 'los', 'para',
])

/**
 * Busca territorios ya registrados por el nombre de la comunidad o del
 * territorio. La comparación se hace en memoria y sin tildes: son decenas
 * de registros, no millones, y así no hace falta la extensión unaccent ni
 * adivinar cómo escribió el nombre la persona.
 */
const buscarTerritorios = async (texto: string): Promise<Array<{
    comunidad_id: number; predio_id: number; nombre_comunidad: string
    nombre_territorio: string | null; municipio: string | null; departamento: string | null
}>> => {
    const { rows } = await pool.query(`
        SELECT c.id                AS comunidad_id,
               p.id                AS predio_id,
               c.nombre_comunidad,
               t.nombre_territorio,
               p.municipio,
               p.departamento
        FROM tpc_interesado_comunidad c
        JOIN tpc_predio p ON p.comunidad_id = c.id AND p.nivel_tenencia = 'Colectivo'
        LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
        ORDER BY c.fecha_registro DESC
    `)

    const aguja = sinTildes(texto).trim()
    if (aguja.length < 3) return []

    // Puntúa cada territorio: gana el que contenga la frase completa; si no,
    // el que comparta más palabras con lo que dictó la persona.
    //
    // Las palabras genéricas no cuentan. Casi todos estos nombres empiezan
    // por «Consejo Comunitario», «Resguardo Indígena» o «Territorio
    // Colectivo de…», así que dejarlas puntuar hacía que cualquier
    // búsqueda devolviera media base de datos — buscar «territorio que no
    // existe» encontraba coincidencias.
    const palabras = aguja
        .split(/\s+/)
        .filter(p => p.length > 2 && !PALABRAS_GENERICAS.has(p))

    const puntuar = (r: any): number => {
        const heno = sinTildes(`${r.nombre_comunidad} ${r.nombre_territorio ?? ''}`)
        if (heno.includes(aguja)) return 100
        // Sin ninguna palabra distintiva no hay con qué discriminar: se
        // prefiere no devolver nada antes que devolver cualquier cosa.
        if (palabras.length === 0) return 0
        return palabras.filter(p => heno.includes(p)).length
    }

    return rows
        .map(r => ({ r, pts: puntuar(r) }))
        .filter(x => x.pts > 0)
        .sort((a, b) => b.pts - a.pts)
        .slice(0, 5)
        .map(x => x.r)
}

/* ======================================================
🔄 GUARDAR CON FALLBACK OFFLINE
====================================================== */
const saveToDatabaseSafe = async (
    state: any
): Promise<{ id: number | string; offline: boolean; verificado: boolean }> => {
    try {
        console.log('💾 Intentando guardar en PostgreSQL...', { comunidad: state.nombre_comunidad })
        const pgId = await saveToDatabase(state)
        console.log(`✅ Registro guardado en PostgreSQL con ID: ${pgId}`)
        return { id: pgId, offline: false, verificado: true }
    } catch (err) {
        const error = err as any
        console.error('❌ Error guardando en PostgreSQL:', { mensaje: error.message, codigo: error.code })
        console.warn('⚠️ Guardando en cola offline...')

        const stateJson = JSON.stringify(state)
        const stmt      = sqlite.prepare('INSERT INTO offline_queue (data) VALUES (?)')
        const result    = stmt.run(stateJson)
        const offlineId = `OFFLINE-${result.lastInsertRowid}`

        appendToJsonQueue(state, offlineId)
        return { id: offlineId, offline: true, verificado: false }
    }
}

/* ======================================================
🔁 SINCRONIZADOR OFFLINE → POSTGRESQL (cada 5 min)
====================================================== */
const syncOfflineQueue = async () => {
    const isOnline = await checkPgConnection()
    if (!isOnline) {
        console.log('⚪ Sync offline: PostgreSQL no disponible')
        return
    }

    const pending = sqlite.prepare(
        "SELECT * FROM offline_queue WHERE status='pending' AND retry_count < 5 LIMIT 5"
    ).all() as any[]

    if (pending.length === 0) return
    console.log(`🔄 Sincronizando ${pending.length} registro(s) offline...`)

    for (const record of pending) {
        try {
            const data = JSON.parse(record.data)
            const pgId = await saveToDatabase(data)

            sqlite.prepare("UPDATE offline_queue SET status='synced', error_msg=NULL WHERE id=?")
                .run(record.id)
            sqlite.prepare("INSERT INTO sync_log (queue_id, pg_id) VALUES (?,?)")
                .run(record.id, pgId)

            markJsonAsSynced(`OFFLINE-${record.id}`, pgId)
            console.log(`✅ Offline ID ${record.id} → PostgreSQL ID ${pgId}`)

        } catch (err) {
            const newCount  = record.retry_count + 1
            const newStatus = newCount >= 5 ? 'failed' : 'pending'
            sqlite.prepare(
                'UPDATE offline_queue SET retry_count=?, status=?, error_msg=? WHERE id=?'
            ).run(newCount, newStatus, (err as Error).message, record.id)

            if (newStatus === 'failed')
                console.error(`❌ Registro offline ${record.id} falló 5 veces. Marcado fallido.`)
        }
    }
}

/* ======================================================
⏰ RECORDATORIO AUTOMÁTICO DE PERÍMETRO PENDIENTE (cada hora)

   Para las comunidades que en el MÓDULO 4C eligieron guardar el
   territorio y dejar el croquis/recorrido GPS para después. Se les
   escribe por WhatsApp: el primer recordatorio a las 24 horas de
   registrado el territorio, y hasta dos más cada 3 días — nunca más
   de 3 en total, para no ser inoportunos.

   Recibe el `provider` como parámetro (en vez de leerlo de una
   variable de módulo) porque `adapterProvider` solo existe dentro de
   main(), y esta función se define aquí arriba junto al resto de
   tareas periódicas para que quede junto a syncOfflineQueue.
====================================================== */
const recordarPerimetroPendiente = async (provider: any) => {
    if (!pgOnline) return
    try {
        const { rows } = await pool.query(`
            SELECT p.id, p.whatsapp_id, c.nombre_comunidad, t.nombre_territorio
            FROM tpc_predio p
            JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
            LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
            WHERE p.nivel_tenencia = 'Colectivo'
              AND p.geom_perimetro IS NULL
              AND p.whatsapp_id IS NOT NULL
              AND COALESCE(p.recordatorio_perimetro_conteo, 0) < 3
              AND (
                    (COALESCE(p.recordatorio_perimetro_conteo, 0) = 0 AND p.fecha_registro <= NOW() - INTERVAL '24 hours')
                 OR (COALESCE(p.recordatorio_perimetro_conteo, 0) > 0 AND p.recordatorio_perimetro_enviado_en <= NOW() - INTERVAL '3 days')
              )
        `)

        for (const r of rows) {
            const nombre = r.nombre_territorio || r.nombre_comunidad
            const mensaje = [
                `👋 Hola de nuevo, le escribo del Registro Territorial Comunitario.`,
                ``,
                `El territorio *${nombre}* quedó registrado, pero todavía falta dibujar el croquis o caminar el lindero con GPS.`,
                ``,
                `Cuando estén listos, escriban *perímetro* y los guío para completarlo.`,
            ].join('\n')

            try {
                await provider.sendMessage(r.whatsapp_id, mensaje, {})
                await pool.query(
                    `UPDATE tpc_predio
                        SET recordatorio_perimetro_conteo = COALESCE(recordatorio_perimetro_conteo, 0) + 1,
                            recordatorio_perimetro_enviado_en = NOW()
                      WHERE id = $1`,
                    [r.id]
                )
                console.log(`⏰ Recordatorio de perímetro enviado a ${r.whatsapp_id} (territorio "${nombre}")`)
            } catch (err) {
                console.error(`❌ No se pudo enviar recordatorio de perímetro a ${r.whatsapp_id}:`, (err as Error).message)
            }
        }
    } catch (err) {
        console.error('❌ Error revisando recordatorios de perímetro pendientes:', (err as Error).message)
    }
}

/* ======================================================
📍 UTILIDAD: UBICACIÓN POR COORDENADAS (Nominatim)
====================================================== */
const obtenerUbicacion = async (lat: number, lon: number) => {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=es`
        const res = await fetch(url, {
            headers: { 'User-Agent': 'CatastroEtnicoBot/1.0' },
            signal:  AbortSignal.timeout(8000),
        })
        const data = await res.json() as any
        return {
            departamento: data.address?.state ?? 'Desconocido',
            municipio:    data.address?.county ?? data.address?.city ?? data.address?.town ?? 'Desconocido',
            vereda:       data.address?.village ?? data.address?.suburb ?? data.address?.neighbourhood ?? 'Desconocida',
        }
    } catch (e) {
        console.warn('⚠️ Nominatim error:', (e as Error).message)
        return null
    }
}

/* ======================================================
🎤 UTILIDAD: GUARDAR AUDIO RECIBIDO + TRANSCRIBIR CON WHISPER
====================================================== */
const guardarAudio = async (mediaUrl: string, nombre: string): Promise<string> => {
    const filename = `${nombre}_${Date.now()}.ogg`
    const filepath = path.join(AUDIOS_DIR, filename)
    // ✅ CORREGIDO: las URLs de medios de WhatsApp Cloud API exigen el
    // header Authorization con el token de acceso, si no, la descarga
    // falla con 401 aunque la URL sea correcta.
    const res = await fetch(mediaUrl, {
        headers: { Authorization: `Bearer ${process.env.META_JWT_TOKEN}` },
        signal:  AbortSignal.timeout(10000),
    })
    if (!res.ok) {
        throw new Error(`No se pudo descargar el audio (HTTP ${res.status})`)
    }
    const buffer = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(filepath, buffer)
    return filepath
}

/**
 * ✅ CORREGIDO: extrae la URL del audio del ctx.
 * Con el proveedor oficial de Meta (Cloud API), la URL llega en `ctx.url`.
 * `ctx.message.audioMessage.url` es una estructura de Baileys (WhatsApp Web
 * no oficial) que este proyecto ya no usa — dejarla como única fuente hacía
 * que nunca se detectara ningún audio.
 */
const obtenerUrlAudio = (ctx: any): string => {
    return (
        ctx?.url ??
        ctx?.message?.audioMessage?.url ??
        ctx?.message?.url ??
        ''
    )
}

/* ======================================================
🔧 UTILIDADES DE INTERACCIÓN
====================================================== */
const norm = (body: string): string => {
    const t = body.trim()
    const m = t.match(/^(\d+)/)
    return m ? m[1] : t.toLowerCase()
}

const esNumeroValido = (valor: string): boolean => {
    const limpio = valor.replace(/[.,\s]/g, '')
    const n = parseInt(limpio)
    return !isNaN(n) && n >= 0 && limpio.length > 0
}

const esFechaValida = (valor: string): boolean => {
    const v = valor.trim().toLowerCase()
    if (['desconocida', 'desconocido', 'no aplica', 'n/a', 'no sé', 'no se'].includes(v)) return true
    return /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(valor.trim())
}

/** Envía botones (≤3 opciones) o lista numerada (>3 opciones) */
/**
 * Acorta un texto de botón sin partir una palabra por la mitad.
 *
 * @builderbot/provider-meta vuelve a recortar el título del botón a 16
 * caracteres por su cuenta (ver su código: `btn.body.slice(0, 16)`), así
 * que subir el límite aquí no serviría de nada — igual lo recortaría
 * después, a la mitad de cualquier palabra. La única forma de evitar que
 * quede una palabra cortada es entregarle ya un texto de 16 caracteres o
 * menos, cortado en un espacio, no a la mitad.
 */
const acortarBoton = (texto: string, maxLen = 16): string => {
    if (texto.length <= maxLen) return texto
    const limite = maxLen - 1 // deja un carácter para el "…"
    let cortado = texto.slice(0, limite)
    // Si el carácter justo donde se corta NO es un espacio, la última
    // palabra del recorte quedó partida a la mitad y hay que retroceder
    // hasta el espacio anterior. Si el corte cae en un espacio (o la
    // última palabra ya estaba completa), se deja tal cual — retroceder
    // igual habría borrado una palabra que sí cabía entera.
    const siguienteCaracter = texto[limite]
    if (siguienteCaracter && siguienteCaracter !== ' ') {
        const ultimoEspacio = cortado.lastIndexOf(' ')
        if (ultimoEspacio > 0) cortado = cortado.slice(0, ultimoEspacio)
    }
    return `${cortado.trimEnd()}…`
}

const enviarOpciones = async (
    flowDynamic: any,
    titulo: string,
    opciones: string[]
): Promise<void> => {
    if (opciones.length <= 3) {
        try {
            await flowDynamic([{
                body: titulo || ' ',
                // Ver acortarBoton(): el límite real de 16 caracteres lo
                // impone @builderbot/provider-meta, no esta línea — aquí solo
                // se controla DÓNDE se corta, para no partir una palabra.
                buttons: opciones.map((o, i) => ({ body: acortarBoton(`${i + 1}. ${o}`) }))
            }])
            return
        } catch (err) {
            // El envío de botones interactivos a veces falla contra la API
            // de Meta sin lanzar un error claro más arriba en la cadena —
            // eso dejaba la conversación trabada en silencio, sin mensaje
            // y sin log. Ahora, si falla, se reintenta de una vez como
            // texto plano con las opciones numeradas, y el motivo real
            // queda registrado en la consola para poder diagnosticarlo.
            console.error('⚠️ Falló el envío de botones interactivos, se reintenta como texto:', err)
        }
    }
    const listado = opciones.length <= 3
        ? opciones.map((o, i) => `${i + 1}. ${o}`).join('\n')
        : opciones.join('\n')
    await flowDynamic(`${titulo}\n\n${listado}`)
}

/**
 * Envía una pregunta con audio MP3 opcional.
 * ✅ CORREGIDO: usa state.getMyState()?.audioEnabled (antes accedía incorrectamente)
 * - Si audio habilitado y archivo existe: envía MP3 con texto como caption
 * - Si solo opciones: envía botones/lista
 * - Sin audio ni opciones: envía texto plano
 */
const enviarPregunta = async (
    flowDynamic: any,
    state: any,
    nombreAudio: string,
    texto: string,
    opciones?: string[]
): Promise<void> => {
    const st           = state?.getMyState?.() ?? {}
    const audioEnabled = st?.audioEnabled === true
    const tieneAudio   = audioEnabled && AUDIO_CACHE.has(nombreAudio)

    if (tieneAudio) {
        const ruta = path.join(PREGUNTAS_DIR, nombreAudio)
        try {
            // ✅ CORREGIDO: WhatsApp NO permite texto/caption en notas de voz
            // (mensajes tipo "audio"). @builderbot/provider-meta ni siquiera
            // recibe el texto en su función sendAudio(), así que aunque se
            // mandara como "body" junto al audio, WhatsApp lo descartaba en
            // silencio y la persona solo escuchaba el audio, sin ver el texto.
            // Por eso el texto se manda SIEMPRE como un mensaje aparte,
            // además del audio — así la persona puede escuchar y leer.
            //
            // Si el audio falla al convertirse/enviarse (ffmpeg, archivo
            // corrupto, etc.), antes esto tumbaba TODO el proceso del bot
            // para todas las personas conectadas — ahora se atrapa aquí y
            // el texto llega de todas formas.
            await flowDynamic([{ media: ruta }])
        } catch (err) {
            console.error(`⚠️ No se pudo enviar el audio "${nombreAudio}":`, (err as Error).message)
        }
        await flowDynamic(texto)
        // Si además hay opciones, enviarlas después del audio y el texto
        if (opciones && opciones.length > 0) {
            await enviarOpciones(flowDynamic, '👇 Seleccione una opción:', opciones)
        }
    } else if (opciones && opciones.length > 0) {
        await enviarOpciones(flowDynamic, texto, opciones)
    } else {
        await flowDynamic(texto)
    }
}


/* ======================================================
🎙️ RESPUESTAS HABLADAS + INTERPRETACIÓN DE OPCIONES

   Toda pregunta acepta que la persona responda con una nota de voz.
   El audio se transcribe con Whisper, se usa el texto como si lo
   hubiera escrito, y el archivo se borra en el acto: NO se guarda
   el audio, solo la transcripción (que sí va a la base de datos).

   Para las preguntas de opción cerrada, la transcripción se
   interpreta contra las opciones válidas: si se entiende sin
   ambigüedad se guarda directo; si hay duda se confirma; y si no se
   reconoce nada, se vuelve a preguntar mostrando lo que se escuchó.
====================================================== */

const sinTildes = (s: string): string =>
    (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

const escRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// La negación solo alcanza hasta el final de su propia frase: en
// "no, todavía está en proceso" ese "no" responde a otra cosa y no debe
// anular el "proceso" que viene después de la coma.
const NEGACION_PREVIA = /\b(no|nunca|jamas|tampoco|sin)\b[^.,;]{0,25}$/
// Una clave que ya es negativa por sí misma ("no hay", "ninguna", "sin mapa")
// no debe descartarse por venir después de un "no" — el "no" es parte de ella.
const esClaveNegativa = (c: string): boolean => /^(no|ningun|nada|nunca|sin|tampoco)/.test(c)

type Coincidencia = { ini: number; fin: number; largo: number; esFrase: boolean }

/**
 * Dónde y con qué longitud coincidió una palabra clave. La posición importa
 * para distinguir dos menciones distintas ("por el río y la montaña" → hay
 * duda real) de una misma mención dicha con más precisión ("no sabemos"
 * contiene "no", pero es la misma idea, no dos opciones distintas).
 *
 * Formas de clave:
 *   'rio*'        → raíz: coincide con rio, rios, riachuelo…
 *   'no'          → palabra completa únicamente (para que "no" no coincida
 *                   dentro de "reconocido", ni "si" dentro de "siempre")
 *   'consejo com' → frase: subcadena tal cual
 */
const buscarCoincidencias = (limpio: string, clave: string): Coincidencia[] => {
    const c = sinTildes(clave)
    let re: RegExp
    if (c.endsWith('*'))      re = new RegExp(`\\b${escRegex(c.slice(0, -1))}\\w*`, 'g')
    else if (c.includes(' ')) re = new RegExp(escRegex(c), 'g')
    else                      re = new RegExp(`\\b${escRegex(c)}\\b`, 'g')

    const salida: Coincidencia[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(limpio)) !== null) {
        // "todavía no nos han reconocido" NO debe contar como "reconocido":
        // si viene negada justo antes, la coincidencia se descarta.
        const negada = !esClaveNegativa(c) && NEGACION_PREVIA.test(limpio.slice(0, m.index))
        if (!negada) {
            salida.push({ ini: m.index, fin: m.index + m[0].length, largo: m[0].length, esFrase: c.includes(' ') })
        }
        if (m.index === re.lastIndex) re.lastIndex++
    }
    return salida
}

const seSolapan = (a: Coincidencia, b: Coincidencia): boolean => a.ini < b.fin && b.ini < a.fin

const NUM_PALABRA: Record<string, number> = {
    uno: 1, primero: 1, primera: 1, primer: 1,
    dos: 2, segundo: 2, segunda: 2,
    tres: 3, tercero: 3, tercera: 3, tercer: 3,
    cuatro: 4, cuarto: 4, cuarta: 4,
    cinco: 5, quinto: 5, quinta: 5,
    seis: 6, sexto: 6, sexta: 6,
}

/**
 * Número de opción, SOLO en contexto claro: la respuesta es el número solo
 * ("2", "dos"), viene anunciado ("la número dos", "opción 3") o encabeza la
 * frase ("2. Cabildo"). Así "somos una comunidad negra" no se confunde con
 * la opción 1 por el "una".
 */
const extraerNumeroOpcion = (limpio: string): number | null => {
    const solo = limpio.replace(/[.,;:!¡?¿"'()]/g, ' ').replace(/\s+/g, ' ').trim()
    if (/^\d+$/.test(solo)) return parseInt(solo, 10)
    if (NUM_PALABRA[solo] !== undefined) return NUM_PALABRA[solo]

    const ctx = solo.match(/\b(?:opcion|numero|respuesta|punto|literal)\s+(?:la\s+|el\s+)?(\d+|[a-z]+)\b/)
    if (ctx) {
        const t = ctx[1]
        if (/^\d+$/.test(t)) return parseInt(t, 10)
        if (NUM_PALABRA[t] !== undefined) return NUM_PALABRA[t]
    }

    const ini = solo.match(/^(\d+)\b/)
    if (ini) return parseInt(ini[1], 10)

    const art = solo.match(/^(?:la|el)\s+(\d+|[a-z]+)\b/)
    if (art) {
        const t = art[1]
        if (/^\d+$/.test(t)) return parseInt(t, 10)
        if (NUM_PALABRA[t] !== undefined) return NUM_PALABRA[t]
    }
    return null
}

type OpcionSpec = { valor: string; etiqueta: string; claves: string[] }
type Interpretacion =
    | { estado: 'exacto' | 'probable'; valor: string; etiqueta: string }
    | { estado: 'ninguno' }

/**
 * Interpreta una respuesta (escrita o transcrita de voz) contra las opciones
 * válidas de una pregunta cerrada.
 *   exacto   → se entendió sin ambigüedad, se guarda directo
 *   probable → coincidió con más de una opción, hay que confirmar
 *   ninguno  → no se reconoció nada, hay que repetir la pregunta
 */
const interpretarOpcion = (texto: string, opciones: OpcionSpec[]): Interpretacion => {
    const limpio = sinTildes(texto)
    if (!limpio) return { estado: 'ninguno' }

    const n = extraerNumeroOpcion(limpio)
    if (n !== null && n >= 1 && n <= opciones.length) {
        const o = opciones[n - 1]
        return { estado: 'exacto', valor: o.valor, etiqueta: o.etiqueta }
    }

    // Para cada opción, su mejor coincidencia: primero las frases (más
    // intencionales que una palabra suelta), luego la más larga.
    const mejor = (ms: Coincidencia[]): Coincidencia =>
        ms.sort((a, b) => (Number(b.esFrase) - Number(a.esFrase)) || (b.largo - a.largo))[0]

    const golpes = opciones
        .map((o) => {
            const todas = o.claves.flatMap((c) => buscarCoincidencias(limpio, c))
            return todas.length ? { opcion: o, m: mejor(todas) } : null
        })
        .filter((g): g is { opcion: OpcionSpec; m: Coincidencia } => g !== null)
        .sort((a, b) => (Number(b.m.esFrase) - Number(a.m.esFrase)) || (b.m.largo - a.m.largo))

    if (golpes.length === 0) return { estado: 'ninguno' }

    const ganador = golpes[0]
    const salida = (estado: 'exacto' | 'probable'): Interpretacion =>
        ({ estado, valor: ganador.opcion.valor, etiqueta: ganador.opcion.etiqueta })

    if (golpes.length === 1) return salida('exacto')

    const rival = golpes[1]
    // Una frase le gana a una palabra suelta: "no autorizo" pesa más que el
    // "autorizo" que quedó dentro, y "no sabemos" más que un "fecha" de paso.
    if (ganador.m.esFrase && !rival.m.esFrase) return salida('exacto')
    // Misma parte de la frase dicha con más precisión → no son dos opciones.
    if (seSolapan(ganador.m, rival.m)) return salida('exacto')
    // Dos menciones independientes y comparables → hay duda real, confirmar.
    return salida('probable')
}

const esAfirmacion = (texto: string): boolean => {
    const t = sinTildes(texto)
    if (!t) return false
    if (/^(1|si|correcto|exacto|claro|afirmativo|ok|okay|listo|dale|eso|esa|asi)\b/.test(t)) return true
    return /\b(es correcto|asi es|esta bien|eso mismo|esa misma|de acuerdo)\b/.test(t)
}

const esNegacion = (texto: string): boolean => {
    const t = sinTildes(texto)
    if (!t) return false
    if (/^(2|no|incorrecto|negativo|otra|otro|cambiar|corregir)\b/.test(t)) return true
    return /\b(no es|esta mal|equivocad|otra opcion|me equivoque)\b/.test(t)
}

/**
 * «Ese dato no existe o no lo sé», para las preguntas opcionales de texto
 * libre: corregimiento, número predial, teléfono, nombre del predio.
 *
 * Es distinto de esNegacion() a propósito. Aquella significa «no, se
 * equivocó» dentro del ciclo de confirmación, y ahí «ninguna» puede ser
 * una respuesta legítima — la pregunta de restricciones tiene justamente
 * esa opción. Mezclarlas haría que confirmar «Ninguna» se leyera como un
 * rechazo. Aquí, en cambio, «ninguno» sí quiere decir que el dato no está,
 * y guardarlo como si fuera el nombre del predio sería un error.
 */
const sinDatoQueDar = (texto: string): boolean => {
    const t = sinTildes(texto).trim()
    if (!t) return true
    // «desconoc» va con \w* porque sigue con -ido, -ida, -emos… y un \b
    // pegado a la raíz nunca casaría.
    return /^(no|ninguno?a?|nada|n\/a|na)\b/.test(t)
        || /\bdesconoc\w*/.test(t)
        || /\b(no tiene|no aplica|no hay|no existe|no aparece|no figura|no se|no lo se|no sabemos|no recuerdo|sin nombre|sin numero|sin dato)\b/.test(t)
}

/* ---------- Detección del tipo de mensaje entrante ----------
   El proveedor de Meta marca ctx.type ('audio' | 'image' | 'location'…)
   y, ojo, en los medios ctx.body NO viene vacío: trae un token interno
   ('_event_voice_note_', '_event_media_'). Por eso una nota de voz pasaba
   como texto válido en las validaciones de longitud.                     */
const marcaEvento = (ctx: any, marca: string): boolean =>
    typeof ctx?.body === 'string' && ctx.body.includes(marca)

const esMensajeAudio = (ctx: any): boolean =>
    String(ctx?.type ?? '').toLowerCase() === 'audio' ||
    marcaEvento(ctx, '_event_voice_note_') ||
    Boolean(ctx?.message?.audioMessage)

const esMensajeImagen = (ctx: any): boolean =>
    String(ctx?.type ?? '').toLowerCase() === 'image' ||
    marcaEvento(ctx, '_event_media_') ||
    Boolean(ctx?.message?.imageMessage)

const obtenerUrlMedia = (ctx: any): string =>
    ctx?.url ??
    ctx?.message?.audioMessage?.url ??
    ctx?.message?.imageMessage?.url ??
    ctx?.message?.url ??
    ''

/* ---------- Números dictados de viva voz ----------
   Whisper transcribe "cuarenta y cinco", no "45". Sin esto, cada
   pregunta de cantidad rechazaría las respuestas habladas.            */
const UNIDADES: Record<string, number> = {
    cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
    seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
    trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
    dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21,
    veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
    veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
    treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70,
    ochenta: 80, noventa: 90,
}
const CENTENAS: Record<string, number> = {
    cien: 100, ciento: 100, doscientos: 200, doscientas: 200,
    trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
    quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600,
    setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
    novecientos: 900, novecientas: 900, mil: 1000,
}

/** Devuelve el número que contiene el texto, en dígitos o en palabras. */
const extraerNumero = (texto: string): string | null => {
    const t = sinTildes(texto)
    if (!t) return null

    const digitos = t.replace(/[.,]/g, '').match(/\d+/)
    if (digitos) return digitos[0]

    let total = 0
    let parcial = 0
    let encontrado = false
    for (const palabra of t.split(/[\s-]+/)) {
        if (palabra === 'y') continue
        if (CENTENAS[palabra] !== undefined) {
            const v = CENTENAS[palabra]
            if (v === 1000) { total += (parcial || 1) * 1000; parcial = 0 }
            else parcial += v
            encontrado = true
        } else if (UNIDADES[palabra] !== undefined) {
            parcial += UNIDADES[palabra]
            encontrado = true
        }
    }
    if (!encontrado) return null
    return String(total + parcial)
}

/** Deja registrada la transcripción para guardarla luego en la base de datos. */
const registrarTranscripcion = async (state: any, clave: string, texto: string): Promise<void> => {
    const previas = state.getMyState?.()?.transcripciones ?? []
    await state.update({ transcripciones: [...previas, { pregunta: clave, texto }] })
}

/**
 * Texto de la respuesta, venga escrita o hablada. Si es nota de voz la
 * transcribe con Whisper y BORRA el archivo enseguida — el audio no se
 * guarda en ninguna parte, solo su transcripción.
 */
const obtenerTextoRespuesta = async (
    ctx: any,
    state: any,
    clave: string,
    flowDynamic?: any,
): Promise<string> => {
    if (!esMensajeAudio(ctx)) return String(ctx?.body ?? '').trim()

    const url = obtenerUrlMedia(ctx)
    if (!url) return ''

    let archivoTemporal: string | null = null
    try {
        archivoTemporal = await guardarAudio(url, `voz_${clave}`)
        const texto = await transcribirAudio(archivoTemporal)
        if (!texto) {
            // Se avisa siempre: si el audio no se entendió, la persona debe
            // saberlo en el momento y no quedarse esperando una respuesta.
            if (flowDynamic) {
                await flowDynamic('🎙️ Recibí su audio, pero no logré entender lo que dice. ¿Me lo repite, por favor?')
            }
            return ''
        }
        await registrarTranscripcion(state, clave, texto)
        if (flowDynamic) {
            await flowDynamic(`🎙️ *Audio transcrito:*\n\n_"${texto}"_`)
        }
        return texto
    } catch (err) {
        console.warn(`⚠️ No se pudo procesar la nota de voz de "${clave}":`, (err as Error).message)
        if (flowDynamic) {
            await flowDynamic('🎙️ Recibí su audio, pero no pude procesarlo. ¿Puede intentarlo de nuevo, o responder escribiendo?')
        }
        return ''
    } finally {
        if (archivoTemporal) {
            try { fs.unlinkSync(archivoTemporal) } catch { /* si no se puede borrar, no pasa nada */ }
        }
    }
}

/** Las opciones de una pregunta, numeradas, para volver a mostrarlas. */
const listarOpcionesPregunta = (clave: string): string =>
    (OPCIONES_PREGUNTA[clave] ?? []).map((o, i) => `${i + 1}️⃣ ${o.etiqueta}`).join('\n')

type Decision =
    | { accion: 'listo'; valor: string }
    | { accion: 'esperar'; mensaje: string }

/**
 * Resuelve la respuesta a una pregunta de opción cerrada, venga escrita o
 * hablada. Devuelve 'listo' con el valor exacto que va a la base de datos,
 * o 'esperar' con el mensaje que hay que enviarle a la persona (para
 * confirmar lo que se entendió, o para volver a preguntar).
 *
 * Reemplaza el comportamiento anterior, en el que varias preguntas
 * guardaban un valor por defecto en silencio cuando no entendían la
 * respuesta — quedaba un dato equivocado sin que nadie se enterara.
 */
const resolverOpcion = async (ctx: any, state: any, clave: string, flowDynamic?: any): Promise<Decision> => {
    const st = state.getMyState?.() ?? {}
    const opciones = OPCIONES_PREGUNTA[clave] ?? []
    const texto = await obtenerTextoRespuesta(ctx, state, clave, flowDynamic)

    // ¿Está respondiendo a una confirmación pendiente de esta misma pregunta?
    if (st.confirmar_clave === clave) {
        // OJO: hay que leer el valor pendiente ANTES de limpiar el estado.
        // getMyState() devuelve una referencia viva, así que si se limpia
        // primero, aquí ya se estaría leyendo null y se guardaría vacío.
        const valorPendiente   = st.confirmar_valor
        const etiquetaPendiente = st.confirmar_etiqueta
        const limpiar = { confirmar_clave: null, confirmar_valor: null, confirmar_etiqueta: null }
        if (esAfirmacion(texto)) {
            await state.update(limpiar)
            return { accion: 'listo', valor: valorPendiente }
        }
        if (esNegacion(texto)) {
            await state.update(limpiar)
            return { accion: 'esperar', mensaje: `Sin problema, elijamos de nuevo:\n\n${listarOpcionesPregunta(clave)}` }
        }
        // Ni sí ni no: quizá está respondiendo la pregunta directamente.
        const otra = interpretarOpcion(texto, opciones)
        if (otra.estado === 'exacto') {
            await state.update(limpiar)
            return { accion: 'listo', valor: otra.valor }
        }
        return { accion: 'esperar', mensaje: `¿Me confirma, por favor? Entendí *${etiquetaPendiente}*.\n\nResponda *sí* o *no*.` }
    }

    const r = interpretarOpcion(texto, opciones)

    if (r.estado === 'exacto') return { accion: 'listo', valor: r.valor }

    if (r.estado === 'probable') {
        await state.update({ confirmar_clave: clave, confirmar_valor: r.valor, confirmar_etiqueta: r.etiqueta })
        return {
            accion: 'esperar',
            mensaje: `Entendí *${r.etiqueta}*. ¿Es correcto?\n\n1️⃣ Sí, es correcto\n2️⃣ No, quiero elegir otra`,
        }
    }

    // Mostrar lo que se escuchó ayuda mucho cuando la voz se transcribió mal.
    const oido = texto ? `\n\n_Escuché:_ "${texto.slice(0, 120)}"` : ''
    return {
        accion: 'esperar',
        mensaje: `No logré identificar su respuesta.${oido}\n\nElija una de estas opciones:\n\n${listarOpcionesPregunta(clave)}`,
    }
}

/* ======================================================
📷 FOTOS OPCIONALES

   En los puntos donde una imagen aporta evidencia real (documentos,
   planos, linderos, zonas especiales, restricciones, el territorio y
   la comunidad reunida) se ofrece adjuntar una foto. Siempre opcional:
   se puede omitir y el registro continúa igual.
====================================================== */

const guardarFoto = async (mediaUrl: string, nombre: string): Promise<string> => {
    const filename = `${nombre}_${Date.now()}.jpg`
    const filepath = path.join(FOTOS_DIR, filename)
    const res = await fetch(mediaUrl, {
        headers: { Authorization: `Bearer ${process.env.META_JWT_TOKEN}` },
        signal:  AbortSignal.timeout(20000),
    })
    if (!res.ok) throw new Error(`No se pudo descargar la foto (HTTP ${res.status})`)
    fs.writeFileSync(filepath, Buffer.from(await res.arrayBuffer()))
    return filepath
}

const textoPedirFoto = (queMostrar: string): string =>
    [
        `📷 *¿Quiere agregar una foto?* ${queMostrar}`,
        '',
        '_Es opcional: envíe la foto ahora, o escriba *omitir* para seguir._',
    ].join('\n')

/**
 * Procesa el paso de foto opcional. Devuelve el mensaje de respuesta —
 * en cualquier caso el registro continúa, nunca deja a la persona atascada.
 */
const procesarFotoOpcional = async (ctx: any, state: any, categoria: string): Promise<string> => {
    if (!esMensajeImagen(ctx)) {
        return '' // escribió algo (omitir o cualquier cosa): seguimos sin foto
    }
    const url = obtenerUrlMedia(ctx)
    if (!url) return 'No alcancé a recibir la imagen, pero seguimos sin problema.'
    try {
        const ruta = await guardarFoto(url, `${categoria}_${ctx.from}`)
        const previas = state.getMyState?.()?.fotos ?? []
        const descripcion = String(ctx?.caption ?? '').trim() || null
        await state.update({ fotos: [...previas, { categoria, ruta, descripcion }] })
        return '📷 Foto recibida y guardada. ¡Gracias!'
    } catch (err) {
        console.warn(`⚠️ No se pudo guardar la foto "${categoria}":`, (err as Error).message)
        return 'No pudimos guardar la foto, pero seguimos sin problema.'
    }
}

/* ======================================================
🗂️ OPCIONES VÁLIDAS DE CADA PREGUNTA CERRADA

   'valor' es exactamente lo que se guarda en la base de datos — no
   cambiarlo sin migrar los datos existentes.
   'claves' son las formas en que una persona puede decir esa opción
   al responder hablando o escribiendo libremente:
       'raiz*'      → coincide con la raíz (rio → rio, rios, riachuelo)
       'palabra'    → palabra completa únicamente
       'una frase'  → subcadena tal cual
====================================================== */
/*  Equivalencia entre el vocabulario interno de las páginas de captura y
 *  COL_MetodoProduccionTipo del estándar. El croquis dibujado sobre el
 *  mapa es, en términos de LADM, un método declarativo y colaborativo: la
 *  posición la declara la comunidad. El recorrido caminando el lindero es
 *  medición directa sobre el terreno.
 *
 *  Las páginas web y la tabla puente conservan sus nombres propios a
 *  propósito: son una cola técnica, no una clase del modelo.
 */
const METODO_LADM: Record<string, string> = {
    croquis_manual: 'Metodo_Declarativo_y_Colaborativo',
    recorrido_gps:  'Metodo_Directo',
    no_capturado:   'Sin_Metodo',
}

const OPCIONES_PREGUNTA: Record<string, OpcionSpec[]> = {
    consentimiento: [
        { valor: 'Sí', etiqueta: 'Sí, autorizo', claves: ['si', 'autorizo', 'acepto', 'de acuerdo', 'claro', 'permito'] },
        { valor: 'No', etiqueta: 'No autorizo', claves: ['no autorizo', 'no acepto', 'rechazo', 'no quiero'] },
    ],
    modo_uso: [
        { valor: 'en_linea', etiqueta: 'En línea, aquí por WhatsApp', claves: ['en linea', 'aqui', 'whatsapp', 'por chat'] },
        { valor: 'offline', etiqueta: 'Formulario sin conexión', claves: ['offline', 'formulario', 'sin internet', 'sin conexion', 'sin senal'] },
    ],
    audio_preferencia: [
        { valor: 'con_audio', etiqueta: 'Sí, con audio', claves: ['audio', 'voz', 'escuchar', 'oir', 'si'] },
        { valor: 'solo_texto', etiqueta: 'Solo texto', claves: ['texto', 'escrito', 'leer', 'sin audio'] },
    ],
    metodo_perimetro: [
        { valor: 'croquis', etiqueta: 'Dibujar croquis', claves: ['croquis', 'dibuj*', 'mapa', 'marcar'] },
        { valor: 'recorrido', etiqueta: 'Recorrido GPS', claves: ['recorrido', 'gps', 'camin*', 'caminando', 'a pie'] },
        { valor: 'despues', etiqueta: 'Hacerlo después', claves: ['despues', 'luego', 'mas tarde', 'ahora no', 'omitir', 'todavia no'] },
    ],
    // Qué se va a levantar hoy. En un territorio colectivo el título es de
    // la comunidad y es inalienable: las familias no son dueñas de su
    // parcela, tienen un derecho de uso asignado por la autoridad. Por eso
    // el mismo croquis puede significar dos cosas muy distintas, y hay que
    // saber cuál antes de empezar a dibujar.
    nivel_levantamiento: [
        { valor: 'Colectivo', etiqueta: 'El territorio colectivo completo', claves: ['colectiv*', 'territorio', 'todo', 'completo', 'comunidad', 'resguardo', 'general', 'entero'] },
        { valor: 'Familiar',  etiqueta: 'La parcela de una familia',        claves: ['familia*', 'parcela', 'casa', 'hogar', 'finca', 'lote', 'mi lugar', 'un pedazo', 'solar'] },
    ],
    origen_asignacion: [
        { valor: 'Asignacion_Asamblea', etiqueta: 'La asamblea o el cabildo se lo asignó', claves: ['asamblea', 'cabildo', 'consejo', 'asign*', 'adjudic*', 'nos dieron', 'reparti*'] },
        { valor: 'Herencia_Familiar',   etiqueta: 'Lo heredaron de su familia',            claves: ['herenc*', 'hered*', 'padres', 'abuelos', 'mis papas', 'de mi familia'] },
        { valor: 'Ocupacion_Antigua',   etiqueta: 'Ya estaban ahí antes del título',       claves: ['antes', 'siempre', 'antigu*', 'desde antes', 'ancestral*'] },
        { valor: 'Permuta_Interna',     etiqueta: 'Cambio o cesión con otra familia',      claves: ['cambio', 'permuta', 'cedi*', 'intercambi*', 'otra familia'] },
        { valor: 'Desconocido',         etiqueta: 'No lo sabe',                            claves: ['no se', 'no sabe', 'desconoc*', 'ni idea'] },
    ],
    uso_parcela: [
        { valor: 'Vivienda_y_Cultivo',  etiqueta: 'Vivienda y cultivo',            claves: ['ambos', 'las dos', 'vivir y sembrar', 'casa y cultivo', 'todo'] },
        { valor: 'Vivienda',            etiqueta: 'Solo vivienda',                 claves: ['vivienda', 'casa', 'vivir', 'habitar', 'dormir'] },
        { valor: 'Cultivo',             etiqueta: 'Cultivo o pancoger',            claves: ['cultiv*', 'sembr*', 'pancoger', 'siembra', 'agricultura', 'huerta'] },
        { valor: 'Ganaderia',           etiqueta: 'Cría de animales',              claves: ['ganad*', 'animales', 'vacas', 'cerdos', 'gallinas', 'cria'] },
        { valor: 'Bosque_Conservacion', etiqueta: 'Bosque o área de conservación', claves: ['bosque', 'monte', 'conserva*', 'reserva', 'selva'] },
    ],
    tipo_comunidad: [
        { valor: 'Comunidad_Negra', etiqueta: 'Comunidad negra (consejo comunitario)', claves: ['negra', 'afro*', 'consejo comunitario', 'palenquer*', 'raizal*'] },
        // El modelo LADM-COL distingue la comunidad indígena del cabildo y
        // del resguardo. Faltaba, y sin ella una comunidad sin resguardo
        // constituido no tenía ninguna opción correcta.
        { valor: 'Comunidad_Indigena', etiqueta: 'Comunidad indígena (sin resguardo)', claves: ['comunidad indigena', 'indigena', 'sin resguardo'] },
        { valor: 'Cabildo', etiqueta: 'Cabildo indígena', claves: ['cabildo'] },
        { valor: 'Parcialidad', etiqueta: 'Parcialidad', claves: ['parcialidad'] },
        { valor: 'Resguardo_Indigena', etiqueta: 'Resguardo indígena', claves: ['resguard*'] },
        { valor: 'Territorio_Colectivo', etiqueta: 'Territorio colectivo', claves: ['territorio colectivo', 'colectivo'] },
    ],
    tipo_organizacion_filial: [
        { valor: 'Cabildo', etiqueta: 'Cabildo', claves: ['cabildo'] },
        { valor: 'Autoridades_Tradicionales', etiqueta: 'Autoridades tradicionales', claves: ['tradicional*', 'autoridades'] },
        { valor: 'Asamblea_Comunitaria', etiqueta: 'Asamblea comunitaria', claves: ['asamblea'] },
        { valor: 'Consejo_Comunitario', etiqueta: 'Consejo comunitario', claves: ['consejo'] },
        { valor: 'Otro', etiqueta: 'Otro tipo de organización', claves: ['otro', 'otra', 'diferente'] },
    ],
    cargo_autoridad: [
        { valor: 'Gobernador', etiqueta: 'Gobernador o Gobernadora', claves: ['gobernador*'] },
        { valor: 'Capitan', etiqueta: 'Capitán', claves: ['capitan*'] },
        { valor: 'Cacique', etiqueta: 'Cacique', claves: ['cacique'] },
        { valor: 'Autoridad_Tradicional', etiqueta: 'Autoridad tradicional', claves: ['tradicional*', 'mayor*', 'anciano*'] },
        { valor: 'Representante_Legal_CC', etiqueta: 'Representante legal del consejo comunitario', claves: ['representante legal', 'consejo comunitario', 'representante'] },
        { valor: 'Otro', etiqueta: 'Otro cargo', claves: ['otro', 'otra', 'diferente'] },
    ],
    legitimidad: [
        { valor: 'Sí', etiqueta: 'Sí, fue elegida por la comunidad', claves: ['si', 'elegid*', 'eligi*', 'reconocid*', 'nombrad*', 'votad*'] },
        { valor: 'En_Proceso', etiqueta: 'Está en proceso', claves: ['proceso', 'todavia no', 'aun no', 'pendiente', 'falta'] },
    ],
    antiguedad_territorio: [
        { valor: 'Desde_Siempre', etiqueta: 'Desde siempre — territorio ancestral', claves: ['siempre', 'ancestral*', 'origen', 'ancestros'] },
        { valor: 'Desde_Hace_Muchos_Anos', etiqueta: 'Desde hace muchos años (varias generaciones)', claves: ['muchos anos', 'generacion*', 'hace mucho', 'abuelos', 'bisabuelos'] },
        { valor: 'Desde_Fecha_Aproximada', etiqueta: 'Desde una fecha aproximada que conocemos', claves: ['fecha', 'aproximad*', 'ano', 'desde el'] },
        { valor: 'Desconocida', etiqueta: 'No conocemos la fecha exacta', claves: ['no sabemos', 'no conocemos', 'desconoc*', 'ni idea', 'no se'] },
    ],
    tipo_procedimiento: [
        // La constitución de resguardo es el procedimiento más frecuente en
        // comunidades que apenas están formalizando su territorio, y era
        // justo el que faltaba.
        { valor: 'Constitucion_ResguardosIndigenas', etiqueta: 'Constitución de resguardo indígena', claves: ['constitucion', 'constitu*', 'crear resguardo', 'nuevo resguardo'] },
        { valor: 'Ampliacion_ResguardosIndigenas', etiqueta: 'Ampliación de resguardo indígena', claves: ['ampliacion'] },
        { valor: 'Ampliacion_Saneamiento_ResguardosIndigenas', etiqueta: 'Ampliación y saneamiento de resguardo', claves: ['saneamiento'] },
        { valor: 'Reestructuracion_ResguardosIndigenas', etiqueta: 'Reestructuración de resguardo', claves: ['reestructuracion', 'reestructur*'] },
        { valor: 'Conversion_Reservas_Resguardos', etiqueta: 'Conversión de reserva en resguardo', claves: ['conversion', 'reserva'] },
        { valor: 'Titulacion_Comunidades_Negras', etiqueta: 'Titulación de comunidades negras', claves: ['titulacion', 'negras', 'titular'] },
        { valor: 'En_Proceso', etiqueta: 'En proceso / aún no reconocido', claves: ['proceso', 'aun no', 'todavia no', 'ninguno'] },
    ],
    limites_territorio: [
        { valor: 'Rios', etiqueta: 'Ríos y quebradas', claves: ['rio*', 'quebrada*', 'agua', 'cano*'] },
        { valor: 'Montanas', etiqueta: 'Montañas y cerros', claves: ['montana*', 'cerro*', 'loma*', 'cordillera'] },
        { valor: 'Caminos', etiqueta: 'Caminos y senderos', claves: ['camino*', 'sendero*', 'trocha*', 'via*'] },
        { valor: 'Hitos_Naturales', etiqueta: 'Hitos naturales (árboles, piedras)', claves: ['hito*', 'arbol*', 'piedra*', 'roca*', 'natural*'] },
        { valor: 'Documentos_Oficiales', etiqueta: 'Documentos oficiales', claves: ['documento*', 'oficial*', 'escritura*', 'plano*'] },
        { valor: 'Combinacion', etiqueta: 'Combinación de los anteriores', claves: ['combinacion', 'varios', 'todos', 'de todo', 'mezcla'] },
    ],
    tipo_derecho: [
        { valor: 'Propiedad_Colectiva', etiqueta: 'Propiedad colectiva reconocida', claves: ['propiedad', 'colectiva reconocida', 'titulo'] },
        { valor: 'Posesion_Ancestral', etiqueta: 'Posesión ancestral sin título formal', claves: ['posesion', 'ancestral*', 'sin titulo'] },
        { valor: 'Uso_Usufructo', etiqueta: 'Uso y usufructo del territorio', claves: ['usufructo', 'uso'] },
        { valor: 'En_Proceso', etiqueta: 'En proceso de legalización', claves: ['proceso', 'legalizacion', 'tramite'] },
        { valor: 'Desconocido', etiqueta: 'Desconocemos el tipo de derecho', claves: ['desconoc*', 'no sabemos', 'no se', 'ni idea'] },
    ],
    // El modelo LADM-COL separa el oleoducto del gasoducto y el acueducto
    // del alcantarillado. Antes iban agrupados en una sola opción, así que
    // el dato guardado nunca coincidía con un valor del estándar. Ahora
    // cada opción corresponde a un valor real del catálogo.
    restriccion_territorio: [
        { valor: 'Minera', etiqueta: 'Actividad minera', claves: ['miner*', 'mina*', 'oro', 'carbon'] },
        { valor: 'Oleoducto', etiqueta: 'Oleoducto', claves: ['oleoducto', 'petroleo', 'crudo'] },
        { valor: 'Gasoducto', etiqueta: 'Gasoducto', claves: ['gasoducto', 'gas'] },
        { valor: 'Energia_Electrica', etiqueta: 'Línea de energía eléctrica', claves: ['energia', 'electric*', 'torre*', 'cables'] },
        { valor: 'Acueducto', etiqueta: 'Acueducto', claves: ['acueducto', 'agua potable'] },
        { valor: 'Alcantarillado', etiqueta: 'Alcantarillado', claves: ['alcantarillado', 'aguas negras', 'aguas servidas'] },
        { valor: 'Transito', etiqueta: 'Servidumbre de tránsito o paso', claves: ['transito', 'paso', 'servidumbre', 'camino de otros'] },
        { valor: 'Legal_Hidrocarburos', etiqueta: 'Restricción legal por hidrocarburos', claves: ['hidrocarburo*', 'legal'] },
        { valor: 'Ninguna', etiqueta: 'No hay restricciones', claves: ['ninguna', 'no hay', 'nada', 'ningun'] },
    ],
    uso_territorio: [
        { valor: 'Uso_Colectivo', etiqueta: 'Uso colectivo comunitario', claves: ['colectivo', 'comunitario', 'todos'] },
        { valor: 'Uso_Tradicional', etiqueta: 'Uso tradicional y cultural', claves: ['tradicional', 'cultural', 'ancestral*', 'ritual*'] },
        { valor: 'Zonas_Compartidas', etiqueta: 'Zonas compartidas con otras comunidades', claves: ['compartid*', 'otras comunidades', 'vecinos'] },
        { valor: 'Uso_Mixto', etiqueta: 'Uso mixto (colectivo y familiar)', claves: ['mixto', 'familiar', 'ambos', 'las dos'] },
    ],
    reglas_internas: [
        { valor: 'Sí', etiqueta: 'Sí, tenemos reglas internas', claves: ['si', 'tenemos', 'hay', 'existen', 'reglament*'] },
        { valor: 'No', etiqueta: 'No las tenemos formalmente', claves: ['no', 'no tenemos', 'nada', 'informal'] },
    ],
    tipo_acto_administrativo: [
        { valor: 'Resolucion', etiqueta: 'Resolución', claves: ['resolucion'] },
        { valor: 'Acuerdo', etiqueta: 'Acuerdo', claves: ['acuerdo'] },
        // Varias titulaciones colectivas se formalizaron por decreto o por
        // sentencia judicial; ninguna de las dos tenía opción antes.
        { valor: 'Decreto', etiqueta: 'Decreto', claves: ['decreto'] },
        { valor: 'Sentencia', etiqueta: 'Sentencia judicial', claves: ['sentencia', 'fallo', 'juez', 'restitucion'] },
        { valor: 'Folio_Matricula', etiqueta: 'Folio de matrícula inmobiliaria', claves: ['folio', 'matricula', 'inmobiliaria'] },
        { valor: 'Sin_Documento', etiqueta: 'No existe documento oficial todavía', claves: ['no exist*', 'no tenemos', 'ninguno', 'sin documento', 'nada'] },
    ],
    // 'Croquis_Campo' es el nombre que el estándar le da al dibujo del
    // lindero hecho por la propia comunidad: describe exactamente lo que
    // antes se guardaba como 'Mapa_Comunitario'.
    tipo_fuente_espacial: [
        { valor: 'Plano_Oficial', etiqueta: 'Plano oficial (IGAC u otra entidad)', claves: ['oficial*', 'igac', 'plano'] },
        { valor: 'Croquis_Campo', etiqueta: 'Mapa o croquis hecho por la comunidad', claves: ['comunitario', 'propio', 'nosotros', 'hecho por', 'croquis'] },
        { valor: 'Sin_Mapa', etiqueta: 'No tenemos mapa', claves: ['no tenemos', 'sin mapa', 'ninguno', 'nada'] },
    ],
    // Tipo de documento de identidad del representante. El estándar lo
    // pide aparte del número; antes se guardaba el número sin decir de
    // qué documento era.
    tipo_documento: [
        { valor: 'Cedula_Ciudadania', etiqueta: 'Cédula de ciudadanía', claves: ['cedula', 'ciudadania', 'cc', 'cedula de ciudadania'] },
        { valor: 'Cedula_Extranjeria', etiqueta: 'Cédula de extranjería', claves: ['extranjeria', 'ce', 'extranjero'] },
        { valor: 'Tarjeta_Identidad', etiqueta: 'Tarjeta de identidad', claves: ['tarjeta', 'ti', 'tarjeta de identidad'] },
        { valor: 'Pasaporte', etiqueta: 'Pasaporte', claves: ['pasaporte'] },
        { valor: 'NIT', etiqueta: 'NIT (del consejo o cabildo)', claves: ['nit', 'tributaria', 'juridica'] },
    ],
    validacion: [
        { valor: 'Validada_Asamblea', etiqueta: 'Validada en asamblea comunitaria', claves: ['asamblea'] },
        { valor: 'Revisada_Autoridades', etiqueta: 'Revisada por las autoridades', claves: ['autoridad*', 'revisad*'] },
        { valor: 'Pendiente', etiqueta: 'Aún no ha sido validada', claves: ['pendiente', 'aun no', 'todavia no', 'no ha sido', 'falta'] },
    ],
    quiere_audio_final: [
        { valor: 'si', etiqueta: 'Sí, enviar mensaje de voz', claves: ['si', 'audio', 'voz', 'mensaje', 'grabar'] },
        { valor: 'no', etiqueta: 'No, ya terminé', claves: ['no', 'termine', 'terminado', 'listo', 'ya esta', 'nada mas'] },
    ],
}

/* ======================================================
🟢 MÓDULO 0A – PREFERENCIA DE AUDIO
====================================================== */
const audioPreferenciaFlow = addKeyword<Provider, Database>(utils.setEvent('AUDIO_PREFERENCIA'))
    .addAction(
        async (ctx, { flowDynamic }) => {
            const texto = [
                '🎧 *¿Le gustaría escuchar cada pregunta en audio?*',
                '',
                'Si activa esta opción, cada pregunta llegará en un mensaje de voz y en texto.',
                '',
                '1️⃣ 🔊 Sí, con audio',
                '2️⃣ 📝 Solo texto',
            ].join('\n')
            const nombreAudio = 'Preferencia audio.mp3'

            // ✅ CORREGIDO: esta pregunta se hace ANTES de que exista una
            // preferencia guardada (state.audioEnabled aún no existe), así que
            // enviarPregunta() nunca mandaba el audio — siempre evaluaba
            // "sin preferencia" como texto solamente. Aquí forzamos el envío
            // del audio (si el archivo existe) para que la persona escuche un
            // ejemplo real antes de decidir, junto con el texto y los botones.
            if (AUDIO_CACHE.has(nombreAudio)) {
                const ruta = path.join(PREGUNTAS_DIR, nombreAudio)
                // ✅ CORREGIDO: WhatsApp no admite texto/caption en notas de
                // voz, así que el texto se manda siempre aparte (ver nota en
                // enviarPregunta más arriba).
                try {
                    await flowDynamic([{ media: ruta }])
                } catch (err) {
                    console.error(`⚠️ No se pudo enviar el audio "${nombreAudio}":`, (err as Error).message)
                }
                await flowDynamic(texto)
                await enviarOpciones(flowDynamic, '👇 Seleccione una opción:', ['🔊 Sí, con audio', '📝 Solo texto'])
            } else {
                await enviarOpciones(flowDynamic, texto, ['🔊 Sí, con audio', '📝 Solo texto'])
            }
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow, fallBack }) => {
            const d = await resolverOpcion(ctx, state, 'audio_preferencia', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            const audioEnabled = d.valor === 'con_audio'
            await state.update({ audioEnabled })
            if (audioEnabled) {
                await flowDynamic('🔊 Perfecto, le acompañaré con audio y texto en cada pregunta.')
            } else {
                await flowDynamic('📝 Entendido, seguimos solo por texto.')
            }
            // Se avisa una sola vez, aquí: de ahora en adelante cualquier
            // pregunta se puede responder hablando, no solo escribiendo.
            await flowDynamic(
                [
                    '🎙️ *Una cosa más, importante:*',
                    '',
                    'Puede responder *cualquier* pregunta con una nota de voz — mantenga pulsado el micrófono 🎤 y hable con naturalidad. Yo la escucho, la paso a texto y sigo.',
                    '',
                    'Si en algo no le entiendo bien, le pregunto de nuevo antes de guardar nada.',
                ].join('\n')
            )
            return gotoFlow(nivelLevantamientoFlow)
        }
    )

/* ======================================================
🟢 MÓDULO 0D – QUÉ SE VA A LEVANTAR

   La pregunta que decide todo lo que sigue. El mismo croquis puede ser el
   lindero de todo el territorio colectivo o el pedazo donde vive una
   familia, y hasta ahora el sistema no distinguía entre las dos cosas.

   Jurídicamente no son comparables: el título colectivo es inalienable,
   así que la comunidad tiene propiedad sobre el territorio, mientras que
   la familia tiene un derecho de uso sobre su parcela, asignado por la
   autoridad y regido por el reglamento interno. Son dos tripletas LADM
   distintas, en dos niveles.
====================================================== */
const nivelLevantamientoFlow = addKeyword<Provider, Database>(utils.setEvent('NIVEL_LEVANTAMIENTO'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    '🧭 *¿Qué vamos a registrar hoy?*',
                    '',
                    '1️⃣ *El territorio colectivo completo*',
                    '     El lindero de toda la propiedad de la comunidad.',
                    '',
                    '2️⃣ *La parcela de una familia*',
                    '     El lugar donde vive o siembra un hogar, dentro del territorio.',
                    '     ⚠️ Para esto, el territorio colectivo de la comunidad debe estar ya registrado (así sea sin el croquis/GPS todavía).',
                    '',
                    '_Si es la primera vez que registran este territorio, elija la 1._',
                ].join('\n'),
                // Textos cortos a propósito (ver acortarBoton): con la
                // numeración y el emoji, "Territorio completo" y "Parcela
                // de una familia" no caben en los 16 caracteres que permite
                // el botón — la descripción completa ya va arriba, en el
                // mensaje. 🌍 en vez de 🗺️ porque este último ocupa un
                // carácter más (trae variador de emoji) y hacía que ni
                // "Territorio" solo cupiera entero.
                ['🌍 Territorio', '🏠 Parcela']
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'nivel_levantamiento', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ nivel_levantamiento: d.valor })

            if (d.valor === 'Familiar') return gotoFlow(buscarTerritorioFlow)
            return gotoFlow(ubicacionFlow)
        }
    )

/* ======================================================
🟢 MÓDULO 0E – A QUÉ TERRITORIO PERTENECE LA PARCELA

   Una parcela familiar no existe por sí sola: cuelga de un territorio
   colectivo ya registrado. Aquí se busca ese territorio por su nombre, sin
   pedirle a nadie que recuerde un código.
====================================================== */
const buscarTerritorioFlow = addKeyword<Provider, Database>(utils.setEvent('BUSCAR_TERRITORIO'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    '🔎 *¿En qué territorio queda esa parcela?*',
                    '',
                    'Dígame el nombre de la comunidad o del resguardo — por ejemplo _Consejo Comunitario La Esperanza_ o _Resguardo Alto Sinú_.',
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'busqueda_territorio', flowDynamic)
            if (texto.trim().length < 3) {
                return fallBack('Escriba o dicte el nombre de la comunidad o del territorio.')
            }

            let encontrados: Awaited<ReturnType<typeof buscarTerritorios>> = []
            try {
                encontrados = await buscarTerritorios(texto)
            } catch (err) {
                console.error('⚠️ Error buscando territorios:', (err as Error).message)
                return fallBack('No pude consultar los territorios en este momento. ¿Puede intentarlo otra vez?')
            }

            if (encontrados.length === 0) {
                return fallBack([
                    `😕 No encontré ningún territorio registrado que se parezca a *${texto.trim()}*.`,
                    '',
                    '⚠️ *Antes de registrar la parcela de una familia, el territorio colectivo de esa comunidad debe estar registrado* (así sea sin el croquis/GPS todavía — eso se puede completar después).',
                    '',
                    'Puede intentar escribir el nombre de otra forma, o escribir *hola* para iniciar el registro del territorio colectivo (elija la opción 1 cuando se le pregunte qué van a registrar).',
                ].join('\n'))
            }

            // Con un solo resultado no tiene sentido hacer elegir.
            if (encontrados.length === 1) {
                const t = encontrados[0]
                await state.update({
                    comunidad_id_padre: t.comunidad_id,
                    predio_matriz_id:   t.predio_id,
                    nombre_territorio_padre: t.nombre_territorio || t.nombre_comunidad,
                })
                await flowDynamic(
                    `✅ Es *${t.nombre_territorio || t.nombre_comunidad}*` +
                    (t.municipio ? `, en ${t.municipio}` : '') +
                    '.\n\nSigamos con los datos de la familia.'
                )
                return gotoFlow(ubicacionFlow)
            }

            await state.update({ candidatos_territorio: encontrados })
            await flowDynamic([
                '🔎 Encontré varios. ¿Cuál es?',
                '',
                ...encontrados.map((t, i) =>
                    `${i + 1}️⃣ *${t.nombre_territorio || t.nombre_comunidad}*` +
                    (t.municipio ? ` — ${t.municipio}, ${t.departamento}` : '')
                ),
                '',
                '_Responda con el número._',
            ].join('\n'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, fallBack, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            const candidatos = st.candidatos_territorio ?? []

            // Si solo había uno, este paso ya no aplica: el anterior saltó
            // directo a la ubicación y nunca se llega aquí.
            if (!candidatos.length) return gotoFlow(ubicacionFlow)

            const texto = await obtenerTextoRespuesta(ctx, state, 'eleccion_territorio', flowDynamic)
            // extraerNumeroOpcion espera el texto ya normalizado, y entiende
            // tanto «2» como «el dos» o «la opción dos», que es lo que suele
            // salir cuando la respuesta llega dictada.
            const n = extraerNumeroOpcion(sinTildes(texto))
            if (n === null || n < 1 || n > candidatos.length) {
                return fallBack(`Responda con un número del 1 al ${candidatos.length}.`)
            }

            const t = candidatos[n - 1]
            await state.update({
                comunidad_id_padre: t.comunidad_id,
                predio_matriz_id:   t.predio_id,
                nombre_territorio_padre: t.nombre_territorio || t.nombre_comunidad,
                candidatos_territorio: null,
            })
            await flowDynamic(`✅ Anotado: *${t.nombre_territorio || t.nombre_comunidad}*.\n\nSigamos con los datos de la familia.`)
            return gotoFlow(ubicacionFlow)
        }
    )

/* ======================================================
🟢 MÓDULO 0B – MODO ONLINE / OFFLINE
====================================================== */
const modoUsoFlow = addKeyword<Provider, Database>(utils.setEvent('MODO_USO'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                // ✅ CORREGIDO: le faltaba audio a esta pregunta — antes se
                // enviaba solo en texto aunque la persona hubiera elegido
                // "con audio". Generado con generar_audios.mjs.
                'Modulo 0B modo uso.mp3',
                [
                    '📡 *¿Cómo desea completar el registro?*',
                    '',
                    '1️⃣ 🌐 En línea (aquí por WhatsApp)',
                    '2️⃣ 📋 Formulario offline (sin internet)',
                ].join('\n'),
                // "Formulario offline" no cabe en el botón (ver
                // acortarBoton); la explicación completa ya va arriba.
                ['🌐 En línea', '📋 Sin datos']
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow, fallBack }) => {
            const d = await resolverOpcion(ctx, state, 'modo_uso', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            const esOffline = d.valor === 'offline'
            if (esOffline) {
                // ✅ CORREGIDO: usa BOT_PUBLIC_URL o la dirección pública configurada
                const host   = process.env.BOT_PUBLIC_URL ?? `http://localhost:${PORT}`
                const enlace = `${host}/formulario`
                await flowDynamic([
                    {
                        body: [
                            '📋 *Formulario sin conexión*',
                            '',
                            `🔗 Abra este enlace *ahora que tiene internet*:`,
                            `${enlace}`,
                            '',
                            '📲 *Instrucciones:*',
                            '1️⃣ Abra el enlace con internet activo',
                            '2️⃣ Toque los tres puntos → *"Agregar a pantalla de inicio"*',
                            '3️⃣ Apague el internet y abra la app guardada',
                            '4️⃣ Complete el formulario y toque *"Enviar registro"* al reconectarse',
                            '',
                            '_El formulario guarda los datos en su dispositivo hasta que haya señal._',
                        ].join('\n'),
                    },
                ])
                return
            }
            return gotoFlow(audioPreferenciaFlow)
        }
    )

/* ======================================================
🟢 MÓDULO 0C – CONSENTIMIENTO Y BIENVENIDA
====================================================== */
const consentimientoFlow = addKeyword<Provider, Database>(['hola', 'inicio', 'start', 'registrar'])
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Bienvenida.mp3',
                '🌿 *Bienvenido(a) al Registro Territorial Comunitario*'
            )
            await enviarPregunta(
                flowDynamic, state,
                'Consentimiento.mp3',
                '📋 ¿Nos autoriza a recopilar esta información de forma voluntaria para el reconocimiento y protección de los derechos territoriales de su comunidad?',
                ['✅ Sí, autorizo', '❌ No autorizo']
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'consentimiento', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            if (d.valor === 'No') {
                await state.update({ consentimiento: 'No' })
                return fallBack(
                    '🙏 Respetamos su decisión. Sin su autorización no podemos continuar.\n\nSi cambia de opinión, escríbanos *hola* cuando lo desee.'
                )
            }
            // whatsapp_id queda desde el primer mensaje: es lo que permite,
            // más adelante, encontrar "su" territorio sin volver a preguntar
            // nada — tanto para retomar el perímetro pendiente (ver
            // retomarPerimetroFlow) como para el recordatorio automático.
            await state.update({ consentimiento: 'Sí', whatsapp_id: ctx.from })
            // Antes aquí se preguntaba "¿está listo para continuar ahora?".
            // Se quitó: quien acaba de autorizar ya dijo que sí.
            return gotoFlow(modoUsoFlow)
        }
    )

/* ======================================================
🟢 MÓDULO 1 – IDENTIFICACIÓN DE LA COMUNIDAD
====================================================== */
const modulo1Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_1'))
    // Pregunta 1: nombre comunidad
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 1 inicio.mp3',
                '🏡 *¿Cuál es el nombre con el que se identifica su comunidad?*\n\nEscriba el nombre completo tal como lo usan oficialmente.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const valor = (await obtenerTextoRespuesta(ctx, state, 'nombre_comunidad', flowDynamic)).trim()
            if (valor.length < 2) return fallBack('Por favor dígame el nombre completo de su comunidad.')
            await state.update({ nombre_comunidad: valor })
        }
    )
    // Pregunta 2: tipo de comunidad
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta 2.mp3',
                [
                    '🏘️ *¿Cómo describiría el tipo de comunidad a la que pertenece?*',
                    '',
                    '1️⃣ Comunidad negra (consejo comunitario)',
                    '2️⃣ Cabildo indígena',
                    '3️⃣ Parcialidad',
                    '4️⃣ Resguardo indígena',
                    '5️⃣ Territorio colectivo',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'tipo_comunidad', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ tipo_comunidad: d.valor })
        }
    )
    // Pregunta 3: pueblo indígena / grupo étnico
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta 3.mp3',
                '🌿 *¿A qué pueblo indígena o grupo étnico pertenece su comunidad?*\n\nEscriba el nombre de su pueblo o grupo étnico.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'pueblo_indigena', flowDynamic)
            if (texto.trim().length < 2) return fallBack('Por favor escriba el nombre de su pueblo o grupo étnico.')
            await state.update({ pueblo_indigena: texto.trim() })
        }
    )
    // Pregunta 4: tipo de organización
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta 4.mp3',
                [
                    '🤝 *¿Cómo se organizan como comunidad?*',
                    '',
                    '1️⃣ Cabildo',
                    '2️⃣ Autoridades tradicionales',
                    '3️⃣ Asamblea comunitaria',
                    '4️⃣ Consejo comunitario',
                    '5️⃣ Otro',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'tipo_organizacion_filial', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ tipo_organizacion_filial: d.valor })
        }
    )
    // Pregunta 5: familias
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta 5.mp3',
                '👨‍👩‍👧‍👦 *¿Cuántas familias viven aproximadamente en el territorio?*\n\nEscriba solo el número. Ejemplo: _45_'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'familias_aprox', flowDynamic)
            // Dictado por voz llega "cuarenta y cinco": se convierte a número.
            const numero = extraerNumero(texto)
            if (!numero || !esNumeroValido(numero)) return fallBack('Por favor dígame solo el número de familias. Ejemplo: _45_')
            await state.update({ familias_aprox: numero })
        }
    )
    // Pregunta 6: personas
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta 6.mp3',
                '👥 *¿Cuántas personas viven aproximadamente en el territorio?*\n\nEscriba solo el número. Ejemplo: _180_'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'personas_aprox', flowDynamic)
            // Dictado por voz llega "cuarenta y cinco": se convierte a número.
            const numero = extraerNumero(texto)
            if (!numero || !esNumeroValido(numero)) return fallBack('Por favor dígame solo el número de personas. Ejemplo: _180_')
            await state.update({ personas_aprox: numero })
        }
    )
    // Pregunta 7: mujeres
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta 7.mp3',
                '👩 *¿Cuántas son mujeres?*\n\nEscriba solo el número. Ejemplo: _90_'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'numero_mujeres', flowDynamic)
            // Dictado por voz llega "cuarenta y cinco": se convierte a número.
            const numero = extraerNumero(texto)
            if (!numero || !esNumeroValido(numero)) return fallBack('Por favor dígame solo el número de mujeres. Ejemplo: _90_')
            await state.update({ numero_mujeres: numero })
        }
    )
    // Pregunta 8: hombres
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta 8.mp3',
                '👨 *¿Y cuántos son hombres?*\n\nEscriba solo el número. Ejemplo: _90_'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'numero_hombres', flowDynamic)
            // Dictado por voz llega "cuarenta y cinco": se convierte a número.
            const numero = extraerNumero(texto)
            if (!numero || !esNumeroValido(numero)) return fallBack('Por favor dígame solo el número de hombres. Ejemplo: _90_')
            await state.update({ numero_hombres: numero })
            return gotoFlow(modulo2Flow)
        }
    )

/* ======================================================
🟢 MÓDULO 2 – REPRESENTANTE LEGAL Y AUTORIDADES
====================================================== */
const modulo2Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_2'))
    // Q1: nombre autoridad
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 2 inicio.mp3',
                [
                    'Perfecto, ya sé quiénes son. Ahora hablemos de quién los representa ante las autoridades.',
                    '',
                    '👤 ¿Cuál es el nombre completo del representante legal o autoridad principal de la comunidad?',
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'autoridades', flowDynamic)
            if (texto.trim().length < 3) return fallBack('Por favor escriba el nombre completo de la autoridad o representante.')
            await state.update({ autoridades: texto.trim() })
        }
    )
    // Q2: cargo
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 2 cargo.mp3',
                [
                    '🎖️ *¿Qué cargo ocupa esta persona dentro de la comunidad?*',
                    '',
                    '1️⃣ Gobernador(a)',
                    '2️⃣ Capitán',
                    '3️⃣ Cacique',
                    '4️⃣ Autoridad tradicional',
                    '5️⃣ Representante legal consejo comunitario',
                    '6️⃣ Otro cargo',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'cargo_autoridad', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ cargo_autoridad: d.valor })
        }
    )
    // Q3a: tipo de documento
    //
    // El modelo pide el tipo de documento además del número. Antes se
    // guardaba el número solo, sin decir de qué documento era, lo que hace
    // imposible cruzarlo contra cualquier registro oficial.
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    '🪪 *¿Qué tipo de documento tiene el representante?*',
                    '',
                    ...OPCIONES_PREGUNTA.tipo_documento.map((o, i) => `${i + 1}️⃣ ${o.etiqueta}`),
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'tipo_documento', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ tipo_documento: d.valor })
        }
    )
    // Q3b: número de documento
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 2 documento.mp3',
                '🪪 *¿Cuál es el número de documento de identidad del representante?*\n\nSi no aplica, escriba _no aplica_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const bruto = await obtenerTextoRespuesta(ctx, state, 'numero_documento_representante', flowDynamic)
            // Si lo dictaron, se prefiere el número en dígitos.
            const v = (extraerNumero(bruto) ?? bruto).trim()
            if (v.length < 2) return fallBack('Por favor dígame el número de documento, o _no aplica_.')
            await state.update({ numero_documento_representante: v })
        }
    )
    // Q4: legitimidad
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 2 legitimidad.mp3',
                [
                    '🗳️ *¿Esta persona fue elegida o reconocida por la comunidad?*',
                    '',
                    '1️⃣ ✅ Sí, fue elegida',
                    '2️⃣ ⏳ Está en proceso',
                ].join('\n'),
                ['✅ Sí, fue elegida', '⏳ Está en proceso']
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, fallBack, flowDynamic }) => {
            // Antes, cualquier respuesta que no dijera "elegida" se guardaba
            // como 'En_Proceso' en silencio, aunque la persona hubiera dicho
            // otra cosa. Ahora se interpreta de verdad y, si no se entiende,
            // se vuelve a preguntar en vez de inventar un valor.
            const d = await resolverOpcion(ctx, state, 'legitimidad', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ legitimidad: d.valor })
        }
    )
    // Q5: teléfono de contacto
    //
    // La columna existía desde el principio y nunca se preguntaba. Es
    // opcional a propósito: en muchos territorios no hay señal estable y
    // exigirlo detendría el registro.
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                '📞 *¿Hay un número de teléfono de contacto de la comunidad o del representante?*\n\nSi prefiere no dejarlo, escriba _no_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, flowDynamic }) => {
            const bruto = await obtenerTextoRespuesta(ctx, state, 'telefono', flowDynamic)
            const v = (extraerNumero(bruto) ?? bruto).trim()
            // Si dice que no, se sigue sin insistir: es un dato opcional.
            await state.update({ telefono: sinDatoQueDar(bruto) || v.length < 7 ? null : v })
            return gotoFlow(modulo3Flow)
        }
    )

/* ======================================================
🟢 MÓDULO 3 – HISTORIA DEL TERRITORIO
====================================================== */
const audioHistoriaFlow = addKeyword<Provider, Database>(utils.setEvent('AUDIO_HISTORIA'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta historia2.mp3',
                '🎤 Estamos listos para escucharle. Envíe su mensaje de voz contando la historia del territorio.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const audioUrl = obtenerUrlAudio(ctx)
            if (audioUrl) {
                try {
                    const filepath = await guardarAudio(audioUrl, `historia_${ctx.from}`)
                    await state.update({ audio_historia_url: filepath })
                    await flowDynamic('⏳ Audio recibido. Transcribiendo con Whisper...')
                    // Transcribir con Groq Whisper
                    const transcripcion = await transcribirAudio(filepath)
                    if (transcripcion) {
                        await state.update({ transcripcion_historia: transcripcion })
                        await flowDynamic(
                            `✅ ¡Audio recibido y transcrito!\n\n_Texto detectado:_ "${transcripcion.slice(0, 200)}${transcripcion.length > 200 ? '...' : ''}"`
                        )
                    } else {
                        await flowDynamic('✅ ¡Audio recibido y guardado! Gracias por compartir la historia de su territorio.')
                    }
                } catch {
                    await flowDynamic('No pudimos guardar el audio, pero continuamos. La historia escrita quedó guardada.')
                }
            } else {
                await flowDynamic('No detectamos un mensaje de voz. Continuamos con lo que ya nos contó. 🙏')
            }
            return gotoFlow(modulo4Flow)
        }
    )

const modulo3Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_3'))
    // Q1: antigüedad
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 3 inicio.mp3',
                [
                    'Ahora me gustaría conocer la historia de su territorio — esto es tan importante como los datos técnicos, así que tómese el tiempo que necesite.',
                    '',
                    '📅 *¿Desde cuándo habita su comunidad este territorio?*',
                    '',
                    '1️⃣ Desde siempre — es un territorio ancestral',
                    '2️⃣ Desde hace muchos años (varias generaciones)',
                    '3️⃣ Desde una fecha aproximada que conocemos',
                    '4️⃣ No conocemos la fecha exacta',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'antiguedad_territorio', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ antiguedad_territorio: d.valor })
        }
    )
    // Q2: historia (texto o voz)
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Pregunta historia1.mp3',
                '🎙️ *¿Puede contarnos cómo llegaron a este territorio?*\n\nPuede enviar un mensaje de texto o voz contando los detalles.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const audioUrl = obtenerUrlAudio(ctx)
            if (audioUrl) {
                try {
                    const filepath = await guardarAudio(audioUrl, `historia_${ctx.from}`)
                    await state.update({ audio_historia_url: filepath })
                    await flowDynamic('⏳ Audio recibido. Transcribiendo...')
                    const transcripcion = await transcribirAudio(filepath)
                    if (transcripcion) {
                        await state.update({ transcripcion_historia: transcripcion })
                        await flowDynamic(`✅ ¡Audio transcrito! _"${transcripcion.slice(0, 150)}${transcripcion.length > 150 ? '...' : ''}"`)
                    } else {
                        await flowDynamic('✅ ¡Audio recibido! Gracias por compartir la historia de su territorio.')
                    }
                } catch {
                    await flowDynamic('No pudimos guardar el audio, pero continuamos.')
                }
            } else {
                const texto = (await obtenerTextoRespuesta(ctx, state, 'descripcion_historia', flowDynamic)).trim()
                if (texto.length >= 3) await state.update({ descripcion_historia: texto })
            }
        }
    )
    // 📷 Foto opcional — territorio
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Si quiere, envíe una foto del territorio — un paisaje, un lugar importante para la comunidad.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'territorio')
            if (aviso) await flowDynamic(aviso)
            return gotoFlow(modulo4Flow)
        }
    )

/* ======================================================
🟢 UBICACIÓN DEL TERRITORIO
   Va primero en la conversación: en cuanto tenemos el punto en
   el mapa, el departamento/municipio/vereda se detectan solos y
   ya no hace falta pedirle a la persona que los vuelva a escribir
   ni que los confirme — solo se pregunta lo que de verdad no se
   pudo detectar.
====================================================== */
const ubicacionFlow = addKeyword<Provider, Database>(utils.setEvent('UBICACION'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 4 gps.mp3',
                [
                    'Para arrancar, ubiquemos el territorio en el mapa — así avanzamos más rápido en el resto de las preguntas.',
                    '',
                    '📍 Toque el clip 📎 → *Ubicación* → *Enviar mi ubicación actual*',
                    '',
                    '_¿Prefiere no compartirla? Escriba *no* y seguimos escribiendo el lugar a mano._',
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow, fallBack }) => {
            // Si prefiere no compartir ubicación puede decirlo hablando o
            // escribiendo; solo se transcribe cuando NO es una ubicación.
            const body = esMensajeAudio(ctx)
                ? sinTildes(await obtenerTextoRespuesta(ctx, state, 'prefiere_ubicacion_manual', flowDynamic))
                : String(ctx.body ?? '').trim().toLowerCase()
            if (/\bno\b/.test(body) || body.includes('manual') || body.includes('a mano')) {
                await flowDynamic('Sin problema, lo escribimos a mano.')
                return gotoFlow(modulo4bFlow)
            }

            const msg = ctx.message ?? (ctx as any).messages?.[0]?.message ?? {}
            const loc =
                msg.locationMessage           ??
                msg.liveLocationMessage       ??
                msg.extendedTextMessage?.contextInfo?.quotedMessage?.locationMessage ??
                (ctx as any).message?.locationMessage ??
                null

            const latDirect = (ctx as any).latitude  ?? (ctx as any).lat
            const lonDirect = (ctx as any).longitude ?? (ctx as any).lon
            const lat: number | undefined = loc?.degreesLatitude  ?? latDirect
            const lon: number | undefined = loc?.degreesLongitude ?? lonDirect

            if (lat != null && lon != null && !isNaN(Number(lat)) && !isNaN(Number(lon))) {
                const latN = Number(lat)
                const lonN = Number(lon)
                await state.update({ latitud: latN, longitud: lonN })
                await flowDynamic(`📌 Ubicación recibida (${latN.toFixed(4)}, ${lonN.toFixed(4)}) — un momento, la estoy ubicando...`)

                try {
                    const ubicacion = await obtenerUbicacion(latN, lonN)
                    if (ubicacion && ubicacion.departamento !== 'Desconocido') {
                        await state.update({
                            departamento: ubicacion.departamento,
                            municipio:    ubicacion.municipio,
                        })
                        // La vereda es el dato más fino y Nominatim casi nunca la
                        // detecta bien en zona rural — si vino confiable, la
                        // guardamos y seguimos derecho; si no, se la pedimos
                        // directamente (sin "confirmar" nada, una sola pregunta).
                        if (ubicacion.vereda !== 'Desconocida') {
                            await state.update({ vereda: ubicacion.vereda })
                            await flowDynamic(
                                `✅ Ya sé dónde queda: *${ubicacion.municipio}, ${ubicacion.departamento}* — vereda *${ubicacion.vereda}*.`
                            )
                            return gotoFlow(corregimientoFlow)
                        }
                        await flowDynamic(
                            `✅ Ya sé dónde queda: *${ubicacion.municipio}, ${ubicacion.departamento}*.`
                        )
                        return gotoFlow(veredaFlow)
                    }
                    await flowDynamic('📌 Guardé las coordenadas, pero no logré reconocer el municipio automáticamente — lo escribimos a mano.')
                } catch {
                    await flowDynamic('📌 Guardé las coordenadas. No pude consultar el municipio en este momento — lo escribimos a mano.')
                }
                return gotoFlow(modulo4bFlow)
            }

            // Antes esto terminaba el handler sin fallBack ni gotoFlow y la
            // conversación quedaba muerta: el bot no volvía a responder nunca.
            return fallBack([
                '⚠️ No me llegó la ubicación en ese mensaje.',
                '',
                'Intente de nuevo:',
                '📎 → *Ubicación* → *Enviar mi ubicación actual*',
                '',
                '_O responda *no* si prefiere que sigamos a mano._',
            ].join('\n'))
        }
    )

// Se pregunta cuando ya tenemos departamento/municipio por GPS pero la
// vereda no se pudo detectar — una sola pregunta, sin pasos de más.
const veredaFlow = addKeyword<Provider, Database>(utils.setEvent('VEREDA_UNICA'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 4 vereda.mp3',
                '🏡 ¿Y en qué vereda o corregimiento, dentro de ese municipio?'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'vereda', flowDynamic)
            if (texto.trim().length < 2) return fallBack('Cuénteme el nombre de la vereda.')
            await state.update({ vereda: texto.trim() })
            return gotoFlow(corregimientoFlow)
        }
    )

// El corregimiento es el nivel intermedio entre el municipio y la vereda.
// La columna existía en tpc_predio desde el principio pero nunca se
// preguntaba, así que quedaba siempre vacía; el modelo lo pide aparte
// porque no toda vereda pertenece a un corregimiento.
const corregimientoFlow = addKeyword<Provider, Database>(utils.setEvent('CORREGIMIENTO'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                '🏘️ *¿Esa vereda pertenece a algún corregimiento?*\n\nSi no pertenece a ninguno o no lo sabe, responda _no_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'corregimiento', flowDynamic)
            const limpio = texto.trim()
            await state.update({
                corregimiento: (sinDatoQueDar(limpio) || limpio.length < 3) ? null : limpio,
            })
            return gotoFlow(capturaPerimetroFlow)
        }
    )

// Solo se usa cuando no hubo GPS o no se pudo ubicar automáticamente:
// se pregunta departamento, municipio y vereda directo, sin pedirle a la
// persona que confirme nada que el bot ya debería saber.
const modulo4bFlow = addKeyword<Provider, Database>(utils.setEvent('MODULO_4B'))
    // Departamento
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(flowDynamic, state, 'Modulo 4 departamento.mp3', '🗺️ ¿En qué departamento se encuentra el territorio?')
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'departamento', flowDynamic)
            if (texto.trim().length < 2) return fallBack('Escriba el nombre del departamento.')
            await state.update({ departamento: texto.trim() })
        }
    )
    // Municipio
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(flowDynamic, state, 'Modulo 4 municipio.mp3', '🏙️ ¿Y en qué municipio?')
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'municipio', flowDynamic)
            if (texto.trim().length < 2) return fallBack('Escriba el nombre del municipio.')
            await state.update({ municipio: texto.trim() })
        }
    )
    // Vereda
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 4 vereda.mp3',
                '🏡 ¿Y en qué vereda está el territorio?'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'vereda', flowDynamic)
            if (texto.trim().length < 2) return fallBack('Escriba el nombre de la vereda.')
            await state.update({ vereda: texto.trim() })
            return gotoFlow(corregimientoFlow)
        }
    )

/* ======================================================
🟢 MÓDULO 4C – CAPTURA FÍSICA DEL PERÍMETRO TERRITORIAL
   (croquis georreferenciado / recorrido GPS caminado)

   Para una parcela familiar este paso sigue siendo OBLIGATORIO: no
   existe parcela sin lindero.

   Para el territorio colectivo dejó de serlo: la comunidad puede
   guardar el resto del registro y dejar el croquis/recorrido GPS
   pendiente para más adelante — incluso después de haber registrado
   ya las parcelas de las familias. Quien decide es la misma persona,
   con una tercera opción ("Hacerlo después"); si la elige, el
   territorio se guarda con el perímetro vacío y queda disponible para
   retomarlo luego (ver retomarPerimetroFlow, palabra clave
   *perímetro*) o para el recordatorio automático
   (recordarPerimetroPendiente).

   El dibujo/recorrido ocurre FUERA de WhatsApp, en un navegador
   (croquis.html o recorrido.html), identificado por un token de
   un solo uso que viaja en la URL. El resultado se guarda en
   tpc_captura_perimetro_pendiente (ver migrate_perimetro.sql) y
   esta conversación lo recoge cuando la persona escribe de vuelta
   en WhatsApp, para luego incluirlo en el INSERT final de
   tpc_predio dentro de saveToDatabase() — o, si se llegó aquí
   retomando un territorio ya guardado, en un UPDATE directo sobre
   ese tpc_predio.
====================================================== */
const capturaPerimetroFlow = addKeyword<Provider, Database>(utils.setEvent('CAPTURA_PERIMETRO'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            const esFamiliar = st.nivel_levantamiento === 'Familiar'
            // Al retomar un territorio ya guardado (retomarPerimetroFlow) no
            // tiene sentido ofrecer "hacerlo después": es exactamente para lo
            // que la persona escribió *perímetro* en primer lugar.
            const puedeDiferir = !esFamiliar && !st.retomar_predio_id

            const texto = [
                '📐 Ahora necesito el contorno del territorio — el lindero completo — para calcular su área real. Hay dos formas de dármelo, elija la que le resulte más fácil:',
                '',
                '✏️ *Croquis*: dibuja el contorno sobre un mapa, tocando cada esquina del territorio.',
                '🚶 *Recorrido GPS*: camina todo el borde con el celular encendido y la app va trazando la ruta sola.',
                '',
                esFamiliar
                    ? 'Este paso es indispensable para completar el registro de la parcela — no se puede omitir.'
                    : puedeDiferir
                        ? 'Si en este momento no pueden reunirse para recorrer el lindero, no hay problema: pueden hacerlo más adelante y seguir con el resto del registro. Cuando estén listos, escriban *perímetro* y los guío, o yo les recuerdo si se demoran.'
                        : 'Este paso es indispensable para completar el registro — no se puede omitir.',
            ].join('\n')

            const opciones = puedeDiferir
                // Textos cortos a propósito: con la numeración y el emoji ya
                // casi no queda espacio dentro del límite de 16 caracteres
                // que impone el proveedor de WhatsApp (ver acortarBoton()).
                // La explicación completa ya va en el mensaje de arriba.
                ? ['✏️ Croquis', '🚶 Recorrido', '⏭️ Después']
                : ['✏️ Croquis', '🚶 Recorrido']
            await enviarOpciones(flowDynamic, texto, opciones)
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, fallBack, gotoFlow }) => {
            const d = await resolverOpcion(ctx, state, 'metodo_perimetro', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)

            if (d.valor === 'despues') {
                const retomarPredioId = state.getMyState()?.retomar_predio_id
                await state.update({ perimetro_diferido: true })
                if (retomarPredioId) {
                    // No debería llegar aquí (la opción no se ofrece al
                    // retomar), pero por si acaso no se deja a nadie sin
                    // salida. No se usa gotoFlow: al no encadenar a otro
                    // flujo, la conversación simplemente queda a la espera
                    // del siguiente mensaje — así termina cualquier flujo
                    // en este proyecto sin usar endFlow (ver nota en
                    // retomarPerimetroFlow).
                    await flowDynamic('De acuerdo, cuando estén listos vuelvan a escribir *perímetro*.')
                    return
                }
                await flowDynamic(
                    [
                        '👍 Sin problema. Seguimos con el resto del registro y dejamos pendiente el croquis o recorrido del lindero.',
                        '',
                        'Cuando la comunidad esté lista, escriban *perímetro* desde este mismo WhatsApp y los guío. Si se demoran, yo mismo les voy a recordar.',
                    ].join('\n')
                )
                return gotoFlow(modulo1Flow)
            }

            const esCroquis = d.valor === 'croquis'

            const token = randomUUID()
            const ruta  = esCroquis ? '/croquis' : '/recorrido'
            const host  = process.env.BOT_PUBLIC_URL ?? `http://localhost:${PORT}`

            // Si la persona ya compartió su ubicación por WhatsApp (en
            // ubicacionFlow, más atrás), se la pasamos a la página por la
            // URL — así el mapa la ubica de una vez, sin tener que pedirle
            // permiso de GPS al navegador otra vez (que en el navegador
            // propio de WhatsApp a veces ni siquiera lo pide).
            const stUbic = state.getMyState()
            const lat = stUbic?.latitud
            const lon = stUbic?.longitud
            const coordsQS = (typeof lat === 'number' && typeof lon === 'number')
                ? `&lat=${lat}&lon=${lon}`
                : ''

            const enlace = `${host}${ruta}?token=${token}${coordsQS}`

            await state.update({ perimetro_token: token })

            const esNgrok = host.includes('ngrok')

            await flowDynamic(
                [
                    `🔗 *Abra este enlace en su navegador:*`,
                    enlace,
                    '',
                    ...(esNgrok
                        ? [
                              '⚠️ La primera vez puede aparecer una pantalla de aviso de ngrok ' +
                                  '("You are about to visit...") — es normal, es solo la primera vez que ' +
                                  'entra desde ese celular. Toque *Visit Site* para continuar al mapa.',
                              '',
                          ]
                        : []),
                    esCroquis
                        ? '1️⃣ Toque sobre el mapa para marcar cada esquina del territorio.'
                        : '1️⃣ Toque "Iniciar recorrido" y camine todo el borde del territorio.',
                    '2️⃣ Toque el botón de guardar cuando termine.',
                    '3️⃣ Cuando vea el mensaje "✅ Enviado correctamente", regrese a este chat y escriba *listo*.',
                    '',
                    '_Funciona incluso sin conexión: si no hay internet en ese momento, se guarda en su teléfono y se envía solo apenas recupere señal — solo debe volver a abrir esa misma página cuando tenga señal para que se termine de enviar._',
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, fallBack, gotoFlow }) => {
            const st    = state.getMyState()
            const token = st?.perimetro_token

            if (!token) {
                // Estado perdido (reinicio de sesión, etc.) — no debería pasar
                // en uso normal, pero evita quedar atascado sin salida.
                return fallBack('No encontramos su enlace de captura. Escriba *hola* para reiniciar el registro.')
            }

            try {
                const res = await pool.query(
                    `SELECT metodo, geojson, puntos_gps, area_ha, vertices
                     FROM tpc_captura_perimetro_pendiente
                     WHERE token = $1 AND usado = false`,
                    [token]
                )

                if (res.rows.length === 0) {
                    return fallBack(
                        [
                            '⏳ Todavía no detectamos el envío desde el mapa.',
                            '',
                            'Verifique que en la página haya tocado el botón para guardar y que diga "Enviado correctamente", y vuelva a escribir *listo*.',
                        ].join('\n')
                    )
                }

                const captura = res.rows[0]

                await pool.query(
                    `UPDATE tpc_captura_perimetro_pendiente SET usado = true, usado_en = NOW() WHERE token = $1`,
                    [token]
                )

                // Las páginas de captura siguen hablando de 'croquis_manual' y
                // 'recorrido_gps' — es su vocabulario interno. La traducción
                // al nombre del estándar ocurre aquí, en el único punto donde
                // el dato pasa de la cola técnica al registro definitivo.
                //
                // Solo se traduce si la migración está aplicada: sin ella la
                // columna sigue siendo VARCHAR(30) con un CHECK que
                // únicamente acepta los nombres viejos.
                const metodoCapturado = ladmAplicado
                    ? (METODO_LADM[captura.metodo] ?? 'Metodo_Declarativo_y_Colaborativo')
                    : captura.metodo
                const geojsonStr = JSON.stringify(captura.geojson)
                const puntosStr  = captura.puntos_gps ? JSON.stringify(captura.puntos_gps) : null
                const metodoTexto = captura.metodo === 'croquis_manual' ? 'Croquis dibujado' : 'Recorrido GPS'

                // Caso "retomar" (llegó aquí por retomarPerimetroFlow, no por
                // el registro en curso): el territorio ya existe en la base
                // de datos, solo falta completarle el perímetro con un
                // UPDATE directo — no hay nada más del registro por seguir.
                const retomarPredioId = st?.retomar_predio_id
                if (retomarPredioId) {
                    await pool.query(
                        `UPDATE tpc_predio
                            SET metodo_captura_perimetro = $1,
                                geojson_perimetro = $2::text::jsonb,
                                puntos_recorrido_gps = $3,
                                geom_perimetro = ST_SetSRID(ST_GeomFromGeoJSON($2::text), 4326)
                          WHERE id = $4`,
                        [metodoCapturado, geojsonStr, puntosStr, retomarPredioId]
                    )
                    await flowDynamic(
                        `✅ *Perímetro completado* — ${metodoTexto}, ${captura.vertices} vértices, área aproximada de *${Number(captura.area_ha).toFixed(2)} ha*.\n\n¡Listo, el territorio quedó completo! 🌿`
                    )
                    return
                }

                await state.update({
                    perimetro_metodo_capturado: metodoCapturado,
                    perimetro_geojson:          geojsonStr,
                    perimetro_puntos_gps:       puntosStr,
                    perimetro_area_ha:          captura.area_ha,
                    perimetro_vertices:         captura.vertices,
                })

                // A partir de aquí el camino se separa: si lo que se dibujó
                // fue una parcela familiar no hay que volver a preguntar por
                // la comunidad, el representante ni el título — todo eso ya
                // está guardado en el territorio del que cuelga.
                const esFamiliar = (state.getMyState()?.nivel_levantamiento) === 'Familiar'

                await flowDynamic(
                    `✅ *${esFamiliar ? 'Parcela registrada' : 'Perímetro registrado'}* — ${metodoTexto}, ${captura.vertices} vértices, área aproximada de *${Number(captura.area_ha).toFixed(2)} ha*.\n\n` +
                    (esFamiliar
                        ? 'Ya tenemos el lugar ubicado y medido 🙌 Ahora cuénteme de la familia que vive ahí.'
                        : 'Ya tenemos el territorio ubicado y medido 🙌 Ahora sí, cuénteme sobre su comunidad.')
                )
                return gotoFlow(esFamiliar ? moduloFamiliaFlow : modulo1Flow)
            } catch (err) {
                console.error('❌ Error consultando captura de perímetro:', err)
                return fallBack('Ocurrió un error verificando el envío. Por favor escriba *listo* de nuevo en un momento.')
            }
        }
    )

/* ======================================================
🟢 RETOMAR EL PERÍMETRO DE UN TERRITORIO YA REGISTRADO

   Para las comunidades que en el MÓDULO 4C eligieron guardar el
   territorio y dejar el croquis/recorrido GPS pendiente. Se
   identifica el territorio por el número/BSUID de WhatsApp de quien
   escribe — el mismo con el que se hizo el registro (whatsapp_id en
   tpc_predio) — así no hay que volver a preguntar ni buscar nada por
   nombre.

   Reutiliza la misma pantalla de captura (capturaPerimetroFlow); la
   diferencia la marca el estado `retomar_predio_id`: si viene lleno,
   el resultado se guarda con un UPDATE directo sobre ese predio en
   vez de seguir con el resto del registro (comunidad, representante,
   etc., que ya está guardado desde hace rato).
====================================================== */
/* ======================================================
✅ VALIDACIÓN COMUNITARIA DE LO LEVANTADO
======================================================

   El módulo 9 ya preguntaba por la validación, pero ahí la comunidad
   todavía no había visto el resultado: contestaba sobre datos que acababa
   de dictar, sin el lindero dibujado delante.

   Este flujo es el otro momento: cuando el levantamiento ya está armado,
   el visor les manda la imagen de lo que quedó capturado y esperan a que
   la revisen. La conversación empieza cuando escriben *validar*.

   Lo que se guarda por este canal es «Revisada_Autoridades» y no
   «Validada_Asamblea»: el sí llega de un teléfono, no de una reunión, y
   el modelo ya distinguía esas dos cosas.

   Requiere migrate_validacion_comunitaria.sql.
====================================================== */

const GEOVISOR_URL = process.env.GEOVISOR_URL
    || `http://localhost:${process.env.GEOVISOR_PORT || 3009}`

/* Las partes sobre las que se puede estar en desacuerdo. Se preguntan solo
   si dicen que hay algo que corregir: un rechazo que ya dice dónde está el
   problema le ahorra a quien corrige tener que volver a llamar. */
const PARTES_VALIDACION = [
    { n: '1', clave: 'lindero',  texto: 'El dibujo del lindero' },
    { n: '2', clave: 'area',     texto: 'La superficie en hectáreas' },
    { n: '3', clave: 'datos',    texto: 'Los datos de la comunidad y las autoridades' },
    { n: '4', clave: 'derechos', texto: 'Los derechos y los documentos' },
]

/* Busca la solicitud viva de ese número. Solo el teléfono al que se envió
   puede responder: si no, cualquiera a quien le reenvíen el mensaje podría
   aprobar el territorio de otra comunidad. */
const buscarSolicitudValidacion = async (telefono: string) => {
    if (!pgOnline) return null
    try {
        const { rows } = await pool.query(`
            SELECT s.id, s.token, s.comunidad_id, s.predio_id, s.huella_geometria,
                   s.area_ha_enviada, s.vence_en,
                   c.nombre_comunidad,
                   t.nombre_territorio,
                   ROUND((ST_Area(p.geom_perimetro::geography) / 10000)::numeric, 2) AS area_actual,
                   fn_huella_geometria(p.id) AS huella_actual
              FROM ext_solicitud_validacion s
              JOIN tpc_interesado_comunidad c ON c.id = s.comunidad_id
              LEFT JOIN tpc_predio p ON p.id = s.predio_id
              LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
             WHERE s.telefono_destino = $1
               AND s.estado = 'enviada'
             ORDER BY s.fecha_envio DESC
             LIMIT 1`, [telefono])
        return rows[0] ?? null
    } catch (err) {
        console.error('❌ Error buscando solicitud de validación:', (err as Error).message)
        return null
    }
}

/* Guarda la respuesta en las dos tablas: la solicitud queda cerrada y, si
   aprobaron, nace una validación vigente amarrada a la versión del lindero
   que vieron. Corre en una transacción para que no quede una sin la otra. */
const guardarRespuestaValidacion = async (opts: {
    solicitud: any
    aprobada: boolean
    secciones: Record<string, boolean> | null
    observacion: string
    audioUrl: string | null
    telefono: string
}) => {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        await client.query(`
            UPDATE ext_solicitud_validacion
               SET estado             = $2,
                   secciones          = $3,
                   respuesta_texto    = $4,
                   audio_url          = $5,
                   transcripcion      = $4,
                   telefono_respuesta = $6,
                   fecha_respuesta    = NOW()
             WHERE id = $1`,
            [opts.solicitud.id,
             opts.aprobada ? 'aprobada' : 'rechazada',
             opts.secciones ? JSON.stringify(opts.secciones) : null,
             opts.observacion || null,
             opts.audioUrl,
             opts.telefono])

        if (opts.aprobada) {
            // La validación anterior deja de ser la vigente: siempre hay una
            // sola vigente por comunidad, la última.
            await client.query(
                `UPDATE ext_validacion_comunitaria SET vigente = FALSE
                  WHERE comunidad_id = $1 AND vigente`,
                [opts.solicitud.comunidad_id])

            await client.query(`
                INSERT INTO ext_validacion_comunitaria
                    (comunidad_id, predio_id, validado_por_comunidad, observaciones_finales,
                     audio_observaciones_url, fecha_validacion, solicitud_id, huella_geometria,
                     origen, telefono_aprobacion, vigente)
                VALUES ($1, $2, 'Revisada_Autoridades', $3, $4, NOW(), $5, $6, 'whatsapp', $7, TRUE)`,
                [opts.solicitud.comunidad_id, opts.solicitud.predio_id,
                 opts.observacion || null, opts.audioUrl,
                 opts.solicitud.id, opts.solicitud.huella_geometria, opts.telefono])
        }

        await client.query('COMMIT')
        return true
    } catch (err) {
        await client.query('ROLLBACK')
        console.error('❌ Error guardando la respuesta de validación:', (err as Error).message)
        return false
    } finally {
        client.release()
    }
}

/* Recordatorio de lo que quedó sin responder. Mismo criterio que el del
   perímetro: nada antes de tres días, máximo tres veces, y se deja de
   insistir cuando vence el plazo. */
const recordarValidacionPendiente = async (provider: any) => {
    if (!pgOnline) return
    try {
        // Primero se cierran las que ya vencieron, para no seguir
        // molestando por algo que el visor ya da por no respondido.
        await pool.query(`
            UPDATE ext_solicitud_validacion
               SET estado = 'vencida'
             WHERE estado = 'enviada' AND vence_en IS NOT NULL AND vence_en < NOW()`)

        const { rows } = await pool.query(`
            SELECT s.id, s.telefono_destino, c.nombre_comunidad, t.nombre_territorio
              FROM ext_solicitud_validacion s
              JOIN tpc_interesado_comunidad c ON c.id = s.comunidad_id
              LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
             WHERE s.estado = 'enviada'
               AND s.telefono_destino IS NOT NULL
               AND COALESCE(s.recordatorios, 0) < 3
               AND (
                     (COALESCE(s.recordatorios, 0) = 0 AND s.fecha_envio     <= NOW() - INTERVAL '3 days')
                  OR (COALESCE(s.recordatorios, 0) > 0 AND s.recordatorio_en <= NOW() - INTERVAL '3 days')
               )`)

        for (const r of rows) {
            const nombre = r.nombre_territorio || r.nombre_comunidad
            const mensaje = [
                `👋 Hola de nuevo, le escribimos del Registro Territorial Comunitario.`,
                ``,
                `Le enviamos hace unos días la información del territorio *${nombre}* para que la revisaran.`,
                ``,
                `Cuando puedan, escriban *validar* en este chat para decirnos si están de acuerdo o si hay algo que corregir. Si necesitan más tiempo, no hay problema: aquí quedamos atentos.`,
            ].join('\n')

            try {
                await provider.sendMessage(r.telefono_destino, mensaje, {})
                await pool.query(
                    `UPDATE ext_solicitud_validacion
                        SET recordatorios = COALESCE(recordatorios, 0) + 1,
                            recordatorio_en = NOW()
                      WHERE id = $1`, [r.id])
                console.log(`⏰ Recordatorio de validación enviado a ${r.telefono_destino} ("${nombre}")`)
            } catch (err) {
                console.error(`❌ No se pudo enviar el recordatorio de validación a ${r.telefono_destino}:`, (err as Error).message)
            }
        }
    } catch (err: any) {
        // Sin la migración aplicada la tabla no existe; el bot sigue
        // funcionando igual, simplemente sin esta función.
        if (err?.code !== '42P01') {
            console.error('❌ Error revisando validaciones pendientes:', (err as Error).message)
        }
    }
}

/* ── Paso 3: la observación, cuando hay algo que corregir ── */
const validacionObservacionFlow = addKeyword<Provider, Database>(utils.setEvent('VALIDACION_OBSERVACION'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await flowDynamic([
                '📝 Cuéntenos qué hay que corregir.',
                '',
                'Puede escribirlo o mandarnos una nota de voz — como les quede más fácil.',
            ].join('\n'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic }) => {
            const st = state.getMyState?.() ?? {}
            const solicitud = st.val_solicitud

            /* Si mandan nota de voz se guarda el archivo además de la
               transcripción: en un proceso de reconocimiento territorial, la
               voz de quien objetó vale como respaldo y no solo el texto que
               produjo la máquina. */
            let texto = ''
            let audio: string | null = null

            if (esMensajeAudio(ctx)) {
                const url = obtenerUrlMedia(ctx)
                if (url) {
                    try {
                        audio = await guardarAudio(url, `validacion_obs_${ctx.from}`)
                        texto = (await transcribirAudio(audio)) || ''
                        if (texto) {
                            await flowDynamic(`🎙️ *Audio transcrito:*\n\n_"${texto}"_`)
                        } else {
                            await flowDynamic('🎙️ Recibimos su audio. No logramos transcribirlo, pero queda guardado tal cual para que el equipo lo escuche.')
                        }
                    } catch (err) {
                        console.warn('⚠️ No se pudo guardar el audio de la observación:', (err as Error).message)
                        await flowDynamic('Recibimos su audio pero no pudimos guardarlo. ¿Nos lo puede escribir?')
                    }
                }
            } else {
                texto = String(ctx.body ?? '').trim()
            }

            const secciones: Record<string, boolean> = {}
            for (const parte of PARTES_VALIDACION) {
                secciones[parte.clave] = !(st.val_partes ?? []).includes(parte.clave)
            }

            const ok = await guardarRespuestaValidacion({
                solicitud,
                aprobada:    false,
                secciones,
                observacion: texto.trim(),
                audioUrl:    audio,
                telefono:    ctx.from,
            })

            await flowDynamic(ok ? [
                '✅ Listo, quedó registrado.',
                '',
                'Lo que nos dijeron va directo al equipo que tiene el levantamiento, y les avisaremos cuando esté corregido para que lo revisen otra vez.',
                '',
                'Gracias por tomarse el tiempo de revisarlo 🙏',
            ].join('\n') : 'Recibimos su respuesta, pero tuvimos un problema al guardarla. Por favor escríbanos de nuevo en un rato.')
        }
    )

/* ── Paso 2: qué partes están mal ── */
const validacionPartesFlow = addKeyword<Provider, Database>(utils.setEvent('VALIDACION_PARTES'))
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic([
                '¿Qué parte es la que hay que corregir?',
                '',
                ...PARTES_VALIDACION.map(p => `${p.n}️⃣ ${p.texto}`),
                '',
                'Puede escribir varios números separados por coma. Por ejemplo: *1,3*',
            ].join('\n'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const marcados: string[] = String(ctx.body ?? '').match(/[1-4]/g) ?? []
            const partes = PARTES_VALIDACION
                .filter(p => marcados.includes(p.n))
                .map(p => p.clave)

            // Si no marcaron nada reconocible se sigue igual: lo que de
            // verdad importa es la observación, y no vale la pena trabar la
            // conversación por un número mal escrito.
            await state.update({ val_partes: partes })
            return gotoFlow(validacionObservacionFlow)
        }
    )

/* ── Paso 1: de acuerdo o no ── */
const validacionRespuestaFlow = addKeyword<Provider, Database>(utils.setEvent('VALIDACION_RESPUESTA'))
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, fallBack, gotoFlow }) => {
            const r = norm(String(ctx.body ?? ''))
            const st = state.getMyState?.() ?? {}
            const solicitud = st.val_solicitud

            if (!solicitud) {
                await flowDynamic('Se perdió el hilo de la conversación. Escriba *validar* otra vez, por favor.')
                return
            }

            const dijoSi = r === '1' || /^(si|sí|de acuerdo|correcto|apruebo|aprobado)/i.test(String(ctx.body ?? '').trim())
            const dijoNo = r === '2' || /^(no|corregir|mal|incorrecto)/i.test(String(ctx.body ?? '').trim())

            if (!dijoSi && !dijoNo) {
                return fallBack('Por favor responda con *1* si están de acuerdo, o con *2* si hay algo que corregir.')
            }

            if (dijoNo) return gotoFlow(validacionPartesFlow)

            const ok = await guardarRespuestaValidacion({
                solicitud,
                aprobada:    true,
                secciones:   Object.fromEntries(PARTES_VALIDACION.map(p => [p.clave, true])),
                observacion: '',
                audioUrl:    null,
                telefono:    ctx.from,
            })

            await flowDynamic(ok ? [
                '✅ ¡Gracias! Queda registrado que revisaron la información y están de acuerdo.',
                '',
                'Esto se anota como *revisión de las autoridades*. Si más adelante lo llevan a una asamblea y queda en acta, avísennos y lo registramos con ese respaldo, que es el más fuerte.',
                '',
                'Si algo cambia en el territorio, escríbannos cuando quieran 🌿',
            ].join('\n') : 'Recibimos su respuesta, pero tuvimos un problema al guardarla. Por favor escríbanos de nuevo en un rato.')
        }
    )

/* ── Entrada: la palabra *validar* ── */
const validacionFlow = addKeyword<Provider, Database>(
    ['validar', 'validacion', 'validación', 'aprobar', 'revisar informacion', 'revisar información']
)
    .addAction(
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const solicitud = await buscarSolicitudValidacion(ctx.from)

            if (!solicitud) {
                await flowDynamic([
                    '🙂 Ahora mismo no tenemos nada pendiente de que ustedes revisen.',
                    '',
                    'Cuando el levantamiento de su territorio esté armado, les mandamos por aquí la imagen de cómo quedó y les pedimos que lo revisen.',
                    '',
                    'Si quiere iniciar un registro nuevo, escriba *hola*.',
                ].join('\n'))
                return
            }

            // Si el lindero cambió después de enviarles la imagen, lo que
            // tienen en el teléfono ya no es lo que hay guardado. Aprobar eso
            // sería aprobar algo que nunca vieron.
            if (solicitud.huella_actual !== solicitud.huella_geometria) {
                await pool.query(
                    `UPDATE ext_solicitud_validacion SET estado = 'caduca' WHERE id = $1`,
                    [solicitud.id])
                await flowDynamic([
                    '⚠️ El lindero de su territorio cambió después de que les enviamos la imagen.',
                    '',
                    'Para no pedirles que aprueben algo distinto de lo que vieron, vamos a enviarles la versión actualizada. Les escribimos apenas esté lista.',
                ].join('\n'))
                return
            }

            await state.update({ val_solicitud: solicitud, val_partes: [] })

            const nombre = solicitud.nombre_territorio || solicitud.nombre_comunidad

            // Se les vuelve a mandar la imagen: la conversación puede
            // retomarse días después, con el mensaje original ya perdido
            // entre otros chats.
            try {
                await flowDynamic([{ media: `${GEOVISOR_URL}/api/validacion/img/${solicitud.token}` }])
            } catch (err) {
                console.warn('⚠️ No se pudo reenviar la imagen de validación:', (err as Error).message)
            }

            await flowDynamic([
                `Esta es la información del territorio *${nombre}* tal como quedó registrada.`,
                ``,
                `📐 ${solicitud.area_actual != null ? Number(solicitud.area_actual).toLocaleString('es-CO') + ' hectáreas medidas' : 'superficie sin medir'}`,
                ``,
                `Revisen el dibujo del lindero y los datos de la imagen.`,
                ``,
                `*¿Están de acuerdo con lo que aparece ahí?*`,
                ``,
                `1️⃣ Sí, estamos de acuerdo`,
                `2️⃣ Hay algo que corregir`,
            ].join('\n'))

            return gotoFlow(validacionRespuestaFlow)
        }
    )

const retomarPerimetroFlow = addKeyword<Provider, Database>(['perimetro', 'perímetro', 'completar perimetro', 'completar territorio'])
    .addAction(
        // No se usa endFlow aquí (aunque es justo el caso para el que
        // existe): la regla de eslint-plugin-builderbot que revisa sus
        // llamadas se rompe con la versión de ESLint de este proyecto
        // (`context.getAncestors is not a function`, API retirada en
        // ESLint 9) y tumba "npm run dev" completo antes de arrancar el
        // bot. Terminar el flujo sin encadenar a otro (solo flowDynamic +
        // return, sin gotoFlow) logra lo mismo: la conversación se queda
        // esperando el siguiente mensaje.
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            let predio: any = null
            try {
                const { rows } = await pool.query(
                    `SELECT p.id AS predio_id, c.nombre_comunidad, t.nombre_territorio
                     FROM tpc_predio p
                     JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
                     LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
                     WHERE p.whatsapp_id = $1
                       AND p.nivel_tenencia = 'Colectivo'
                       AND p.geom_perimetro IS NULL
                     ORDER BY p.id DESC
                     LIMIT 1`,
                    [ctx.from]
                )
                predio = rows[0] ?? null
            } catch (err) {
                console.error('❌ Error buscando territorio pendiente de perímetro:', (err as Error).message)
                await flowDynamic('No pude consultar la información en este momento. Por favor intente de nuevo en un rato.')
                return
            }

            if (!predio) {
                await flowDynamic(
                    [
                        '🙂 No encuentro ningún territorio suyo con el perímetro pendiente.',
                        '',
                        'Si ya lo completaron antes, no hay nada más que hacer. Si es la primera vez que escribe, mande *hola* para iniciar un registro nuevo.',
                    ].join('\n')
                )
                return
            }

            await state.update({
                retomar_predio_id: predio.predio_id,
                // Reutiliza exactamente el mismo texto/opciones del MÓDULO 4C
                // que se usan para el territorio colectivo.
                nivel_levantamiento: 'Colectivo',
            })
            await flowDynamic(
                `📐 Vamos a completar el perímetro de *${predio.nombre_territorio || predio.nombre_comunidad}*.`
            )
            return gotoFlow(capturaPerimetroFlow)
        }
    )

const modulo4Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_4'))
    // Q1: nombre del territorio
    //
    // En LADM el nombre de la comunidad y el del territorio son cosas
    // distintas: el primero identifica al interesado que tiene el derecho,
    // el segundo a la unidad sobre la que recae. Pero en Colombia casi
    // siempre coinciden — «Resguardo Indígena de Cañamomo» es a la vez las
    // dos cosas — y antes la pregunta llegaba sin contexto, así que parecía
    // que se estaba preguntando lo mismo dos veces.
    //
    // Ahora se recuerda lo que ya se anotó y se pregunta solo por la
    // diferencia, con la opción de decir que es el mismo nombre.
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 4 nombre territorio.mp3',
                [
                    'Gracias por compartir esa historia 🙏 Ahora sigamos con los datos formales del territorio.',
                    '',
                    `📛 Ya anoté la comunidad como *${st.nombre_comunidad ?? 'su comunidad'}*.`,
                    '',
                    '*¿El territorio tiene un nombre oficial distinto?* — el que aparece en la resolución, el acuerdo o el título.',
                    '',
                    '_Si es el mismo, responda *el mismo*._',
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            const texto = await obtenerTextoRespuesta(ctx, state, 'nombre_territorio', flowDynamic)
            const limpio = sinTildes(texto)

            // «el mismo», «es igual», «lo mismo», «igual que la comunidad»…
            const heredaNombre = /\b(el mismo|la misma|lo mismo|es igual|igual|mismo nombre|el de la comunidad)\b/.test(limpio)

            if (heredaNombre && st.nombre_comunidad) {
                await state.update({ nombre_territorio: st.nombre_comunidad })
                await flowDynamic(`👌 Entonces el territorio también se llama *${st.nombre_comunidad}*.`)
                return
            }

            if (texto.trim().length < 2) {
                return fallBack('Dígame el nombre oficial del territorio, o responda *el mismo* si coincide con el de la comunidad.')
            }
            await state.update({ nombre_territorio: texto.trim() })
        }
    )
    // La pregunta por el nombre del predio en documentos oficiales se movió
    // al módulo 7, justo después de saber si existe algún documento. Aquí
    // llegaba antes de preguntar eso, así que a la mayoría se le pedía el
    // nombre que figura en un papel que no tienen, y casi siempre
    // respondían «sin nombre».
    //
    // Q2: número predial (cédula catastral)
    //
    // Es el identificador que amarra este registro con el catastro
    // oficial. La columna estaba declarada desde el principio y nunca se
    // preguntaba. Muy pocas comunidades lo tienen a mano, por eso es
    // opcional y se sigue de largo si dicen que no.
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    '🔢 *¿Conoce el número predial o cédula catastral del predio?*',
                    '',
                    'Es un código largo que aparece en el recibo del impuesto predial o en documentos del IGAC.',
                    '',
                    'Si no lo tiene, responda _no_.',
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic }) => {
            const bruto  = await obtenerTextoRespuesta(ctx, state, 'numero_predial', flowDynamic)
            const limpio = (extraerNumero(bruto) ?? bruto).trim()
            await state.update({
                numero_predial: (sinDatoQueDar(bruto) || limpio.length < 5) ? null : limpio,
            })
        }
    )
    // Q3: área
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 4 area.mp3',
                '📐 *¿Conoce el área aproximada del territorio en hectáreas?*\n\nSolo el número. Ejemplo: _1250_\nSi no sabe, escriba _desconocida_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const bruto = await obtenerTextoRespuesta(ctx, state, 'area_acto_administrativo', flowDynamic)
            const v = bruto.trim().toLowerCase()
            const noSabe = ['desconocida', 'desconocido', 'no sé', 'no se', 'no sabemos'].includes(v)
            const numero = extraerNumero(bruto)
            if (!noSabe && !numero)
                return fallBack('Dígame el área en hectáreas (solo el número) o diga _desconocida_.\nEjemplo: _1250_')
            await state.update({ area_acto_administrativo: noSabe ? bruto.trim() : numero })
        }
    )
    // Q4: tipo de procedimiento
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 4 procedimiento.mp3',
                [
                    '⚖️ *¿Cuál fue el tipo de procedimiento de reconocimiento del territorio?*',
                    '',
                    '1️⃣ Ampliación de resguardo indígena',
                    '2️⃣ Ampliación y saneamiento de resguardo',
                    '3️⃣ Reestructuración de resguardo',
                    '4️⃣ Conversión de reserva en resguardo',
                    '5️⃣ Titulación de comunidades negras',
                    '6️⃣ En proceso / aún no reconocido',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'tipo_procedimiento', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ tipo_procedimiento: d.valor })
        }
    )
    // Q5: límites
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 4 limites.mp3',
                [
                    '🗺️ *¿Cómo describe su comunidad los límites del territorio?*',
                    '',
                    '1️⃣ Ríos y quebradas',
                    '2️⃣ Montañas y cerros',
                    '3️⃣ Caminos y senderos',
                    '4️⃣ Hitos naturales (árboles, piedras, etc.)',
                    '5️⃣ Documentos oficiales',
                    '6️⃣ Combinación de los anteriores',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'limites_territorio', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ limites_territorio: d.valor })
        }
    )
    // 📷 Foto opcional — limites_territorio
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Si tiene una foto de un lindero — el río, la montaña, el árbol o la piedra que marca el borde — puede enviarla.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'limites_territorio')
            if (aviso) await flowDynamic(aviso)
        }
    )

    // Aquí había dos preguntas que se retiraron:
    //
    //   «¿El territorio ha sido reconocido oficialmente por el Estado?»
    //      La contesta sola el módulo 7: si hay un acto administrativo con
    //      número y fecha, el territorio está reconocido. Preguntarla
    //      además permitía que alguien respondiera «No está reconocido» y
    //      tres preguntas después dictara la resolución que lo reconoce, y
    //      las dos respuestas contradictorias quedaban guardadas. Ahora se
    //      deriva en saveToDatabase.
    //
    //   «¿Existen zonas especiales dentro del territorio?»
    //      Era un Sí/No sin seguimiento: si respondían que sí, no se
    //      preguntaba cuáles ni dónde. La foto que venía después captura
    //      más que ese sí, así que se conservó y la pregunta se fue.
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Si hay un sitio sagrado, de conservación o de importancia cultural que quiera dejar registrado, puede enviar una foto y contarme de qué se trata.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'zonas_especiales')
            if (aviso) await flowDynamic(aviso)
            return gotoFlow(modulo5Flow)
        }
    )

/* ======================================================
🟢 MÓDULO 5 – DERECHO Y RESTRICCIONES
====================================================== */
const modulo5Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_5'))
    // Q1: tipo de derecho
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 5 derecho.mp3',
                [
                    'Ya casi terminamos la parte del territorio. Ahora unas preguntas sobre los derechos y posibles restricciones que existan sobre él — esto es clave para el reconocimiento legal.',
                    '',
                    '🏛️ *¿Qué tipo de derecho tiene la comunidad sobre el territorio?*',
                    '',
                    '1️⃣ Propiedad colectiva reconocida',
                    '2️⃣ Posesión ancestral sin título formal',
                    '3️⃣ Uso y usufructo del territorio',
                    '4️⃣ En proceso de legalización',
                    '5️⃣ Desconocemos el tipo de derecho',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'tipo_derecho', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ tipo_derecho: d.valor })
        }
    )
    // Q2: restricciones
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 5 restriccion.mp3',
                [
                    '🚧 *¿Existen restricciones o servidumbres sobre el territorio?*',
                    '',
                    '1️⃣ Actividad minera',
                    '2️⃣ Oleoducto o gasoducto',
                    '3️⃣ Línea de energía eléctrica',
                    '4️⃣ Acueducto o alcantarillado',
                    '5️⃣ Restricción legal por hidrocarburos',
                    '6️⃣ No hay restricciones',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'restriccion_territorio', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ restriccion_territorio: d.valor })
        }
    )
    // 📷 Foto opcional — restriccion
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Si hay una mina, torre, tubería u obra que afecte el territorio, una foto sirve como evidencia.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'restriccion')
            if (aviso) await flowDynamic(aviso)
            return gotoFlow(modulo6Flow)
        }
    )

/* ======================================================
🟢 MÓDULO 6 – USO DEL TERRITORIO
====================================================== */
const modulo6Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_6'))
    // Q1: uso del territorio
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 6 uso.mp3',
                [
                    'Ahora cuénteme cómo la comunidad usa y cuida el territorio en el día a día.',
                    '',
                    '🏕️ *¿Cuál es el uso principal que le da la comunidad al territorio?*',
                    '',
                    '1️⃣ Uso colectivo comunitario',
                    '2️⃣ Uso tradicional y cultural',
                    '3️⃣ Zonas compartidas con otras comunidades',
                    '4️⃣ Uso mixto (colectivo y familiar)',
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'uso_territorio', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ uso_territorio: d.valor })
        }
    )
    // Q2: reglas internas
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 6 reglas.mp3',
                [
                    '📜 *¿La comunidad tiene reglas o normas internas sobre el uso del territorio?*',
                    '_(Acuerdos comunitarios, normas ancestrales, reglamentos, etc.)_',
                    '',
                    '1️⃣ ✅ Sí, tenemos reglas',
                    '2️⃣ ❌ No tenemos formalmente',
                ].join('\n'),
                ['✅ Sí, tenemos reglas', '❌ No tenemos formalmente']
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, fallBack, flowDynamic }) => {
            // Antes, si no se reconocía la respuesta se guardaba un valor
            // por defecto en silencio — quedaba un dato equivocado sin que
            // nadie se enterara. Ahora se vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'reglas_internas', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ reglas_internas: d.valor })
            return gotoFlow(modulo7Flow)
        }
    )

/* ======================================================
🟢 MÓDULO 7 – DOCUMENTOS LEGALES
====================================================== */
const modulo7Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_7'))
    // Q1: tipo acto administrativo
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 7 acto.mp3',
                [
                    'Vamos con los documentos oficiales del territorio, si es que existen — no se preocupe si todavía no los tienen, eso también es información válida.',
                    '',
                    '📑 *¿Existe algún documento oficial que reconozca el territorio?*',
                    '',
                    // La lista se arma desde las opciones reales. Estaba
                    // escrita a mano y se quedó con cuatro cuando ya había
                    // seis: quien respondía «3» creía estar diciendo folio de
                    // matrícula y se guardaba decreto.
                    ...OPCIONES_PREGUNTA.tipo_acto_administrativo.map((o, i) => `${i + 1}️⃣ ${o.etiqueta}`),
                ].join('\n')
            )
        }
    )
        .addAction(
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow, flowDynamic }) => {
            // Acepta el número, la opción dicha con palabras, o una nota
            // de voz. Si hay duda, confirma; si no entiende, vuelve a preguntar.
            const d = await resolverOpcion(ctx, state, 'tipo_acto_administrativo', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ tipo_acto_administrativo: d.valor })

            // Si acaban de decir que no existe ningún documento, no tiene
            // sentido pedirles el número, la fecha ni el nombre que figura
            // en él. Se salta directo a la foto y a la cartografía.
            if (d.valor === 'Sin_Documento') {
                await state.update({
                    numero_acto_administrativo: null,
                    fecha_acto_administrativo:  null,
                    nombre_predio:              null,
                })
                await flowDynamic('Entendido, sin documento oficial por ahora. Eso también queda registrado.')
                return gotoFlow(modulo7SinDocFlow)
            }
        }
    )
    // Q2: número del acto
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 7 numero acto.mp3',
                '🔢 *¿Cuál es el número del acto administrativo?*\n\nSi no lo sabe, escriba _desconocido_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'numero_acto_administrativo', flowDynamic)
            if (texto.trim().length < 1) return fallBack('Por favor dígame el número del acto, o _desconocido_.')
            await state.update({ numero_acto_administrativo: texto.trim() })
        }
    )
    // Q3: fecha del acto
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 7 fecha acto.mp3',
                '📅 *¿Cuál es la fecha del acto administrativo?*\n\nFormato: _dd/mm/aaaa_ — Ejemplo: _15/03/2005_\nSi no la sabe, escriba _desconocida_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, gotoFlow, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'fecha_acto_administrativo', flowDynamic)
            if (!esFechaValida(texto))
                return fallBack('Por favor dígame la fecha en formato *dd/mm/aaaa* (Ejemplo: _15/03/2005_)\no diga _desconocida_ si no la conoce.')
            await state.update({ fecha_acto_administrativo: texto.trim() })
        }
    )
    // Q4: nombre del predio en ese documento
    //
    // Esta pregunta vivía en el módulo 4, antes de saber si existía algún
    // documento, así que se le pedía a todo el mundo el nombre que figura
    // en un papel que la mayoría no tiene — y casi siempre respondían «sin
    // nombre». Aquí ya sabemos que el documento existe, así que la pregunta
    // tiene sentido.
    //
    // En LADM el predio se identifica por su número predial, no por un
    // nombre; este campo es una comodidad, por eso es opcional.
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            const doc = String(st.tipo_acto_administrativo ?? '').replace(/_/g, ' ').toLowerCase()
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 4 predio.mp3',
                `📄 *¿En ${doc === 'folio matricula' ? 'ese folio' : `esa ${doc}`} el predio aparece con algún nombre?*\n\nSi no figura ninguno, responda _no_.`
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'nombre_predio', flowDynamic)
            const limpio = texto.trim()
            await state.update({
                nombre_predio: (sinDatoQueDar(limpio) || limpio.length < 2) ? null : limpio,
            })
        }
    )
    // 📷 Foto opcional — documento legal
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Puede fotografiar el documento — la resolución, el acuerdo o el folio de matrícula.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'documento_legal')
            if (aviso) await flowDynamic(aviso)
            return gotoFlow(modulo8Flow)
        }
    )

/* ======================================================
🟢 MÓDULO 7B – CUANDO NO HAY DOCUMENTO OFICIAL

   Rama corta para las comunidades que todavía no tienen título. Se les
   ofrece igual fotografiar lo que tengan — un acta de asamblea, una
   solicitud radicada, un documento antiguo — porque aunque no sea un acto
   administrativo, es lo que sostiene su reclamación.
====================================================== */
const modulo7SinDocFlow = addKeyword<Provider, Database>(utils.setEvent('MODULO_7_SIN_DOC'))
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Si tienen cualquier documento del territorio, aunque no sea oficial — un acta de asamblea, una solicitud radicada, un papel antiguo —, puede fotografiarlo.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'documento_legal')
            if (aviso) await flowDynamic(aviso)
            return gotoFlow(modulo8Flow)
        }
    )

/* ======================================================
🟢 MÓDULO 8 – FUENTE ESPACIAL / CARTOGRAFÍA
====================================================== */
const modulo8Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_8'))
    // Q1: tipo mapa
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 8 mapa.mp3',
                [
                    '🗺️ Una última pregunta sobre cartografía: *¿la comunidad cuenta con algún mapa o plano del territorio?*',
                    '',
                    '1️⃣ 🏛️ Sí, plano oficial (IGAC u otra entidad)',
                    '2️⃣ ✍️ Sí, mapa comunitario propio',
                    '3️⃣ ❌ No tenemos mapa',
                ].join('\n'),
                ['🏛️ Plano oficial', '✍️ Mapa comunitario', '❌ No tenemos mapa']
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'tipo_fuente_espacial', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ tipo_fuente_espacial: d.valor })
        }
    )
    // 📷 Foto opcional — plano_mapa
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Si tienen el plano o el mapa del territorio a la mano, una foto de ese documento es muy valiosa.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'plano_mapa')
            if (aviso) await flowDynamic(aviso)
        }
    )
    // Q2: número de plano
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 8 plano.mp3',
                '🔢 *¿Tiene número de plano o referencia cartográfica?*\n\nSi no aplica, escriba _no aplica_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'numero_plano', flowDynamic)
            await state.update({ numero_plano: texto.trim() || 'no aplica' })
            return gotoFlow(modulo9Flow)
        }
    )

/* ======================================================
🟢 MÓDULO F – LA FAMILIA QUE OCUPA LA PARCELA

   Solo se recorre cuando el levantamiento es familiar. No repite nada del
   territorio: la comunidad, el representante, el título y la historia ya
   quedaron guardados cuando se registró la propiedad colectiva.

   Aquí es donde el censo deja de ser una estimación. Arriba, la autoridad
   dice cuántas personas cree que viven en el territorio; aquí cada hogar
   dice cuántas son en su casa, y la suma se puede comparar con esa
   estimación — el mismo contraste entre lo declarado y lo medido que ya
   existe entre el área del documento y el área del polígono.
====================================================== */
const moduloFamiliaFlow = addKeyword<Provider, Database>(utils.setEvent('MODULO_FAMILIA'))
    // Q1: jefe o jefa del hogar
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    `👨‍👩‍👧 Ahora los datos de la familia que ocupa este lugar dentro de *${st.nombre_territorio_padre ?? 'el territorio'}*.`,
                    '',
                    '👤 *¿Cuál es el nombre completo del jefe o la jefa del hogar?*',
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'jefe_hogar', flowDynamic)
            if (texto.trim().length < 3) return fallBack('Dígame el nombre completo de quien encabeza el hogar.')
            const nombre = texto.trim()
            // El apellido sirve para nombrar la familia sin preguntarlo aparte.
            const partes = nombre.split(/\s+/)
            const apellidos = partes.length >= 3 ? partes.slice(-2).join(' ') : partes.slice(-1).join(' ')
            await state.update({
                jefe_hogar: nombre,
                nombre_familia: `Familia ${apellidos}`,
            })
        }
    )
    // Q2: tipo de documento
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    '🪪 *¿Qué tipo de documento tiene?*',
                    '',
                    ...OPCIONES_PREGUNTA.tipo_documento.map((o, i) => `${i + 1}️⃣ ${o.etiqueta}`),
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'tipo_documento', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ tipo_documento_familia: d.valor })
        }
    )
    // Q3: número de documento
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                '🔢 *¿Cuál es el número de documento?*\n\nSi prefiere no darlo, escriba _no_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic }) => {
            const bruto = await obtenerTextoRespuesta(ctx, state, 'numero_documento_familia', flowDynamic)
            const v = (extraerNumero(bruto) ?? bruto).trim()
            await state.update({
                numero_documento_familia: (sinDatoQueDar(bruto) || v.length < 4) ? null : v,
            })
        }
    )
    // Q4: cuántas personas viven en la casa
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                '👥 *¿Cuántas personas viven en esta casa?*\n\nContando a todos, grandes y chicos. Escriba solo el número.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const bruto = await obtenerTextoRespuesta(ctx, state, 'personas_familia', flowDynamic)
            const n = parseInt(extraerNumero(bruto) ?? '', 10)
            if (!Number.isFinite(n) || n < 1 || n > 60) {
                return fallBack('¿Cuántas personas viven en la casa? Dígame solo el número — por ejemplo *5*.')
            }
            await state.update({ personas_familia: n })
        }
    )
    // Q5: cuántas mujeres
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            await enviarPregunta(
                flowDynamic, state,
                '',
                `👩 *De esas ${st.personas_familia ?? ''} personas, ¿cuántas son mujeres?*`
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            const bruto = await obtenerTextoRespuesta(ctx, state, 'mujeres_familia', flowDynamic)
            const n = parseInt(extraerNumero(bruto) ?? '', 10)
            if (!Number.isFinite(n) || n < 0) {
                return fallBack('Dígame solo el número de mujeres — por ejemplo *3*.')
            }
            // Antes, a nivel comunidad, nada impedía que mujeres y hombres
            // sumaran más que el total. Aquí sí se comprueba, y de paso se
            // deduce el número de hombres para no preguntarlo dos veces.
            if (n > st.personas_familia) {
                return fallBack(`Dijo que en la casa viven ${st.personas_familia} personas, así que no pueden ser ${n} mujeres. ¿Cuántas son?`)
            }
            await state.update({
                mujeres_familia: n,
                hombres_familia: st.personas_familia - n,
            })
            await flowDynamic(`Entonces son *${n}* mujeres y *${st.personas_familia - n}* hombres. Si no es así, dígamelo y lo corrijo.`)
        }
    )
    // Q6: desde cuándo vive ahí
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    '📅 *¿Desde cuándo vive la familia en este lugar?*',
                    '',
                    ...OPCIONES_PREGUNTA.antiguedad_territorio.map((o, i) => `${i + 1}️⃣ ${o.etiqueta}`),
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'antiguedad_territorio', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ antiguedad_ocupacion: d.valor })
        }
    )
    // Q7: cómo llegaron a ocupar el lugar
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    '🤝 *¿Cómo llegó la familia a ocupar este lugar?*',
                    '',
                    ...OPCIONES_PREGUNTA.origen_asignacion.map((o, i) => `${i + 1}️⃣ ${o.etiqueta}`),
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'origen_asignacion', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ origen_asignacion: d.valor })
        }
    )
    // Q8: uso de la parcela
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                '',
                [
                    '🌱 *¿Para qué usa la familia este lugar?*',
                    '',
                    ...OPCIONES_PREGUNTA.uso_parcela.map((o, i) => `${i + 1}️⃣ ${o.etiqueta}`),
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'uso_parcela', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ uso_parcela: d.valor })
        }
    )
    // 📷 Foto opcional de la parcela
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Si quiere, puede enviar una foto de la casa o del lugar.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'territorio')
            if (aviso) await flowDynamic(aviso)
            return gotoFlow(cierreFamiliaFlow)
        }
    )

/* ======================================================
🟢 CIERRE DEL LEVANTAMIENTO FAMILIAR

   Guarda y ofrece encadenar la siguiente familia sin repetir la búsqueda
   del territorio: en una jornada de campo se levantan varios hogares
   seguidos, y volver a escribir el nombre del resguardo cada vez sería
   una fricción innecesaria.
====================================================== */
const cierreFamiliaFlow = addKeyword<Provider, Database>(utils.setEvent('CIERRE_FAMILIA'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            const st = state.getMyState() ?? {}
            try {
                const familiaId = await saveFamiliaToDatabase(st)
                console.log(`✅ Familia guardada (id ${familiaId}) en el territorio ${st.predio_matriz_id}`)

                // Cuántos hogares van y cuánta gente suman, para que quien
                // levanta sepa en qué va sin salir de WhatsApp.
                let resumen = ''
                try {
                    const { rows } = await pool.query(
                        `SELECT familias_registradas, personas_registradas, personas_declaradas
                         FROM vista_censo_comunidad WHERE comunidad_id = $1`,
                        [st.comunidad_id_padre]
                    )
                    if (rows.length) {
                        const r = rows[0]
                        resumen = `\n\n📊 Van *${r.familias_registradas}* familias registradas en este territorio, con *${r.personas_registradas}* personas en total` +
                            (r.personas_declaradas ? ` — la autoridad había estimado ${r.personas_declaradas}.` : '.')
                    }
                } catch { /* el resumen es un extra; si falla no pasa nada */ }

                await flowDynamic(
                    `✅ *Listo, quedó registrada la ${st.nombre_familia ?? 'familia'}.*${resumen}`
                )
            } catch (err) {
                console.error('❌ Error guardando la familia:', err)
                await flowDynamic(
                    '😔 No pude guardar los datos de la familia en este momento.\n\n' +
                    'Escriba *hola* para intentarlo de nuevo — no se perdió nada del territorio.'
                )
                return
            }

            await flowDynamic(
                [
                    '¿Registramos otra familia del mismo territorio?',
                    '',
                    '1️⃣ Sí, sigo con otra familia',
                    '2️⃣ No, terminé por ahora',
                ].join('\n')
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'otra_familia', flowDynamic)

            if (esAfirmacion(texto) || extraerNumeroOpcion(sinTildes(texto)) === 1) {
                const st = state.getMyState() ?? {}
                // Se conserva solo lo del territorio y las preferencias; todo
                // lo de la familia anterior se limpia para que no se filtre
                // en el siguiente hogar.
                await state.clear()
                await state.update({
                    nivel_levantamiento:     'Familiar',
                    comunidad_id_padre:      st.comunidad_id_padre,
                    predio_matriz_id:        st.predio_matriz_id,
                    nombre_territorio_padre: st.nombre_territorio_padre,
                    departamento:            st.departamento,
                    municipio:               st.municipio,
                    vereda:                  st.vereda,
                    corregimiento:           st.corregimiento,
                    audioEnabled:            st.audioEnabled,
                    consentimiento:          st.consentimiento,
                })
                await flowDynamic('👌 Sigamos con la siguiente familia. Primero ubiquemos su parcela.')
                return gotoFlow(ubicacionFlow)
            }

            await flowDynamic(
                [
                    '🙏 Gracias por el trabajo de hoy.',
                    '',
                    'Cuando quiera registrar otra familia u otro territorio, escríbame *hola*.',
                ].join('\n')
            )
        }
    )

/* ======================================================
🟢 MÓDULO 9 – VALIDACIÓN COMUNITARIA
====================================================== */
const audioValidacionFlow = addKeyword<Provider, Database>(utils.setEvent('AUDIO_VALIDACION'))
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 9 audio final.mp3',
                '🎤 Adelante, envíe su mensaje de voz con las observaciones finales de la comunidad.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic, gotoFlow }) => {
            const audioUrl = obtenerUrlAudio(ctx)
            if (audioUrl) {
                try {
                    const filepath = await guardarAudio(audioUrl, `validacion_${ctx.from}`)
                    await state.update({ audio_validacion_url: filepath })
                    await flowDynamic('⏳ Audio de validación recibido. Transcribiendo...')
                    const transcripcion = await transcribirAudio(filepath)
                    if (transcripcion) {
                        await state.update({ transcripcion_validacion: transcripcion })
                        await flowDynamic(`✅ ¡Audio transcrito! _"${transcripcion.slice(0, 150)}${transcripcion.length > 150 ? '...' : ''}"`)
                    } else {
                        await flowDynamic('✅ Audio de validación recibido. ¡Muchas gracias por compartirlo!')
                    }
                } catch {
                    await flowDynamic('No pudimos guardar el audio, pero continuamos con las observaciones escritas.')
                }
            } else {
                await flowDynamic('No detectamos un mensaje de voz. Continuamos con lo registrado.')
            }
            return gotoFlow(cierreFlow)
        }
    )

const modulo9Flow = addKeyword<Provider, Database>(utils.setEvent('MODULO_9'))
    // Q1: tipo de validación
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 9 validacion.mp3',
                [
                    'Ya estamos en la recta final 🙌 Estas últimas preguntas son sobre la validación comunitaria — garantizan que todo lo registrado sea legítimo y reconocido por su comunidad.',
                    '',
                    '✅ *¿La información registrada fue revisada y aprobada por su comunidad?*',
                    '',
                    '1️⃣ 🏛️ Sí, validada en asamblea comunitaria',
                    '2️⃣ 👥 Revisada por las autoridades',
                    '3️⃣ ⏳ Aún no ha sido validada',
                ].join('\n'),
                ['🏛️ En asamblea', '👥 Por autoridades', '⏳ Pendiente']
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic }) => {
            const d = await resolverOpcion(ctx, state, 'validacion', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            await state.update({ validacion: d.valor })
        }
    )
    // 📷 Foto opcional — comunidad_reunida
    .addAction(
        async (ctx, { flowDynamic }) => {
            await flowDynamic(textoPedirFoto('Si tiene una foto de la asamblea o de las autoridades reunidas, queda como respaldo del proceso.'))
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic }) => {
            const aviso = await procesarFotoOpcional(ctx, state, 'comunidad_reunida')
            if (aviso) await flowDynamic(aviso)
        }
    )
    // Q2: observaciones finales
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 9 observaciones.mp3',
                '📝 *¿Desea agregar alguna observación, comentario o aclaración final?*\n\nSi no tiene observaciones, escriba _ninguna_.'
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, flowDynamic }) => {
            const texto = await obtenerTextoRespuesta(ctx, state, 'observaciones_finales', flowDynamic)
            await state.update({ observaciones_finales: texto.trim() || 'Ninguna' })
        }
    )
    // Q3: audio de observaciones
    .addAction(
        async (ctx, { state, flowDynamic }) => {
            await enviarPregunta(
                flowDynamic, state,
                'Modulo 9 audio final.mp3',
                '🎙️ *¿Desea enviar un mensaje de voz con observaciones o palabras finales de la comunidad?*',
                ['🎤 Sí, envío mensaje de voz', '✅ No, ya terminé']
            )
        }
    )
    .addAction(
        { capture: true },
        async (ctx, { state, gotoFlow, fallBack, flowDynamic }) => {
            // Antes bastaba con que la respuesta contuviera "si" en cualquier
            // parte — "sin más", "siga" o "gracias" mandaban a grabar audio.
            const d = await resolverOpcion(ctx, state, 'quiere_audio_final', flowDynamic)
            if (d.accion === 'esperar') return fallBack(d.mensaje)
            if (d.valor === 'si') {
                return gotoFlow(audioValidacionFlow)
            }
            return gotoFlow(cierreFlow)
        }
    )

/* ======================================================
🟢 CIERRE – GUARDAR CON VERIFICACIÓN Y MODO OFFLINE
====================================================== */
const cierreFlow = addKeyword<Provider, Database>(utils.setEvent('CIERRE'))
    .addAnswer(
        '⏳ Guardando su información de forma segura. Un momento por favor...',
        null,
        async (ctx, { state, flowDynamic }) => {
            try {
                const allState = state.getMyState()
                const { id, offline, verificado } = await saveToDatabaseSafe(allState)

                if (offline) {
                    await flowDynamic(
                        [
                            `📦 *Información guardada en modo offline.*`,
                            ``,
                            `ID temporal: *${id}*`,
                            ``,
                            `⚠️ No hay conexión con el servidor principal en este momento.`,
                            `Su información quedó guardada de forma segura y se sincronizará automáticamente cuando se restablezca la conexión.`,
                            ``,
                            `🌿 Gracias por su confianza y por participar en este proceso de reconocimiento territorial.`,
                        ].join('\n')
                    )
                } else {
                    const s = allState
                    await flowDynamic(
                        [
                            `✅ *¡Registro completado exitosamente!*`,
                            ``,
                            `📌 ID de registro: *${id}*`,
                            `🏡 Comunidad: *${s.nombre_comunidad ?? 'N/A'}*`,
                            `🗺️ Departamento: *${s.departamento ?? 'No registrado'}*`,
                            `🏙️ Municipio: *${s.municipio ?? 'No registrado'}*`,
                            verificado ? `✔️ Verificado en base de datos` : '',
                            (s.nivel_levantamiento !== 'Familiar' && s.perimetro_diferido)
                                ? `\n📐 *Falta un paso:* el croquis o recorrido GPS del lindero quedó pendiente. Escriban *perímetro* cuando estén listos — si se demoran, yo les recuerdo.`
                                : '',
                            ``,
                            `🌿 *Gracias por participar en este proceso.*`,
                            `Su información contribuye al reconocimiento oficial de los derechos territoriales de su comunidad.`,
                            ``,
                            `_Si necesita hacer alguna corrección, contáctenos con su ID de registro._`,
                        ].filter(Boolean).join('\n')
                    )
                    // Enviar audio de cierre si está habilitado
                    const st = state.getMyState()
                    if (st?.audioEnabled) {
                        await flowDynamic([{
                            body: '🎧 Mensaje de cierre:',
                            media: path.join(PREGUNTAS_DIR, 'Cierre.mp3'),
                        }])
                    }
                }
            } catch (err) {
                console.error('Error crítico en cierre:', err)
                await flowDynamic([
                    '❌ *Ocurrió un error inesperado al guardar la información.*',
                    '',
                    'Por favor contacte al administrador del sistema y mencione este error.',
                    'Sus respuestas no se han perdido — podemos recuperarlas.',
                ].join('\n'))
            }
        }
    )

/* ======================================================
🚀 MAIN
====================================================== */
const main = async () => {

    // Validar variables de entorno requeridas
    const requeridas = ['POSTGRES_DB_HOST', 'POSTGRES_DB_USER', 'POSTGRES_DB_NAME', 'POSTGRES_DB_PASSWORD']
    const faltantes  = requeridas.filter(k => !process.env[k])
    if (faltantes.length > 0) {
        throw new Error(`❌ Variables de entorno faltantes: ${faltantes.join(', ')}`)
    }

    // Probar conexión PostgreSQL al iniciar
    const conectado = await checkPgConnection()
    if (conectado) {
        console.log('✅ PostgreSQL conectado correctamente')
        await verificarMigracionLadm()
    } else {
        console.warn('⚠️ PostgreSQL no disponible al iniciar — el bot iniciará en modo offline')
    }

    console.log('🔍 Configuración BD:', {
        host: process.env.POSTGRES_DB_HOST,
        user: process.env.POSTGRES_DB_USER,
        db:   process.env.POSTGRES_DB_NAME,
        port: process.env.POSTGRES_DB_PORT ?? '5432',
    })

    // Sincronizador offline automático (cada 5 minutos)
    setInterval(syncOfflineQueue, 5 * 60 * 1000)
    console.log('🔄 Sincronizador offline iniciado (cada 5 min)')

    // Flujo de conversación
    const adapterFlow = createFlow([
        consentimientoFlow,
        modoUsoFlow,
        audioPreferenciaFlow,
        nivelLevantamientoFlow,
        buscarTerritorioFlow,
        ubicacionFlow,
        veredaFlow,
        corregimientoFlow,
        modulo4bFlow,
        capturaPerimetroFlow,
        modulo1Flow,
        modulo2Flow,
        modulo3Flow,
        audioHistoriaFlow,
        modulo4Flow,
        modulo5Flow,
        modulo6Flow,
        modulo7Flow,
        modulo7SinDocFlow,
        modulo8Flow,
        modulo9Flow,
        audioValidacionFlow,
        cierreFlow,
        // Levantamiento familiar
        moduloFamiliaFlow,
        cierreFamiliaFlow,
        // Retomar el perímetro de un territorio ya registrado (palabra clave *perímetro*)
        retomarPerimetroFlow,
        // Validación comunitaria de lo levantado (palabra clave *validar*)
        validacionFlow,
        validacionRespuestaFlow,
        validacionPartesFlow,
        validacionObservacionFlow,
    ])

    // ✅ Proveedor oficial de Meta (WhatsApp Cloud API).
    // Requiere estas 3 variables en tu archivo .env:
    //   META_JWT_TOKEN    -> el "token de acceso" permanente del usuario del sistema
    //   META_NUMBER_ID    -> "Identificador del número de teléfono" (Phone Number ID)
    //   META_VERIFY_TOKEN -> cualquier palabra que tú inventes, para verificar el webhook
    const requiredMetaVars = ['META_JWT_TOKEN', 'META_NUMBER_ID', 'META_VERIFY_TOKEN'] as const
    const faltantesMeta = requiredMetaVars.filter((v) => !process.env[v])
    if (faltantesMeta.length > 0) {
        throw new Error(
            `❌ Faltan variables de entorno para el proveedor de Meta en .env: ${faltantesMeta.join(', ')}`
        )
    }

    const adapterProvider = createProvider(Provider, {
        jwtToken: process.env.META_JWT_TOKEN!,
        numberId: process.env.META_NUMBER_ID!,
        verifyToken: process.env.META_VERIFY_TOKEN!,
        version: 'v25.0',
    })

    // ──────────────────────────────────────────────
    // ✅ CORRECCIÓN CRÍTICA: identidades por "username" (BSUID)
    //
    // WhatsApp ya no siempre identifica al remitente con su número de teléfono.
    // Cuando la persona tiene un nombre de usuario configurado, Meta envía el
    // webhook con "from_user_id" / "user_id" (un BSUID, p. ej. "CO.10192821...")
    // y SIN el campo "from".
    //
    // @builderbot/provider-meta 1.4.2 solo lee "message.from", así que el
    // remitente llegaba como undefined y la respuesta se enviaba sin campo "to".
    // Meta la rechazaba, y el proveedor se traga ese error en silencio
    // (`catch (error) { return error }`), por eso el bot no respondía nada
    // y tampoco aparecía ningún error en la consola.
    //
    // Aquí completamos "from" con el BSUID antes de que builderbot procese el
    // mensaje. El proveedor ya sabe enviar a un BSUID sin modificarlo.
    // ──────────────────────────────────────────────
    const emitOriginal = adapterProvider.emit.bind(adapterProvider)
    ;(adapterProvider as any).emit = (evento: string, payload: any, ...resto: any[]) => {
        if (evento === 'message' && payload && !payload.from) {
            const bsuid = payload.userId ?? payload.from_user_id ?? payload.user_id
            if (bsuid) {
                payload.from = bsuid
                console.log(`👤 Remitente identificado por nombre de usuario (BSUID): ${bsuid}`)
            } else {
                console.warn('⚠️ Mensaje entrante sin remitente identificable:', JSON.stringify(payload).slice(0, 300))
            }
        }
        return emitOriginal(evento, payload, ...resto)
    }

    // ──────────────────────────────────────────────
    // ✅ Envío hacia un BSUID.
    //
    // Cuando el destinatario es un BSUID (no un número de teléfono), la API de
    // Meta exige el parámetro "recipient" en lugar de "to". Si se manda en "to"
    // responde: (#131009) "El formato del número de teléfono es incorrecto".
    // Ver: developers.facebook.com → Business-scoped user IDs
    //
    // De paso registramos la respuesta real de Meta, porque el proveedor la
    // oculta con `catch (error) { return error }`.
    // ──────────────────────────────────────────────
    const esBSUID = (valor: any): boolean =>
        typeof valor === 'string' && /^[A-Z]{2}\.[A-Za-z0-9]+$/.test(valor)

    const enviarOriginal = (adapterProvider as any).sendMessageToApi.bind(adapterProvider)
    ;(adapterProvider as any).sendMessageToApi = async (body: any) => {
        const destino = body?.to ?? body?.recipient
        if (esBSUID(body?.to)) {
            body = { ...body, recipient: body.to }
            delete body.to
        }
        const respuesta = await enviarOriginal(body)
        if (respuesta?.messages?.[0]?.id) {
            console.log(`📤 Enviado a ${destino} → ${respuesta.messages[0].id}`)
        } else {
            const detalle = respuesta?.response?.data?.error ?? respuesta?.message ?? respuesta
            console.error(`❌ Meta rechazó el envío a ${destino}:`, JSON.stringify(detalle)?.slice(0, 500))
        }
        return respuesta
    }

    const adapterDB = new Database()

    const { handleCtx, httpServer } = await createBot({
        flow:     adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    // Recordatorio automático de perímetro pendiente (cada hora revisa si
    // hay que enviar alguno; la propia consulta decide a quién y cuándo,
    // según las 24h/3 días/3 veces máximo definidas en recordarPerimetroPendiente).
    setInterval(() => recordarPerimetroPendiente(adapterProvider), 60 * 60 * 1000)
    console.log('⏰ Recordatorio de perímetro pendiente iniciado (revisa cada hora)')

    // Lo mismo para las validaciones que quedaron sin responder. Se revisa
    // cada 6 horas y no cada hora: el criterio son días, no horas, y no
    // tiene sentido consultar la base 24 veces para lo mismo.
    setInterval(() => recordarValidacionPendiente(adapterProvider), 6 * 60 * 60 * 1000)
    console.log('⏰ Recordatorio de validación comunitaria iniciado (revisa cada 6 horas)')

    // ──────────────────────────────────────────────
    // 📋 Endpoint: formulario offline (sirve el HTML + Service Worker)
    // ──────────────────────────────────────────────
    adapterProvider.server.get('/formulario', (_req: any, res: any) => {
        const htmlPath = path.join(process.cwd(), 'offline-form.html')
        if (!fs.existsSync(htmlPath)) {
            res.writeHead(404)
            return res.end('Formulario no encontrado')
        }
        const html = fs.readFileSync(htmlPath, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(html)
    })

    adapterProvider.server.get('/sw.js', (_req: any, res: any) => {
        const swPath = path.join(process.cwd(), 'sw.js')
        if (!fs.existsSync(swPath)) {
            res.writeHead(404)
            return res.end('Service Worker no encontrado')
        }
        const js = fs.readFileSync(swPath, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        return res.end(js)
    })

    // ──────────────────────────────────────────────
    // 📐 Endpoints: captura física del perímetro territorial
    // (croquis.html dibujado a mano, recorrido.html caminado con GPS)
    // ──────────────────────────────────────────────
    const servirHtml = (nombreArchivo: string) => (_req: any, res: any) => {
        const rutaArchivo = path.join(process.cwd(), nombreArchivo)
        if (!fs.existsSync(rutaArchivo)) {
            res.writeHead(404)
            return res.end(`${nombreArchivo} no encontrado`)
        }
        const html = fs.readFileSync(rutaArchivo, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(html)
    }
    adapterProvider.server.get('/croquis', servirHtml('croquis.html'))
    adapterProvider.server.get('/recorrido', servirHtml('recorrido.html'))

    adapterProvider.server.get('/sw-perimetro.js', (_req: any, res: any) => {
        const rutaArchivo = path.join(process.cwd(), 'sw-perimetro.js')
        if (!fs.existsSync(rutaArchivo)) {
            res.writeHead(404)
            return res.end('sw-perimetro.js no encontrado')
        }
        const js = fs.readFileSync(rutaArchivo, 'utf-8')
        res.writeHead(200, { 'Content-Type': 'application/javascript' })
        return res.end(js)
    })

    // Recibe el resultado del croquis o del recorrido GPS, enviado
    // desde el navegador (fuera de WhatsApp) mediante el token de un
    // solo uso incluido en el enlace. Queda en una cola "pendiente"
    // hasta que la conversación de WhatsApp lo recoja (ver
    // capturaPerimetroFlow) y lo incorpore al registro final.
    adapterProvider.server.post('/api/perimetro', async (req: any, res: any) => {
        try {
            const { token, metodo, geojson, area_ha, vertices, puntos_gps } = req.body ?? {}

            if (!token || typeof token !== 'string') {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, error: 'token faltante' }))
            }
            if (metodo !== 'croquis_manual' && metodo !== 'recorrido_gps') {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, error: 'metodo inválido' }))
            }
            if (!geojson) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, error: 'geojson faltante' }))
            }

            await pool.query(
                `INSERT INTO tpc_captura_perimetro_pendiente
                    (token, metodo, geojson, puntos_gps, area_ha, vertices)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (token) DO UPDATE SET
                    metodo     = EXCLUDED.metodo,
                    geojson    = EXCLUDED.geojson,
                    puntos_gps = EXCLUDED.puntos_gps,
                    area_ha    = EXCLUDED.area_ha,
                    vertices   = EXCLUDED.vertices,
                    creado_en  = NOW(),
                    usado      = false`,
                [
                    token,
                    metodo,
                    JSON.stringify(geojson),
                    puntos_gps ? JSON.stringify(puntos_gps) : null,
                    area_ha ?? null,
                    vertices ?? null,
                ]
            )

            console.log(`📐 Perímetro recibido (${metodo}) — token ${token.slice(0, 8)}…`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ ok: true }))
        } catch (err) {
            console.error('❌ Error guardando captura de perímetro:', err)
            res.writeHead(500, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ ok: false, error: 'error interno' }))
        }
    })

    // ──────────────────────────────────────────────
    // 📩 Endpoint: enviar mensaje
    // ──────────────────────────────────────────────
    adapterProvider.server.post(
        '/v1/messages',
        handleCtx(async (bot, req, res) => {
            const { number, message, urlMedia } = req.body
            await bot.sendMessage(number, message, { media: urlMedia ?? null })
            return res.end('sended')
        })
    )

    // ──────────────────────────────────────────────
    // 🔍 Endpoint: estado del sistema
    // ──────────────────────────────────────────────
    adapterProvider.server.get('/v1/status', handleCtx(async (bot, req, res) => {
        const pendientes    = (sqlite.prepare("SELECT COUNT(*) as total FROM offline_queue WHERE status='pending'").get() as any).total
        const sincronizados = (sqlite.prepare("SELECT COUNT(*) as total FROM offline_queue WHERE status='synced'").get() as any).total
        const fallidos      = (sqlite.prepare("SELECT COUNT(*) as total FROM offline_queue WHERE status='failed'").get() as any).total

        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({
            postgres_online: pgOnline,
            groq_whisper:    groqClient !== null,
            audio_files:     AUDIO_CACHE.size,
            offline_queue:   { pendientes, sincronizados, fallidos },
            timestamp:       new Date().toISOString(),
        }))
    }))

    // ──────────────────────────────────────────────
    // 🔄 Endpoint: sincronizar manualmente
    // ──────────────────────────────────────────────
    adapterProvider.server.post('/v1/sync', handleCtx(async (bot, req, res) => {
        await syncOfflineQueue()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ status: 'sync triggered', timestamp: new Date().toISOString() }))
    }))

    // ──────────────────────────────────────────────
    // 🚫 Endpoint: blacklist
    // ──────────────────────────────────────────────
    adapterProvider.server.post(
        '/v1/blacklist',
        handleCtx(async (bot, req, res) => {
            const { number, intent } = req.body
            if (intent === 'remove') bot.blacklist.remove(number)
            if (intent === 'add')    bot.blacklist.add(number)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ status: 'ok', number, intent }))
        })
    )

    // Iniciar servidor
    httpServer(+PORT)
    console.log(`🚀 Bot catastro étnico corriendo en puerto ${PORT}`)
    console.log(`📋 Formulario offline: ${process.env.BOT_PUBLIC_URL ?? `http://localhost:${PORT}`}/formulario`)
    console.log(`📊 Estado del sistema: http://localhost:${PORT}/v1/status`)
    console.log(`🔄 Sincronización manual: POST http://localhost:${PORT}/v1/sync`)
}

main().catch(err => {
    console.error('❌ Error fatal al iniciar el bot:', err)
    process.exit(1)
})
