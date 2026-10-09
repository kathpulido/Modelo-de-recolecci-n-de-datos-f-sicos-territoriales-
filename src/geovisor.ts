import 'dotenv/config'
import express, { Request, Response, NextFunction } from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { Pool, Client } from 'pg'
import ExcelJS from 'exceljs'
import puppeteer from 'puppeteer'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import crypto from 'crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const PORT       = Number(process.env.GEOVISOR_PORT)    || 3009
const JWT_SECRET = process.env.GEOVISOR_JWT_SECRET      || 'catastro-etnico-secret'
const BOT_URL    = `http://localhost:${process.env.PORT || 3008}`

/*  De dónde leer los territorios.
 *
 *  Casi todas las consultas del visor unen el predio con la comunidad
 *  dando por hecho que hay uno por comunidad. Desde que existen parcelas
 *  familiares eso dejó de ser cierto: leyendo tpc_predio directamente,
 *  cada comunidad aparecería repetida una vez por parcela, los totales se
 *  contarían de más, y el análisis de traslapes reportaría que cada
 *  parcela se superpone con su propio territorio.
 *
 *  vista_predio_colectivo deja fuera las parcelas. Llega con la misma
 *  migración que habilita el nivel familiar, así que nunca se da el caso
 *  de que existan familias registradas y la vista no exista; mientras esa
 *  migración no se haya aplicado, leer la tabla es correcto.
 *
 *  Se decide en verificarMigraciones(), que corre antes de que el servidor
 *  atienda la primera petición.
 */
let TABLA_PREDIO = 'tpc_predio'

/* =====================================================
   🔌 POOL POSTGRESQL (queries normales)
===================================================== */
const dbConfig = {
    host:     process.env.POSTGRES_DB_HOST,
    user:     process.env.POSTGRES_DB_USER,
    database: process.env.POSTGRES_DB_NAME,
    password: process.env.POSTGRES_DB_PASSWORD,
    port:     +(process.env.POSTGRES_DB_PORT ?? 5432),
    ssl:      process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
}
const pool = new Pool({ ...dbConfig, max: 10 })

/* =====================================================
   🔐 AUTH HELPERS
===================================================== */
interface JWTPayload { id: number; username: string; nombre: string; rol: string }

const signToken = (payload: JWTPayload) =>
    jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' })

const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) { res.status(401).json({ error: 'No autorizado' }); return }
    try {
        (req as any).user = jwt.verify(header.slice(7), JWT_SECRET) as JWTPayload
        next()
    } catch {
        res.status(401).json({ error: 'Token inválido o expirado' })
    }
}

const adminOnly = (req: Request, res: Response, next: NextFunction): void => {
    if ((req as any).user?.rol !== 'admin') { res.status(403).json({ error: 'Solo administradores' }); return }
    next()
}

/* =====================================================
   🔧 HELPER: construir WHERE dinámico con filtros
===================================================== */
function buildWhere(q: any) {
    const conds: string[] = []
    const params: any[]   = []
    let   idx = 1

    if (q.tipo)     { conds.push(`c.tipo_comunidad = $${idx++}`);           params.push(q.tipo) }
    if (q.depto)    { conds.push(`p.departamento ILIKE $${idx++}`);          params.push(`%${q.depto}%`) }
    if (q.municipio){ conds.push(`p.municipio ILIKE $${idx++}`);             params.push(`%${q.municipio}%`) }
    if (q.derecho)  { conds.push(`d.tipo_derecho = $${idx++}`);              params.push(q.derecho) }
    if (q.desde)    { conds.push(`c.fecha_registro >= $${idx++}`);           params.push(q.desde) }
    if (q.hasta)    { conds.push(`c.fecha_registro <= $${idx++}::date + 1`); params.push(q.hasta) }
    if (q.q) {
        conds.push(`(c.nombre_comunidad ILIKE $${idx} OR c.pueblo ILIKE $${idx} OR p.municipio ILIKE $${idx} OR p.departamento ILIKE $${idx})`)
        params.push(`%${q.q}%`); idx++
    }

    return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params }
}

/* =====================================================
   📐 QUERY BASE — une todas las tablas relevantes
===================================================== */
const baseSelect = () => `
    SELECT
        c.id,
        c.nombre_comunidad,
        c.tipo_comunidad,
        c.pueblo                          AS pueblo_etnico,
        c.numero_familias,
        c.numero_personas,
        c.numero_mujeres,
        c.numero_hombres,
        c.fecha_registro,
        c.consentimiento,
        r.nombres_autoridades,
        r.cargo,
        r.legitimidad,
        r.numero_documento_representante,
        t.nombre_territorio,
        t.tipo_procedimiento,
        p.departamento,
        p.municipio,
        p.vereda,
        p.corregimiento,
        p.nombre_predio,
        p.numero_predial,
        p.area_acto_administrativo        AS area_ha,
        p.reconocimiento_estado,
        p.limites_territorio,
        p.zonas_especiales,
        ST_Y(p.geom)                      AS latitud,
        ST_X(p.geom)                      AS longitud,
        -- Perímetro capturado por la comunidad (croquis o recorrido GPS)
        p.metodo_captura_perimetro,
        ST_AsGeoJSON(p.geom_perimetro)::json AS poligono,
        -- Área y lindero REALES, medidos sobre el polígono con PostGIS
        -- (geodésicos: en metros sobre el elipsoide, no en grados)
        CASE WHEN p.geom_perimetro IS NULL THEN NULL ELSE
            ROUND((ST_Area(p.geom_perimetro::geography) / 10000)::numeric, 4) END AS area_real_ha,
        CASE WHEN p.geom_perimetro IS NULL THEN NULL ELSE
            ROUND((ST_Perimeter(p.geom_perimetro::geography) / 1000)::numeric, 3) END AS perimetro_km,
        d.tipo_derecho,
        res.tipo_restriccion,
        fe.tipo_fuente_espacial,
        fe.numero_plano,
        h.antiguedad_territorio,
        h.descripcion_historia,
        h.audio_url                       AS audio_historia,
        u.tipo_uso,
        u.reglas_internas,
        v.validado_por_comunidad,
        v.observaciones_finales,
        v.audio_observaciones_url         AS audio_validacion,
        v.fecha_validacion
    FROM tpc_interesado_comunidad             c
    LEFT JOIN tpc_representante_legal         r   ON r.comunidad_id  = c.id
    LEFT JOIN tpc_territorio_propiedad_colectiva t ON t.comunidad_id = c.id
    LEFT JOIN ${TABLA_PREDIO}                 p   ON p.comunidad_id  = c.id
    LEFT JOIN tpc_derecho                     d   ON d.comunidad_id  = c.id
    LEFT JOIN tpc_restriccion                 res ON res.comunidad_id = c.id
    LEFT JOIN tpc_fuente_espacial             fe  ON fe.comunidad_id = c.id
    LEFT JOIN ext_historia_territorio         h   ON h.comunidad_id  = c.id
    LEFT JOIN ext_uso_territorio              u   ON u.predio_id     = p.id
    LEFT JOIN ext_validacion_comunitaria      v   ON v.comunidad_id  = c.id
`

/* =====================================================
   🌍 EXPRESS APP
===================================================== */
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

// Archivos estáticos (public/)
//
// Los .html se sirven siempre con no-store: son los que editamos seguido
// (geovisor.html, login.html) y sin esto el navegador puede quedarse con
// una copia vieja al navegar normal (sin recargar a la fuerza con
// Ctrl+Shift+R). Los demás archivos estáticos sí pueden cachearse normal.
const PUBLIC_DIR = path.join(__dirname, '..', 'public')
app.use(express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store')
        }
    },
}))

/* ──────────────────────────────────────────────────
   AUTH
────────────────────────────────────────────────── */
app.post('/auth/login', async (req: Request, res: Response): Promise<void> => {
    const { username, password } = req.body
    if (!username || !password) { res.status(400).json({ error: 'Faltan credenciales' }); return }

    try {
        const result = await pool.query(
            'SELECT * FROM geovisor_users WHERE username=$1 AND activo=true', [username]
        )
        if (!result.rows.length) { res.status(401).json({ error: 'Credenciales incorrectas' }); return }

        const user  = result.rows[0]
        const valid = await bcrypt.compare(password, user.password_hash)
        if (!valid) { res.status(401).json({ error: 'Credenciales incorrectas' }); return }

        await pool.query('UPDATE geovisor_users SET last_login=NOW() WHERE id=$1', [user.id])

        const token = signToken({ id: user.id, username: user.username, nombre: user.nombre, rol: user.rol })
        res.json({ token, user: { id: user.id, username: user.username, nombre: user.nombre, rol: user.rol } })
    } catch (err) {
        console.error('Login error:', err)
        res.status(500).json({ error: 'Error interno' })
    }
})

// Cambiar contraseña propia
app.put('/auth/password', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { actual, nueva } = req.body
    const uid = (req as any).user.id
    try {
        const r = await pool.query('SELECT password_hash FROM geovisor_users WHERE id=$1', [uid])
        if (!await bcrypt.compare(actual, r.rows[0].password_hash)) {
            res.status(400).json({ error: 'Contraseña actual incorrecta' }); return
        }
        const hash = await bcrypt.hash(nueva, 10)
        await pool.query('UPDATE geovisor_users SET password_hash=$1 WHERE id=$2', [hash, uid])
        res.json({ ok: true })
    } catch (err) {
        res.status(500).json({ error: 'Error interno' })
    }
})

/* ──────────────────────────────────────────────────
   PUNTOS GeoJSON
────────────────────────────────────────────────── */
app.get('/api/puntos', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { where, params } = buildWhere(req.query)

    try {
        const { rows } = await pool.query(
            `${baseSelect()} ${where} AND p.geom IS NOT NULL ORDER BY c.fecha_registro DESC`,
            params
        )

        const geojson = {
            type: 'FeatureCollection',
            total: rows.length,
            features: rows.map(r => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [+r.longitud, +r.latitud] },
                properties: {
                    id:               r.id,
                    nombre:           r.nombre_comunidad,
                    tipo:             r.tipo_comunidad,
                    pueblo:           r.pueblo_etnico,
                    personas:         r.numero_personas,
                    familias:         r.numero_familias,
                    fecha:            r.fecha_registro,
                    departamento:     r.departamento,
                    municipio:        r.municipio,
                    vereda:           r.vereda,
                    area:             r.area_ha,
                    reconocimiento:   r.reconocimiento_estado,
                    derecho:          r.tipo_derecho,
                    validacion:       r.validado_por_comunidad,
                },
            })),
        }
        res.json(geojson)
    } catch (err) {
        console.error('Error /api/puntos:', err)
        res.status(500).json({ error: 'Error consultando puntos' })
    }
})

/* ──────────────────────────────────────────────────
   LISTADO PAGINADO
────────────────────────────────────────────────── */
app.get('/api/registros', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { where, params } = buildWhere(req.query)
    const page  = Math.max(1, parseInt(req.query.page as string)  || 1)
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20)
    const offset = (page - 1) * limit

    try {
        const countRes = await pool.query(
            `SELECT COUNT(*) FROM tpc_interesado_comunidad c
             LEFT JOIN ${TABLA_PREDIO} p ON p.comunidad_id = c.id
             LEFT JOIN tpc_derecho d ON d.comunidad_id = c.id
             ${where}`, params
        )
        const total = parseInt(countRes.rows[0].count)

        const paginatedParams = [...params, limit, offset]
        const { rows } = await pool.query(
            `${baseSelect()} ${where} ORDER BY c.fecha_registro DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            paginatedParams
        )
        res.json({ data: rows, total, page, limit, pages: Math.ceil(total / limit) })
    } catch (err) {
        console.error('Error /api/registros:', err)
        res.status(500).json({ error: 'Error consultando registros' })
    }
})

/* ──────────────────────────────────────────────────
   DETALLE DE UN REGISTRO
────────────────────────────────────────────────── */
/*  Cómo se muestran los métodos de producción del estándar. Se incluyen
 *  también los nombres viejos, porque un registro guardado antes de la
 *  migración puede seguir teniéndolos si esa base no se migró.
 */
const METODO_ETIQUETA: Record<string, string> = {
    Metodo_Directo:                    'Recorrido GPS (medición directa)',
    Metodo_Declarativo_y_Colaborativo: 'Croquis dibujado por la comunidad',
    Metodo_Indirecto:                  'Derivado de cartografía existente',
    Sin_Metodo:                        'Sin captura de perímetro',
    croquis_manual:                    'Croquis dibujado por la comunidad',
    recorrido_gps:                     'Recorrido GPS (medición directa)',
    no_capturado:                      'Sin captura de perímetro',
}

app.get('/api/registro/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params
    try {
        const { rows } = await pool.query(
            `${baseSelect()} WHERE c.id = $1`, [id]
        )
        if (!rows.length) { res.status(404).json({ error: 'Registro no encontrado' }); return }
        const registro: any = rows[0]

        // Fotos y transcripciones van aparte y toleran fallar: si todavía no
        // se corrió migrate_voz_fotos.sql, el detalle se muestra igual sin
        // ellas, en vez de romper toda la ficha del territorio.
        try {
            const fotos = await pool.query(
                `SELECT id, categoria, ruta_archivo, descripcion, fecha
                 FROM ext_foto_registro WHERE comunidad_id = $1 ORDER BY fecha`, [id])
            registro.fotos = fotos.rows
        } catch { registro.fotos = [] }

        try {
            const tr = await pool.query(
                `SELECT pregunta_clave, transcripcion, valor_interpretado, fecha
                 FROM ext_transcripcion_respuesta WHERE comunidad_id = $1 ORDER BY fecha`, [id])
            registro.transcripciones = tr.rows
        } catch { registro.transcripciones = [] }

        // El documento que sustenta el derecho. Antes esta tabla nunca
        // recibía datos, así que la ficha no podía responder "¿con qué
        // documento se reconoce este territorio?".
        try {
            const fa = await pool.query(
                `SELECT f.tipo_fuente, f.tipo_acto_administrativo,
                        f.numero_acto_administrativo, f.fecha_documento,
                        f.fecha_acto_administrativo AS fecha_declarada
                 FROM tpc_fuente_administrativa f
                 WHERE f.comunidad_id = $1
                 ORDER BY f.id`, [id])
            registro.fuentes_administrativas = fa.rows
        } catch { registro.fuentes_administrativas = [] }

        // El lindero tramo por tramo, con el método con que se determinó
        // cada uno. Solo existe después de migrate_ladm.sql.
        try {
            const lin = await pool.query(
                `SELECT tramo, ROUND(longitud_m::numeric, 1) AS longitud_m,
                        metodo_legible, descripcion_lindero
                 FROM vista_lindero_detalle
                 WHERE predio_id = (SELECT id FROM ${TABLA_PREDIO} WHERE comunidad_id = $1 LIMIT 1)
                 ORDER BY tramo`, [id])
            registro.lindero = lin.rows
        } catch { registro.lindero = [] }

        // El censo: lo que estimó la autoridad frente a lo que suman las
        // familias efectivamente levantadas. Es el mismo contraste que ya
        // existe entre el área del documento y el área del polígono.
        try {
            const censo = await pool.query(
                `SELECT familias_declaradas, familias_registradas,
                        personas_declaradas, personas_registradas,
                        mujeres_registradas, hombres_registrados, cobertura_censo_pct
                 FROM vista_censo_comunidad WHERE comunidad_id = $1`, [id])
            registro.censo = censo.rows[0] ?? null
        } catch { registro.censo = null }

        try {
            const fam = await pool.query(
                // familia_id se incluye para poder borrar una familia puntual
                // desde la ficha (ver DELETE /api/familia/:id) sin tener que
                // buscarla de nuevo.
                //
                // predio_id y poligono se incluyen para poder corregir el
                // lindero de una parcela desde la misma ficha. Antes eso solo
                // se podía hacer abriendo la capa de parcelas en el mapa y
                // pinchando el polígono, que es justo donde nadie lo busca.
                `SELECT familia_id, predio_id, nombre_familia, jefe_hogar, numero_personas,
                        numero_mujeres, numero_hombres, tipo_derecho, origen_asignacion,
                        area_real_ha, poligono
                 FROM vista_parcelas_familiares WHERE comunidad_id = $1
                 ORDER BY nombre_familia`, [id])
            registro.familias = fam.rows
        } catch { registro.familias = [] }

        // Nombre legible del método de captura. Se traduce aquí y no con un
        // JOIN al catálogo porque ese catálogo solo existe después de la
        // migración, y la ficha debe seguir abriendo sin ella.
        registro.metodo_captura_legible =
            METODO_ETIQUETA[registro.metodo_captura_perimetro] ?? registro.metodo_captura_perimetro

        res.json(registro)
    } catch (err) {
        console.error('Error /api/registro/:id:', err)
        res.status(500).json({ error: 'Error consultando registro' })
    }
})

/* ──────────────────────────────────────────────────
   BORRAR UN REGISTRO (territorio colectivo completo)

   Solo para administradores. Borra la comunidad y, con ella, todo lo
   que cuelga de esa comunidad_id — representante legal, historia,
   derechos, restricciones, fuentes, familias, fotos, transcripciones y
   la capa LADM-COL (col_*) — porque esas tablas sí tienen
   ON DELETE CASCADE hacia tpc_interesado_comunidad.

   tpc_predio es la única excepción a propósito (para no perder un
   predio sin querer al tocar la comunidad desde otro lado), así que
   aquí se borra explícitamente antes: eso se lleva de paso tanto el
   predio colectivo como cualquier parcela familiar de esta comunidad
   (comparten el mismo comunidad_id).

   Usa siempre el nombre real de la tabla (tpc_predio), nunca
   TABLA_PREDIO — esa variable puede apuntar a vista_predio_colectivo,
   que deja por fuera las parcelas familiares de la comunidad.
────────────────────────────────────────────────── */
app.delete('/api/registro/:id', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        const existe = await client.query(
            'SELECT id, nombre_comunidad FROM tpc_interesado_comunidad WHERE id = $1', [id]
        )
        if (!existe.rows.length) {
            await client.query('ROLLBACK')
            res.status(404).json({ error: 'Registro no encontrado' })
            return
        }

        // tpc_captura_perimetro_pendiente.predio_id no tiene ON DELETE
        // CASCADE. En la práctica el bot nunca llena esa columna (queda
        // NULL siempre), pero se limpia igual por seguridad, para que un
        // registro viejo de otra fuente no bloquee el borrado.
        await client.query(
            `DELETE FROM tpc_captura_perimetro_pendiente
             WHERE predio_id IN (SELECT id FROM tpc_predio WHERE comunidad_id = $1)`,
            [id]
        )

        await client.query(`DELETE FROM tpc_predio WHERE comunidad_id = $1`, [id])
        await client.query(`DELETE FROM tpc_interesado_comunidad WHERE id = $1`, [id])

        await client.query('COMMIT')
        console.log(`🗑️ Registro eliminado por ${(req as any).user?.username}: comunidad ${id} (${existe.rows[0].nombre_comunidad})`)
        res.json({ ok: true })
    } catch (err) {
        await client.query('ROLLBACK')
        console.error('Error DELETE /api/registro/:id:', err)
        res.status(500).json({ error: 'Error eliminando el registro' })
    } finally {
        client.release()
    }
})

/* ──────────────────────────────────────────────────
   BORRAR LA PARCELA DE UNA FAMILIA (sin tocar el territorio)

   Solo para administradores. tpc_interesado_familia no tiene una
   columna que apunte a su propio predio — ese vínculo lo guarda
   tpc_derecho (familia_id + predio_id) — así que primero se busca ahí
   cuál predio corresponde, y se borran los dos.
────────────────────────────────────────────────── */
app.delete('/api/familia/:id', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        const familiaRes = await client.query(
            'SELECT id, nombre_familia FROM tpc_interesado_familia WHERE id = $1', [id]
        )
        if (!familiaRes.rows.length) {
            await client.query('ROLLBACK')
            res.status(404).json({ error: 'Familia no encontrada' })
            return
        }

        const derechoRes = await client.query(
            `SELECT predio_id FROM tpc_derecho WHERE familia_id = $1 AND predio_id IS NOT NULL LIMIT 1`,
            [id]
        )
        const predioId = derechoRes.rows[0]?.predio_id ?? null

        if (predioId) {
            await client.query(`DELETE FROM tpc_captura_perimetro_pendiente WHERE predio_id = $1`, [predioId])
            await client.query(`DELETE FROM tpc_predio WHERE id = $1 AND nivel_tenencia = 'Familiar'`, [predioId])
        }
        // Por si acaso la familia se guardó sin un derecho/predio vinculado
        // (dato incompleto): igual se borra la familia, para que "Eliminar"
        // nunca se quede sin hacer nada.
        await client.query(`DELETE FROM tpc_interesado_familia WHERE id = $1`, [id])

        await client.query('COMMIT')
        console.log(`🗑️ Familia eliminada por ${(req as any).user?.username}: ${id} (${familiaRes.rows[0].nombre_familia})`)
        res.json({ ok: true })
    } catch (err) {
        await client.query('ROLLBACK')
        console.error('Error DELETE /api/familia/:id:', err)
        res.status(500).json({ error: 'Error eliminando la familia' })
    } finally {
        client.release()
    }
})

/* ──────────────────────────────────────────────────
   PARCELAS FAMILIARES

   Las parcelas que las familias ocupan dentro de un territorio colectivo.
   Van en su propia capa porque son otra cosa: la comunidad es dueña del
   territorio, la familia solo tiene derecho de uso sobre su pedazo.
────────────────────────────────────────────────── */
app.get('/api/parcelas', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
        const cond: string[] = []
        const params: any[] = []
        if (req.query.comunidad) {
            params.push(req.query.comunidad)
            cond.push(`comunidad_id = $${params.length}`)
        }
        const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''

        const { rows } = await pool.query(
            `SELECT * FROM vista_parcelas_familiares ${where} ORDER BY predio_id`, params)

        const props = (r: any) => ({
            id:           r.predio_id,
            comunidad_id: r.comunidad_id,
            comunidad:    r.nombre_comunidad,
            familia:      r.nombre_familia,
            jefe_hogar:   r.jefe_hogar,
            personas:     r.numero_personas,
            mujeres:      r.numero_mujeres,
            hombres:      r.numero_hombres,
            antiguedad:   r.antiguedad_ocupacion,
            origen:       r.origen_asignacion,
            derecho:      r.tipo_derecho,
            vereda:       r.vereda,
            area_real:    r.area_real_ha,
            metodo:       r.metodo_captura_perimetro,
        })

        const poligonos = rows.filter(r => r.poligono)
            .map(r => ({ type: 'Feature', geometry: r.poligono, properties: props(r) }))
        const puntos = rows.filter(r => r.latitud != null && r.longitud != null)
            .map(r => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [+r.longitud, +r.latitud] },
                properties: props(r),
            }))

        res.json({
            puntos:    { type: 'FeatureCollection', total: puntos.length,    features: puntos },
            poligonos: { type: 'FeatureCollection', total: poligonos.length, features: poligonos },
        })
    } catch (err) {
        // Sin migrate_familias.sql la vista no existe; el visor sigue
        // funcionando, simplemente sin esta capa.
        res.json({
            puntos:    { type: 'FeatureCollection', total: 0, features: [] },
            poligonos: { type: 'FeatureCollection', total: 0, features: [] },
        })
    }
})

/* =====================================================
   ✏️ EDICIÓN DE POLÍGONOS  (solo administradores)
   =====================================================

   El perímetro entra por el bot: la comunidad dibuja el croquis o hace el
   recorrido GPS. Eso está bien como origen del dato, pero deja sin salida
   dos cosas que solo se ven después, con el mapa completo delante:

     · huecos — al juntar las parcelas familiares quedan franjas vacías
       entre una y otra, porque cada familia midió su lindero por separado;
     · traslapes — dos parcelas, o dos territorios vecinos, se montan el
       uno sobre el otro y las hectáreas se cuentan dos veces.

   Todo lo de aquí abajo corre bajo adminOnly y deja rastro en
   geo_edicion_poligono: quién cambió qué, cuándo, con qué parámetros y
   cuál era la geometría anterior completa. Un cambio de geometría en un
   catastro no puede ser anónimo ni irreversible.

   Requiere migrate_edicion_poligono.sql.
===================================================== */

/* Todo el visor identifica un territorio por el id de la COMUNIDAD: es lo
   que viaja en mostrarDetalle(), en los popups del mapa y en la lista de
   activos. La geometría, en cambio, vive en tpc_predio. Esta función hace
   la traducción en un solo sitio, y se queda siempre con el predio
   colectivo: si tomara cualquier fila de la comunidad podría acabar
   editando la parcela de una familia creyendo que es el territorio. */
async function predioColectivoDe(comunidadId: number): Promise<number | null> {
    const { rows } = await pool.query(
        `SELECT id FROM tpc_predio
          WHERE comunidad_id = $1
            AND (nivel_tenencia = 'Colectivo' OR nivel_tenencia IS NULL)
          ORDER BY id
          LIMIT 1`, [comunidadId])
    return rows.length ? rows[0].id : null
}

/* Guarda una geometría nueva en tpc_predio dejando el registro de auditoría.
   Corre todo dentro de una transacción: o queda el polígono nuevo Y su
   bitácora, o no queda nada. Si se guardara el polígono sin la bitácora se
   perdería para siempre la posibilidad de deshacer. */
async function guardarGeometria(opts: {
    predioId: number
    geojson:  any
    accion:   string
    motivo?:  string
    detalle?: any
    usuario:  JWTPayload
}): Promise<{ area_anterior_ha: number | null; area_nueva_ha: number; edicion_id: number }> {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')

        const previo = await client.query(
            `SELECT geom_perimetro,
                    CASE WHEN geom_perimetro IS NULL THEN NULL ELSE
                        ROUND((ST_Area(geom_perimetro::geography) / 10000)::numeric, 4)
                    END AS area_ha
               FROM tpc_predio WHERE id = $1 FOR UPDATE`, [opts.predioId])

        if (!previo.rowCount) throw new Error('PREDIO_NO_EXISTE')

        // ST_MakeValid arregla los autocruces que deja el ratón al arrastrar
        // un vértice sobre el lado de enfrente. Sin esto, PostGIS acepta la
        // geometría pero ST_Area devuelve cualquier cosa.
        const guardado = await client.query(
            `UPDATE tpc_predio
                SET geom_perimetro = ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))
              WHERE id = $1
          RETURNING ROUND((ST_Area(geom_perimetro::geography) / 10000)::numeric, 4) AS area_ha`,
            [opts.predioId, JSON.stringify(opts.geojson)])

        const auditoria = await client.query(
            `INSERT INTO geo_edicion_poligono
                 (predio_id, usuario_id, usuario_nombre, accion, motivo,
                  geom_anterior, geom_nueva, area_anterior_ha, area_nueva_ha, detalle)
             VALUES ($1, $2, $3, $4, $5, $6,
                     ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)), $8, $9, $10)
             RETURNING id`,
            [
                opts.predioId,
                opts.usuario.id,
                opts.usuario.nombre || opts.usuario.username,
                opts.accion,
                opts.motivo || null,
                previo.rows[0].geom_perimetro,
                JSON.stringify(opts.geojson),
                previo.rows[0].area_ha,
                guardado.rows[0].area_ha,
                opts.detalle ? JSON.stringify(opts.detalle) : null,
            ])

        await client.query('COMMIT')

        return {
            area_anterior_ha: previo.rows[0].area_ha,
            area_nueva_ha:    guardado.rows[0].area_ha,
            edicion_id:       auditoria.rows[0].id,
        }
    } catch (err) {
        await client.query('ROLLBACK')
        throw err
    } finally {
        client.release()
    }
}

/* ──────────────────────────────────────────────────
   DIAGNÓSTICO — qué problemas tiene la geometría
   de una comunidad, con la forma de cada uno para
   poder pintarlo en el mapa antes de decidir.
────────────────────────────────────────────────── */
app.get('/api/comunidad/:id/diagnostico', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const comunidadId = +req.params.id
    // Por debajo de 200 m² casi todo es ruido de GPS; mostrarlo llenaría la
    // lista de avisos que nadie va a corregir.
    const minHa = Number(req.query.min_ha ?? 0.02)

    try {
        const { rows } = await pool.query(
            `SELECT * FROM fn_diagnostico_geometria($1, $2) ORDER BY hectareas DESC`,
            [comunidadId, minHa])

        const huecos    = rows.filter(r => r.tipo === 'hueco_entre_parcelas')
        const traslapes = rows.filter(r => String(r.tipo).startsWith('traslape'))

        res.json({
            comunidad_id: comunidadId,
            total:        rows.length,
            resumen: {
                huecos:          huecos.length,
                traslapes:       traslapes.length,
                ha_en_huecos:    +huecos.reduce((s, r) => s + (+r.hectareas || 0), 0).toFixed(4),
                ha_en_traslapes: +traslapes.reduce((s, r) => s + (+r.hectareas || 0), 0).toFixed(4),
            },
            problemas: rows,
        })
    } catch (err: any) {
        console.error('Error /api/comunidad/:id/diagnostico:', err)
        if (err?.code === '42883') {
            res.status(501).json({ error: 'Falta aplicar migrate_edicion_poligono.sql en la base de datos.' })
            return
        }
        res.status(500).json({ error: 'Error analizando la geometría' })
    }
})

/* ──────────────────────────────────────────────────
   GUARDAR UN POLÍGONO EDITADO A MANO
   El visor manda la geometría tal como quedó después
   de mover los vértices en el mapa.

   Dos rutas para el mismo trabajo, porque el visor
   nombra las cosas de dos maneras: el territorio se
   identifica por su comunidad (es lo que viaja en la
   ficha y en los popups del mapa) y la parcela
   familiar por su predio, que es lo que trae la capa
   de parcelas. Las dos terminan aquí.
────────────────────────────────────────────────── */
async function manejarEdicionLindero(
    predioId: number | null,
    req: Request,
    res: Response,
): Promise<void> {
    const { geometria, motivo } = req.body || {}

    if (!geometria || !geometria.type) {
        res.status(400).json({ error: 'Falta la geometría' }); return
    }
    if (!['Polygon', 'MultiPolygon'].includes(geometria.type)) {
        res.status(400).json({ error: 'El perímetro tiene que ser un polígono' }); return
    }
    if (!predioId) {
        res.status(404).json({ error: 'No se encontró el predio que se quiere editar' }); return
    }

    try {
        // Se valida ANTES de tocar la tabla: un anillo de dos puntos o un
        // polígono sin cerrar entra igual en PostGIS y deja el territorio
        // con un área imposible.
        const check = await pool.query(
            `SELECT ST_IsValid(g) AS valida,
                    ST_IsValidReason(g) AS razon,
                    ROUND((ST_Area(g::geography) / 10000)::numeric, 4) AS area_ha
               FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) t`,
            [JSON.stringify(geometria)])

        if (!(+check.rows[0].area_ha > 0)) {
            res.status(400).json({ error: 'El polígono dibujado no encierra ninguna superficie' }); return
        }

        // Nivel y comunidad del predio: hacen falta para el aviso por
        // WebSocket y para que la bitácora diga qué se editó.
        const info = await pool.query(
            `SELECT comunidad_id, COALESCE(nivel_tenencia, 'Colectivo') AS nivel
               FROM tpc_predio WHERE id = $1`, [predioId])
        if (!info.rowCount) { res.status(404).json({ error: 'Ese predio no existe' }); return }

        const r = await guardarGeometria({
            predioId,
            geojson: geometria,
            accion:  'edicion_manual',
            motivo:  motivo || null,
            detalle: {
                nivel:            info.rows[0].nivel,
                geometria_valida: check.rows[0].valida,
                razon:            check.rows[0].valida ? null : check.rows[0].razon,
            },
            usuario: (req as any).user,
        })

        // Los triggers de migrate_ladm ya recalcularon el área y rehicieron
        // la topología del lindero (col_punto, col_cadenadelimite,
        // col_caraslindero) con la geometría nueva. Vale igual para una
        // parcela familiar: la topología se genera por predio, no por nivel.
        broadcast({
            tipo:         'geometria_editada',
            comunidad_id: info.rows[0].comunidad_id,
            predio_id:    predioId,
            nivel:        info.rows[0].nivel,
            ...r,
        })
        res.json({ ok: true, nivel: info.rows[0].nivel, ...r })
    } catch (err: any) {
        console.error('Error guardando polígono:', err)
        if (err?.message === 'PREDIO_NO_EXISTE') {
            res.status(404).json({ error: 'Ese predio no existe' }); return
        }
        if (err?.code === '42P01') {
            res.status(501).json({ error: 'Falta aplicar migrate_edicion_poligono.sql en la base de datos.' }); return
        }
        res.status(500).json({ error: 'No se pudo guardar el polígono' })
    }
}

/* El perímetro del territorio, identificado por su comunidad */
app.put('/api/comunidad/:id/poligono', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    await manejarEdicionLindero(await predioColectivoDe(+req.params.id), req, res)
})

/* El lindero de un predio cualquiera por su id: sirve tanto para el predio
   colectivo como para una parcela familiar. Es la ruta que usa la capa de
   parcelas del mapa, donde lo que se conoce es el predio y no la comunidad. */
app.put('/api/predio/:id/poligono', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    await manejarEdicionLindero(+req.params.id, req, res)
})

/* ──────────────────────────────────────────────────
   UNIÓN AUTOMÁTICA
   Tres modos, todos con previsualización: el visor
   pide primero previsualizar:true, pinta el resultado
   encima del mapa, y solo guarda si la administradora
   confirma que se ve bien.
────────────────────────────────────────────────── */
app.post('/api/comunidad/:id/unir', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    const {
        modo,                       // parcelas | huecos | traslape
        tolerancia_m   = 2,
        min_hueco_ha   = 0.25,
        vecino_id      = null,      // id de COMUNIDAD vecina, solo para modo 'traslape'
        previsualizar  = true,
        motivo         = null,
    } = req.body || {}

    if (!['parcelas', 'huecos', 'traslape'].includes(modo)) {
        res.status(400).json({ error: 'Modo no reconocido' }); return
    }
    // Más de 50 m ya no es "soldar una franja de medición": es redibujar el
    // lindero. Se corta aquí para que un cero de más no infle el territorio.
    const tol = Math.min(Math.max(Number(tolerancia_m) || 0, 0), 50)

    try {
        const predioId = await predioColectivoDe(+req.params.id)
        if (!predioId) { res.status(404).json({ error: 'Esa comunidad no tiene predio colectivo' }); return }

        let sql: string
        let params: any[]
        let detalle: any = { modo, tolerancia_m: tol, min_hueco_ha }

        if (modo === 'parcelas') {
            /* Une todas las parcelas familiares de la comunidad en un solo
               perímetro colectivo, cerrando de paso las franjas vacías que
               quedan entre parcelas vecinas. */
            sql = `
                WITH origen AS (
                    SELECT p.id, p.geom_perimetro
                      FROM tpc_predio p
                      JOIN tpc_predio matriz ON matriz.id = $1
                     WHERE p.comunidad_id   = matriz.comunidad_id
                       AND p.nivel_tenencia = 'Familiar'
                       AND p.geom_perimetro IS NOT NULL
                )
                SELECT
                    ST_AsGeoJSON(fn_quitar_huecos(
                        fn_unir_y_cerrar(array_agg(geom_perimetro), $2), $3))::json AS geometria,
                    COUNT(*)                     AS parcelas_unidas,
                    array_agg(id)                AS predios_origen
                FROM origen`
            params = [predioId, tol, min_hueco_ha]

        } else if (modo === 'huecos') {
            /* Deja el contorno como está y solo tapa los huecos interiores
               pequeños del polígono que ya tiene el territorio. */
            sql = `
                SELECT ST_AsGeoJSON(fn_quitar_huecos(ST_MakeValid(geom_perimetro), $2))::json AS geometria,
                       NULL::bigint  AS parcelas_unidas,
                       NULL::integer[] AS predios_origen
                  FROM tpc_predio WHERE id = $1`
            params = [predioId, min_hueco_ha]

        } else {
            /* Traslape con un vecino: se funden los dos territorios en uno
               solo, que es lo que corresponde cuando el traslape viene de
               que ambos midieron el mismo lindero compartido.
               (Para repartir la franja en vez de fundirla hace falta una
               decisión de la comunidad, no un algoritmo.) */
            if (!vecino_id) { res.status(400).json({ error: 'Falta indicar con qué territorio se une' }); return }
            const predioVecino = await predioColectivoDe(+vecino_id)
            if (!predioVecino) { res.status(404).json({ error: 'El territorio vecino no tiene predio colectivo' }); return }

            sql = `
                SELECT ST_AsGeoJSON(fn_quitar_huecos(
                           fn_unir_y_cerrar(ARRAY[a.geom_perimetro, b.geom_perimetro], $3), $4))::json AS geometria,
                       2::bigint                AS parcelas_unidas,
                       ARRAY[a.id, b.id]        AS predios_origen
                  FROM tpc_predio a, tpc_predio b
                 WHERE a.id = $1 AND b.id = $2`
            params = [predioId, predioVecino, tol, min_hueco_ha]
            detalle.vecino_comunidad_id = +vecino_id
            detalle.vecino_predio_id    = predioVecino
        }

        const { rows } = await pool.query(sql, params)
        const geometria = rows[0]?.geometria

        if (!geometria) {
            res.status(422).json({
                error: modo === 'parcelas'
                    ? 'Esta comunidad no tiene parcelas familiares con perímetro medido'
                    : 'No hay geometría suficiente para hacer la unión',
            })
            return
        }

        // Cuánto cambia el área: es el número que de verdad mira quien
        // aprueba el cambio.
        const comp = await pool.query(
            `SELECT ROUND((ST_Area(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)::geography) / 10000)::numeric, 4) AS area_nueva,
                    (SELECT ROUND((ST_Area(geom_perimetro::geography) / 10000)::numeric, 4)
                       FROM tpc_predio WHERE id = $2) AS area_actual`,
            [JSON.stringify(geometria), predioId])

        detalle = { ...detalle, parcelas_unidas: rows[0].parcelas_unidas, predios_origen: rows[0].predios_origen }

        if (previsualizar) {
            res.json({
                previsualizacion: true,
                geometria,
                area_actual_ha: comp.rows[0].area_actual,
                area_nueva_ha:  comp.rows[0].area_nueva,
                detalle,
            })
            return
        }

        const accion = modo === 'parcelas' ? 'union_parcelas'
                     : modo === 'huecos'   ? 'cierre_huecos'
                     :                       'resolucion_traslape'

        const r = await guardarGeometria({
            predioId, geojson: geometria, accion, motivo, detalle,
            usuario: (req as any).user,
        })

        broadcast({ tipo: 'geometria_editada', comunidad_id: +req.params.id, predio_id: predioId, ...r })
        res.json({ ok: true, geometria, ...r, detalle })
    } catch (err: any) {
        console.error('Error en unión de polígonos:', err)
        if (err?.code === '42883' || err?.code === '42P01') {
            res.status(501).json({ error: 'Falta aplicar migrate_edicion_poligono.sql en la base de datos.' }); return
        }
        res.status(500).json({ error: 'No se pudo calcular la unión' })
    }
})

/* ──────────────────────────────────────────────────
   HISTORIAL DE CAMBIOS DE GEOMETRÍA + DESHACER
────────────────────────────────────────────────── */
async function historialDePredio(predioId: number | null, res: Response): Promise<void> {
    try {
        if (!predioId) { res.json({ total: 0, ediciones: [] }); return }

        const { rows } = await pool.query(
            `SELECT id, usuario_nombre, accion, motivo, area_anterior_ha, area_nueva_ha,
                    detalle, fecha,
                    geom_anterior IS NOT NULL AS se_puede_deshacer
               FROM geo_edicion_poligono
              WHERE predio_id = $1
              ORDER BY fecha DESC
              LIMIT 50`, [predioId])
        res.json({ total: rows.length, ediciones: rows })
    } catch (err: any) {
        if (err?.code === '42P01') { res.json({ total: 0, ediciones: [] }); return }
        console.error('Error leyendo historial de geometría:', err)
        res.status(500).json({ error: 'Error consultando el historial' })
    }
}

app.get('/api/comunidad/:id/historial-geometria', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    await historialDePredio(await predioColectivoDe(+req.params.id), res)
})

app.get('/api/predio/:id/historial-geometria', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    await historialDePredio(+req.params.id, res)
})

/* Devuelve la geometría al estado anterior a una edición. La reversión se
   anota también como edición, así que deshacer nunca borra historia. */
app.post('/api/edicion-geometria/:edicionId/deshacer', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    try {
        const { rows } = await pool.query(
            `SELECT predio_id, ST_AsGeoJSON(geom_anterior)::json AS geometria, accion
               FROM geo_edicion_poligono WHERE id = $1`, [+req.params.edicionId])

        if (!rows.length)             { res.status(404).json({ error: 'Esa edición no existe' }); return }
        if (!rows[0].geometria)       { res.status(422).json({ error: 'Esa edición no guardó geometría anterior' }); return }

        const r = await guardarGeometria({
            predioId: rows[0].predio_id,
            geojson:  rows[0].geometria,
            accion:   'reversion',
            motivo:   `Se deshizo la edición #${req.params.edicionId} (${rows[0].accion})`,
            detalle:  { edicion_revertida: +req.params.edicionId },
            usuario:  (req as any).user,
        })

        broadcast({ tipo: 'geometria_editada', predio_id: rows[0].predio_id, ...r })
        res.json({ ok: true, ...r })
    } catch (err) {
        console.error('Error deshaciendo edición:', err)
        res.status(500).json({ error: 'No se pudo deshacer la edición' })
    }
})

/* ──────────────────────────────────────────────────
   FOTOS — se sirven desde la carpeta fotos/ del chatbot
────────────────────────────────────────────────── */
app.get('/api/foto/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
        const { rows } = await pool.query(
            'SELECT ruta_archivo FROM ext_foto_registro WHERE id = $1', [req.params.id])
        if (!rows.length) { res.status(404).json({ error: 'Foto no encontrada' }); return }
        const ruta = rows[0].ruta_archivo
        if (!fs.existsSync(ruta)) { res.status(404).json({ error: 'El archivo ya no está en el disco' }); return }
        res.sendFile(path.resolve(ruta))
    } catch (err) {
        res.status(500).json({ error: 'Error sirviendo la foto' })
    }
})

/* ──────────────────────────────────────────────────
   CONFIGURACIÓN PÚBLICA DEL VISOR
   El token de Mapbox es de tipo público (pk.), pensado para ir en el
   navegador, pero se sirve desde el .env para poder rotarlo o
   restringirlo por dominio sin tocar el código del mapa.
────────────────────────────────────────────────── */
app.get('/api/config', (_req: Request, res: Response) => {
    res.json({
        mapboxToken: process.env.MAPBOX_TOKEN ?? '',
        nombreSistema: 'Registro Territorial Comunitario',
    })
})

/* ──────────────────────────────────────────────────
   CAPAS GEOGRÁFICAS — puntos y polígonos en una sola llamada
   Devuelve dos FeatureCollection: la ubicación puntual del territorio y
   el perímetro capturado por la comunidad (croquis o recorrido GPS).
────────────────────────────────────────────────── */
app.get('/api/capas', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { where, params } = buildWhere(req.query)
    try {
        const { rows } = await pool.query(
            `${baseSelect()} ${where} ORDER BY c.fecha_registro DESC`, params
        )

        const props = (r: any) => ({
            id:             r.id,
            nombre:         r.nombre_comunidad,
            tipo:           r.tipo_comunidad,
            pueblo:         r.pueblo_etnico,
            personas:       r.numero_personas,
            familias:       r.numero_familias,
            fecha:          r.fecha_registro,
            departamento:   r.departamento,
            municipio:      r.municipio,
            vereda:         r.vereda,
            area_declarada: r.area_ha,
            area_real:      r.area_real_ha,
            perimetro_km:   r.perimetro_km,
            metodo:         r.metodo_captura_perimetro,
            reconocimiento: r.reconocimiento_estado,
            derecho:        r.tipo_derecho,
            validacion:     r.validado_por_comunidad,
        })

        const puntos = rows
            .filter(r => r.latitud != null && r.longitud != null)
            .map(r => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [+r.longitud, +r.latitud] },
                properties: props(r),
            }))

        const poligonos = rows
            .filter(r => r.poligono)
            .map(r => ({ type: 'Feature', geometry: r.poligono, properties: props(r) }))

        res.json({
            puntos:    { type: 'FeatureCollection', total: puntos.length,    features: puntos },
            poligonos: { type: 'FeatureCollection', total: poligonos.length, features: poligonos },
        })
    } catch (err) {
        console.error('Error /api/capas:', err)
        res.status(500).json({ error: 'Error consultando capas geográficas' })
    }
})

/* ──────────────────────────────────────────────────
   ANÁLISIS 1 — Área y perímetro reales vs. área declarada
   Compara la hectárea titulada en el acto administrativo contra la que
   realmente encierra el polígono capturado en campo.
────────────────────────────────────────────────── */
app.get('/api/analisis/areas', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const depto = (req.query.depto as string)?.trim() || null
    const params: any[] = depto ? [`%${depto}%`] : []
    try {
        const { rows } = await pool.query(`
            SELECT
                c.id,
                c.nombre_comunidad,
                p.departamento,
                p.municipio,
                p.metodo_captura_perimetro                                       AS metodo,
                p.area_acto_administrativo                                       AS area_declarada,
                ROUND((ST_Area(p.geom_perimetro::geography) / 10000)::numeric, 4) AS area_real,
                ROUND((ST_Perimeter(p.geom_perimetro::geography) / 1000)::numeric, 3) AS perimetro_km,
                CASE
                    WHEN p.area_acto_administrativo IS NULL
                      OR p.area_acto_administrativo = 0 THEN NULL
                    ELSE ROUND(
                        (((ST_Area(p.geom_perimetro::geography) / 10000) - p.area_acto_administrativo)
                         / p.area_acto_administrativo * 100)::numeric, 1)
                END                                                              AS diferencia_pct
            FROM ${TABLA_PREDIO} p
            JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
            WHERE p.geom_perimetro IS NOT NULL
            ${depto ? 'AND p.departamento ILIKE $1' : ''}
            ORDER BY ABS(COALESCE(
                (ST_Area(p.geom_perimetro::geography) / 10000) - p.area_acto_administrativo, 0)) DESC`, params)

        res.json({
            total: rows.length,
            // Suma de hectáreas realmente medidas sobre el terreno
            area_total_real: rows.reduce((a, r) => a + (+r.area_real || 0), 0).toFixed(2),
            registros: rows,
        })
    } catch (err) {
        console.error('Error /api/analisis/areas:', err)
        res.status(500).json({ error: 'Error calculando áreas. ¿Se aplicó migrate_perimetro.sql?' })
    }
})

/* ──────────────────────────────────────────────────
   ANÁLISIS 2 — Traslapes entre territorios vecinos
   Detecta polígonos que se superponen y cuántas hectáreas comparten.
   El self-join usa a.id < b.id para no repetir cada par al revés.
────────────────────────────────────────────────── */
app.get('/api/analisis/traslapes', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    // El filtro por región deja pasar el par si CUALQUIERA de los dos
    // territorios está en el departamento elegido: un traslape que cruza el
    // límite departamental le interesa igual a quien mira esa región.
    const depto = (req.query.depto as string)?.trim() || null
    const params: any[] = depto ? [`%${depto}%`] : []
    try {
        const { rows } = await pool.query(`
            SELECT
                ca.id   AS id_a, ca.nombre_comunidad AS comunidad_a,
                cb.id   AS id_b, cb.nombre_comunidad AS comunidad_b,
                pa.municipio,
                ROUND((ST_Area(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro)::geography)
                       / 10000)::numeric, 4) AS hectareas_traslape,
                ROUND((ST_Area(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro)::geography)
                       / NULLIF(ST_Area(pa.geom_perimetro::geography), 0) * 100)::numeric, 1) AS pct_de_a,
                ST_AsGeoJSON(ST_Intersection(pa.geom_perimetro, pb.geom_perimetro))::json AS geometria_traslape
            FROM ${TABLA_PREDIO} pa
            JOIN ${TABLA_PREDIO} pb
              ON pa.id < pb.id
             AND pa.geom_perimetro IS NOT NULL
             AND pb.geom_perimetro IS NOT NULL
             AND ST_Intersects(pa.geom_perimetro, pb.geom_perimetro)
             AND NOT ST_Touches(pa.geom_perimetro, pb.geom_perimetro)
            JOIN tpc_interesado_comunidad ca ON ca.id = pa.comunidad_id
            JOIN tpc_interesado_comunidad cb ON cb.id = pb.comunidad_id
            ${depto ? 'WHERE (pa.departamento ILIKE $1 OR pb.departamento ILIKE $1)' : ''}
            ORDER BY hectareas_traslape DESC`, params)

        res.json({ total: rows.length, traslapes: rows })
    } catch (err) {
        console.error('Error /api/analisis/traslapes:', err)
        res.status(500).json({ error: 'Error calculando traslapes. ¿Se aplicó migrate_perimetro.sql?' })
    }
})

/* ──────────────────────────────────────────────────
   ANÁLISIS 3 — Densidad y distribución territorial
────────────────────────────────────────────────── */
app.get('/api/analisis/densidad', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
    try {
        const [porDepto, porMunicipio, puntosCalor] = await Promise.all([
            pool.query(`
                SELECT
                    COALESCE(p.departamento, 'Sin dato')      AS departamento,
                    COUNT(DISTINCT c.id)                      AS comunidades,
                    COALESCE(SUM(c.numero_personas), 0)       AS personas,
                    COALESCE(SUM(c.numero_familias), 0)       AS familias,
                    ROUND(COALESCE(SUM(ST_Area(p.geom_perimetro::geography) / 10000), 0)::numeric, 2) AS hectareas
                FROM tpc_interesado_comunidad c
                LEFT JOIN ${TABLA_PREDIO} p ON p.comunidad_id = c.id
                GROUP BY 1 ORDER BY comunidades DESC`),

            pool.query(`
                SELECT
                    COALESCE(p.departamento, 'Sin dato') AS departamento,
                    COALESCE(p.municipio, 'Sin dato')    AS municipio,
                    COUNT(DISTINCT c.id)                 AS comunidades,
                    COALESCE(SUM(c.numero_personas), 0)  AS personas
                FROM tpc_interesado_comunidad c
                LEFT JOIN ${TABLA_PREDIO} p ON p.comunidad_id = c.id
                GROUP BY 1, 2 ORDER BY comunidades DESC LIMIT 100`),

            // Puntos con peso para el mapa de calor: pesa la población
            pool.query(`
                SELECT ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng,
                       COALESCE(c.numero_personas, 1) AS peso
                FROM ${TABLA_PREDIO} p
                JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
                WHERE p.geom IS NOT NULL`),
        ])

        res.json({
            por_departamento: porDepto.rows,
            por_municipio:    porMunicipio.rows,
            calor:            puntosCalor.rows.map(r => [+r.lat, +r.lng, +r.peso]),
        })
    } catch (err) {
        console.error('Error /api/analisis/densidad:', err)
        res.status(500).json({ error: 'Error calculando densidad' })
    }
})

/* ──────────────────────────────────────────────────
   ESTADÍSTICAS / DASHBOARD
────────────────────────────────────────────────── */
app.get('/api/estadisticas', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    /*  Filtro opcional por departamento — es el selector de región del visor.
     *
     *  Se resuelve con una subconsulta sobre los predios y no uniendo predio
     *  con comunidad, porque ese JOIN duplicaría la comunidad una vez por
     *  parcela familiar y los totales (personas, familias) se contarían de
     *  más justo en las comunidades donde más se ha trabajado.
     */
    const depto    = (req.query.depto as string)?.trim() || null
    const enRegion = depto
        ? `WHERE c.id IN (SELECT comunidad_id FROM ${TABLA_PREDIO} WHERE departamento ILIKE $1)`
        : ''
    const params: any[] = depto ? [`%${depto}%`] : []

    try {
        const [kpi, porTipo, porDepto, porMes, conGPS] = await Promise.all([
            pool.query(`
                SELECT
                    COUNT(*)                                          AS total_registros,
                    COALESCE(SUM(c.numero_personas), 0)               AS total_personas,
                    COALESCE(SUM(c.numero_familias), 0)               AS total_familias,
                    COUNT(*) FILTER (WHERE c.fecha_registro >= NOW() - INTERVAL '7 days') AS esta_semana
                FROM tpc_interesado_comunidad c ${enRegion}`, params),

            pool.query(`
                SELECT c.tipo_comunidad, COUNT(*) AS cantidad
                FROM tpc_interesado_comunidad c ${enRegion}
                ${enRegion ? 'AND' : 'WHERE'} c.tipo_comunidad IS NOT NULL
                GROUP BY c.tipo_comunidad ORDER BY cantidad DESC`, params),

            // COUNT(DISTINCT c.id): sin el DISTINCT, una comunidad con
            // parcelas familiares aparecería varias veces en su departamento.
            pool.query(`
                SELECT p.departamento, COUNT(DISTINCT c.id) AS cantidad
                FROM ${TABLA_PREDIO} p
                JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
                WHERE p.departamento IS NOT NULL
                ${depto ? 'AND p.departamento ILIKE $1' : ''}
                GROUP BY p.departamento ORDER BY cantidad DESC LIMIT 15`, params),

            pool.query(`
                SELECT TO_CHAR(c.fecha_registro, 'YYYY-MM') AS mes, COUNT(*) AS cantidad
                FROM tpc_interesado_comunidad c ${enRegion}
                GROUP BY mes ORDER BY mes DESC LIMIT 24`, params),

            pool.query(`
                SELECT
                    COUNT(DISTINCT c.id) FILTER (WHERE p.geom IS NOT NULL) AS con_gps,
                    COUNT(DISTINCT c.id) FILTER (WHERE p.geom IS NULL)     AS sin_gps
                FROM tpc_interesado_comunidad c
                LEFT JOIN ${TABLA_PREDIO} p ON p.comunidad_id = c.id
                ${enRegion}`, params),
        ])

        /*  Perímetro capturado: cuántas comunidades ya tienen polígono
         *  (geom_perimetro) y cuántas hectáreas suma eso en total. Es el dato
         *  real medido en campo, distinto del área declarada en el acto
         *  administrativo (esa comparación vive en /api/analisis/areas).
         *
         *  Va aparte del Promise.all y tolera fallar a propósito: mientras no
         *  se haya corrido migrate_perimetro.sql esa columna no existe, y el
         *  panel debe seguir abriendo sin estas dos cifras en lugar de
         *  quedarse en blanco entero.
         */
        let perimetro: any = { con_poligono: 0, territorio_medido_ha: 0, disponible: false }
        try {
            const r = await pool.query(`
                SELECT
                    COUNT(DISTINCT c.id) FILTER (WHERE p.geom_perimetro IS NOT NULL) AS con_poligono,
                    COALESCE(SUM(
                        CASE WHEN p.geom_perimetro IS NOT NULL
                             THEN ST_Area(p.geom_perimetro::geography) / 10000
                             ELSE 0 END
                    ), 0) AS territorio_medido_ha
                FROM tpc_interesado_comunidad c
                LEFT JOIN ${TABLA_PREDIO} p ON p.comunidad_id = c.id
                ${enRegion}`, params)
            perimetro = { ...r.rows[0], disponible: true }
        } catch {
            console.warn('⚠️  /api/estadisticas sin datos de perímetro — falta migrate_perimetro.sql')
        }

        res.json({
            kpi:       kpi.rows[0],
            porTipo:   porTipo.rows,
            porDepto:  porDepto.rows,
            porMes:    porMes.rows.reverse(),
            cobertura: conGPS.rows[0],
            perimetro,
        })
    } catch (err) {
        console.error('Error /api/estadisticas:', err)
        res.status(500).json({ error: 'Error calculando estadísticas' })
    }
})

/* ──────────────────────────────────────────────────
   ÚLTIMOS TERRITORIOS REGISTRADOS (para la tabla del Dashboard)
   Igual que /api/registros pero con un límite corto y solo las
   columnas que la tabla del panel necesita mostrar.
────────────────────────────────────────────────── */
app.get('/api/ultimos', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const limit  = Math.min(20, parseInt(req.query.limit as string) || 5)
    const depto  = (req.query.depto as string)?.trim() || null
    const filtro = depto ? 'WHERE p.departamento ILIKE $2' : ''
    const params: any[] = depto ? [limit, `%${depto}%`] : [limit]

    // Las columnas del perímetro se piden aparte para poder repetir la
    // consulta sin ellas: si no se ha corrido migrate_perimetro.sql no
    // existen, y la tabla del panel debe llenarse igual, solo que sin las
    // hectáreas medidas.
    const consulta = (columnasPerimetro: string) => `
        SELECT
            c.id, c.nombre_comunidad, c.tipo_comunidad, c.numero_personas, c.fecha_registro,
            p.departamento, p.municipio,
            p.area_acto_administrativo AS area_declarada${columnasPerimetro}
        FROM tpc_interesado_comunidad c
        LEFT JOIN ${TABLA_PREDIO} p ON p.comunidad_id = c.id
        ${filtro}
        ORDER BY c.fecha_registro DESC
        LIMIT $1`

    const conPerimetro = `,
            p.metodo_captura_perimetro,
            CASE WHEN p.geom_perimetro IS NULL THEN NULL ELSE
                ROUND((ST_Area(p.geom_perimetro::geography) / 10000)::numeric, 2) END AS area_real_ha,
            CASE WHEN p.geom_perimetro IS NULL THEN NULL ELSE
                ROUND((ST_Perimeter(p.geom_perimetro::geography) / 1000)::numeric, 2) END AS perimetro_km`

    try {
        const { rows } = await pool.query(consulta(conPerimetro), params)
        res.json({ registros: rows })
    } catch {
        try {
            const { rows } = await pool.query(consulta(''), params)
            res.json({ registros: rows })
        } catch (err) {
            console.error('Error /api/ultimos:', err)
            res.status(500).json({ error: 'Error consultando los últimos territorios' })
        }
    }
})

/* ──────────────────────────────────────────────────
   ALERTAS / DETECCIÓN DE ANOMALÍAS
────────────────────────────────────────────────── */
app.get('/api/alertas', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
        const alertas: any[] = []

        // 1. Sin coordenadas GPS
        const sinGPS = await pool.query(`
            SELECT c.id, c.nombre_comunidad, c.fecha_registro, p.municipio
            FROM tpc_interesado_comunidad c
            JOIN ${TABLA_PREDIO} p ON p.comunidad_id = c.id
            WHERE p.geom IS NULL LIMIT 50`)
        sinGPS.rows.forEach(r => alertas.push({
            tipo: 'sin_gps', severidad: 'media',
            mensaje: `Sin coordenadas GPS`,
            comunidad: r.nombre_comunidad, id: r.id, fecha: r.fecha_registro,
        }))

        // 2. Inconsistencia de género (M+H > total)
        const genero = await pool.query(`
            SELECT id, nombre_comunidad, numero_personas, numero_mujeres, numero_hombres, fecha_registro
            FROM tpc_interesado_comunidad
            WHERE numero_mujeres IS NOT NULL AND numero_hombres IS NOT NULL
              AND numero_personas IS NOT NULL
              AND (numero_mujeres + numero_hombres) > numero_personas LIMIT 50`)
        genero.rows.forEach(r => alertas.push({
            tipo: 'inconsistencia_genero', severidad: 'alta',
            mensaje: `Mujeres (${r.numero_mujeres}) + Hombres (${r.numero_hombres}) > Personas (${r.numero_personas})`,
            comunidad: r.nombre_comunidad, id: r.id, fecha: r.fecha_registro,
        }))

        // 3. Área muy grande (>200 000 ha — posible error de digitación)
        const areaGrande = await pool.query(`
            SELECT c.id, c.nombre_comunidad, p.area_acto_administrativo, c.fecha_registro
            FROM ${TABLA_PREDIO} p JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
            WHERE p.area_acto_administrativo > 200000 LIMIT 20`)
        areaGrande.rows.forEach(r => alertas.push({
            tipo: 'area_atipica', severidad: 'baja',
            mensaje: `Área muy grande: ${Number(r.area_acto_administrativo).toLocaleString()} ha`,
            comunidad: r.nombre_comunidad, id: r.id, fecha: r.fecha_registro,
        }))

        // 4. Posibles duplicados (mismo nombre, fecha cercana)
        const dupes = await pool.query(`
            SELECT nombre_comunidad, COUNT(*) AS veces, MAX(id) AS ultimo_id, MAX(fecha_registro) AS ultima_fecha
            FROM tpc_interesado_comunidad
            GROUP BY nombre_comunidad HAVING COUNT(*) > 1 ORDER BY veces DESC LIMIT 20`)
        dupes.rows.forEach(r => alertas.push({
            tipo: 'posible_duplicado', severidad: 'alta',
            mensaje: `Nombre aparece ${r.veces} veces en la base de datos`,
            comunidad: r.nombre_comunidad, id: r.ultimo_id, fecha: r.ultima_fecha,
        }))

        // 5. Validación pendiente
        const pendientes = await pool.query(`
            SELECT c.id, c.nombre_comunidad, c.fecha_registro
            FROM tpc_interesado_comunidad c
            JOIN ext_validacion_comunitaria v ON v.comunidad_id = c.id
            WHERE v.validado_por_comunidad = 'Pendiente' LIMIT 30`)
        pendientes.rows.forEach(r => alertas.push({
            tipo: 'validacion_pendiente', severidad: 'baja',
            mensaje: `Registro sin validar por la comunidad`,
            comunidad: r.nombre_comunidad, id: r.id, fecha: r.fecha_registro,
        }))

        res.json({
            total: alertas.length,
            alertas: alertas.sort((a, b) => (a.severidad === 'alta' ? -1 : 1)),
        })
    } catch (err) {
        console.error('Error /api/alertas:', err)
        res.status(500).json({ error: 'Error calculando alertas' })
    }
})

/* ──────────────────────────────────────────────────
   EXPORTAR CSV
────────────────────────────────────────────────── */
app.get('/api/export/csv', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { where, params } = buildWhere(req.query)
    try {
        const { rows } = await pool.query(`${baseSelect()} ${where} ORDER BY c.fecha_registro DESC`, params)

        const headers = [
            'ID','Comunidad','Tipo','Pueblo','Familias','Personas','Mujeres','Hombres',
            'Fecha Registro','Representante','Cargo','Departamento','Municipio','Vereda',
            'Territorio','Procedimiento','Área (ha)','Reconocimiento','GPS Lat','GPS Lon',
            'Derecho','Restricción','Validación','Observaciones',
        ]
        const escape = (v: any) => {
            if (v == null) return ''
            const s = String(v).replace(/"/g, '""')
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s
        }
        const lines = [
            headers.join(','),
            ...rows.map(r => [
                r.id, r.nombre_comunidad, r.tipo_comunidad, r.pueblo_etnico,
                r.numero_familias, r.numero_personas, r.numero_mujeres, r.numero_hombres,
                r.fecha_registro ? new Date(r.fecha_registro).toLocaleDateString('es-CO') : '',
                r.nombres_autoridades, r.cargo, r.departamento, r.municipio, r.vereda,
                r.nombre_territorio, r.tipo_procedimiento, r.area_ha,
                r.reconocimiento_estado, r.latitud, r.longitud,
                r.tipo_derecho, r.tipo_restriccion, r.validado_por_comunidad, r.observaciones_finales,
            ].map(escape).join(',')),
        ]

        res.setHeader('Content-Type', 'text/csv; charset=utf-8')
        res.setHeader('Content-Disposition', `attachment; filename="catastro_etnico_${Date.now()}.csv"`)
        res.send('\uFEFF' + lines.join('\r\n')) // BOM para Excel
    } catch (err) {
        res.status(500).json({ error: 'Error generando CSV' })
    }
})

/* ──────────────────────────────────────────────────
   EXPORTAR PDF  (Puppeteer + Leaflet + Chart.js)
────────────────────────────────────────────────── */

/** Genera el HTML completo del reporte, con datos embebidos como JSON. */
function buildReportHTML(rows: any[], stats: any, meta: { filtros: string; fecha: string }) {
    const totalRegistros = Number(stats.kpi?.total_registros ?? rows.length)
    const totalPersonas  = Number(stats.kpi?.total_personas  ?? 0).toLocaleString('es-CO')
    const totalFamilias  = Number(stats.kpi?.total_familias  ?? 0).toLocaleString('es-CO')

    // Serializar datos para el script del mapa y las tablas
    const puntos = rows
        .filter(r => r.latitud && r.longitud)
        .map(r => ({
            lat:   +r.latitud,
            lng:   +r.longitud,
            id:    r.id,
            nombre: r.nombre_comunidad,
            tipo:   r.tipo_comunidad  ?? '',
            depto:  r.departamento    ?? '',
            municipio: r.municipio    ?? '',
            personas:  r.numero_personas ?? '',
        }))

    const porTipo  = stats.porTipo  ?? []
    const porDepto = stats.porDepto ?? []

    // Colores por tipo de comunidad
    const colorPorTipo: Record<string, string> = {
        Resguardo_Indigena:   '#16a34a',
        Comunidad_Negra:      '#ca8a04',
        Cabildo:              '#2563eb',
        Parcialidad:          '#db2777',
        Territorio_Colectivo: '#7c3aed',
    }

    // Filas de la tabla (primeras 500 para no saturar el PDF)
    const filas = rows.slice(0, 500).map((r, i) => `
        <tr class="${i % 2 === 1 ? 'alt' : ''}">
            <td>${r.id}</td>
            <td>${r.nombre_comunidad ?? '—'}</td>
            <td>${(r.tipo_comunidad ?? '').replace(/_/g, ' ')}</td>
            <td>${r.pueblo_etnico ?? '—'}</td>
            <td>${r.departamento ?? '—'}</td>
            <td>${r.municipio    ?? '—'}</td>
            <td style="text-align:center">${r.numero_personas ?? '—'}</td>
            <td>${(r.tipo_derecho ?? '—').replace(/_/g, ' ')}</td>
            <td>${(r.validado_por_comunidad ?? '—').replace(/_/g, ' ')}</td>
            <td>${r.fecha_registro ? new Date(r.fecha_registro).toLocaleDateString('es-CO') : '—'}</td>
        </tr>`).join('')

    return /* html */`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #111; background: #fff; }

  /* ── PORTADA ── */
  .portada {
    page-break-after: always;
    min-height: 100vh; display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    background: linear-gradient(160deg, #1b4332 0%, #2d6a4f 60%, #40916c 100%);
    color: #fff; text-align: center; padding: 40px;
  }
  .portada-icon   { font-size: 72px; margin-bottom: 20px; }
  .portada h1     { font-size: 28px; font-weight: 800; margin-bottom: 8px; }
  .portada h2     { font-size: 16px; font-weight: 400; opacity: .85; margin-bottom: 32px; }
  .portada-meta   { font-size: 12px; opacity: .75; line-height: 1.8; }
  .portada-meta b { opacity: 1; }
  .kpi-row        { display: flex; gap: 24px; margin: 32px 0; }
  .kpi-box {
    background: rgba(255,255,255,.18); border-radius: 12px;
    padding: 16px 24px; min-width: 140px;
  }
  .kpi-box .num { font-size: 32px; font-weight: 800; }
  .kpi-box .lbl { font-size: 11px; opacity: .8; margin-top: 4px; }

  /* ── SECCIONES ── */
  .seccion        { page-break-before: always; padding: 20px 0; }
  .sec-titulo {
    font-size: 15px; font-weight: 700; color: #1b4332;
    border-bottom: 3px solid #2d6a4f; padding-bottom: 6px; margin-bottom: 16px;
  }

  /* ── MAPA ── */
  #map-container { page-break-after: always; padding: 20px 0; }
  #map { width: 100%; height: 520px; border-radius: 8px; border: 1px solid #d1d5db; }
  .leyenda {
    display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px;
    font-size: 10px;
  }
  .leyenda-item { display: flex; align-items: center; gap: 5px; }
  .dot { width: 11px; height: 11px; border-radius: 50%; border: 1.5px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.3); }

  /* ── GRÁFICAS ── */
  .charts-grid {
    page-break-after: always;
    display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 20px 0;
  }
  .chart-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
  .chart-card h3 { font-size: 12px; color: #6b7280; margin-bottom: 12px; font-weight: 600; }

  /* ── TABLA ── */
  .tabla-wrapper { padding: 20px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 9.5px; }
  thead th {
    background: #2d6a4f; color: #fff; padding: 6px 5px;
    text-align: left; font-weight: 600;
  }
  tbody td { padding: 5px; border-bottom: 1px solid #e5e7eb; }
  tr.alt td { background: #f0fff4; }

  /* ── PIE ── */
  .pie-pagina {
    position: fixed; bottom: 8mm; left: 0; right: 0;
    text-align: center; font-size: 9px; color: #9ca3af;
  }
  .cabecera-pagina {
    position: fixed; top: 6mm; left: 0; right: 0;
    display: flex; justify-content: space-between;
    font-size: 9px; color: #9ca3af; padding: 0 12mm;
  }

  @page { size: A4; margin: 18mm 12mm 14mm 12mm; }
  @media print {
    .portada { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    thead    { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>

<!-- ════════ PORTADA ════════ -->
<div class="portada">
  <div class="portada-icon">🌿</div>
  <h1>Registro Territorial Comunitario</h1>
  <h2>Catastro Étnico — Colombia</h2>

  <div class="kpi-row">
    <div class="kpi-box"><div class="num">${totalRegistros}</div><div class="lbl">Comunidades registradas</div></div>
    <div class="kpi-box"><div class="num">${totalPersonas}</div><div class="lbl">Personas totales</div></div>
    <div class="kpi-box"><div class="num">${totalFamilias}</div><div class="lbl">Familias totales</div></div>
    <div class="kpi-box"><div class="num">${puntos.length}</div><div class="lbl">Puntos con GPS</div></div>
  </div>

  <div class="portada-meta">
    <div><b>Generado el:</b> ${meta.fecha}</div>
    <div><b>Filtros aplicados:</b> ${meta.filtros || 'Ninguno (todos los registros)'}</div>
    <div style="margin-top:8px;font-size:10px">Alineado con LADM-COL TPC v1.0.0 · Bot WhatsApp Catastro Étnico</div>
  </div>
</div>

<!-- ════════ MAPA ════════ -->
<div id="map-container">
  <div class="sec-titulo">📍 Mapa de distribución territorial</div>
  <div id="map"></div>
  <div class="leyenda">
    ${Object.entries(colorPorTipo).map(([tipo, color]) => `
      <div class="leyenda-item">
        <div class="dot" style="background:${color}"></div>
        <span>${tipo.replace(/_/g, ' ')}</span>
      </div>`).join('')}
  </div>
</div>

<!-- ════════ GRÁFICAS ════════ -->
<div class="charts-grid">
  <div class="chart-card">
    <h3>Distribución por tipo de comunidad</h3>
    <canvas id="chart-tipo" height="220"></canvas>
  </div>
  <div class="chart-card">
    <h3>Registros por departamento (top 15)</h3>
    <canvas id="chart-depto" height="220"></canvas>
  </div>
</div>

<!-- ════════ TABLA ════════ -->
<div class="tabla-wrapper">
  <div class="sec-titulo">📋 Tabla de registros (${rows.length}${rows.length > 500 ? ' — se muestran los primeros 500' : ''})</div>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Comunidad</th><th>Tipo</th><th>Pueblo étnico</th>
        <th>Departamento</th><th>Municipio</th><th style="text-align:center">Personas</th>
        <th>Derecho</th><th>Validación</th><th>Fecha</th>
      </tr>
    </thead>
    <tbody>${filas}</tbody>
  </table>
</div>

<!-- ════════ PIE ════════ -->
<div class="pie-pagina">
  Catastro Étnico Bot · ${meta.fecha} · Confidencial — solo para uso interno
</div>

<!-- ════════ SCRIPTS ════════ -->
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script>
(function() {
  // ── DATOS EMBEBIDOS ──
  const PUNTOS    = ${JSON.stringify(puntos)};
  const POR_TIPO  = ${JSON.stringify(porTipo)};
  const POR_DEPTO = ${JSON.stringify(porDepto)};
  const COLORES   = ${JSON.stringify(colorPorTipo)};

  // ── MAPA ──
  const map = L.map('map', { zoomControl: true, attributionControl: true });
  const tileLayer = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '© OpenStreetMap', maxZoom: 18 }
  );

  let tilesTotal = 0, tilesLoaded = 0;
  let chartsReady = false;

  function checkReady() {
    if (tilesLoaded >= tilesTotal && chartsReady) {
      window.__mapReady = true;
    }
  }

  tileLayer.on('tileloadstart', () => { tilesTotal++; });
  tileLayer.on('tileload',      () => { tilesLoaded++; checkReady(); });
  tileLayer.on('tileerror',     () => { tilesLoaded++; checkReady(); }); // contar errores también
  tileLayer.addTo(map);

  // Marcadores
  const grupo = L.featureGroup();
  PUNTOS.forEach(p => {
    const color = COLORES[p.tipo] || '#374151';
    const icon  = L.divIcon({
      className: '', iconSize: [13, 13], iconAnchor: [6, 6],
      html: '<div style="width:11px;height:11px;border-radius:50%;background:' + color + ';border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>'
    });
    const m = L.marker([p.lat, p.lng], { icon });
    m.bindPopup('<b>' + p.nombre + '</b><br>' + p.tipo.replace(/_/g,' ') + '<br>' + p.municipio + ', ' + p.depto);
    grupo.addLayer(m);
  });
  grupo.addTo(map);

  if (PUNTOS.length > 0) {
    try { map.fitBounds(grupo.getBounds(), { padding: [20, 20], maxZoom: 10 }); }
    catch(_) { map.setView([4.5, -74.0], 5); }
  } else {
    map.setView([4.5, -74.0], 5);
  }

  // Timeout de seguridad por si los tiles tardan mucho
  setTimeout(() => { window.__mapReady = true; }, 15000);

  // ── GRÁFICAS ──
  const GREEN = ['#2d6a4f','#40916c','#52b788','#74c69d','#95d5b2','#b7e4c7','#d8f3dc','#1b4332','#081c15'];

  new Chart(document.getElementById('chart-tipo'), {
    type: 'doughnut',
    data: {
      labels:   POR_TIPO.map(r => r.tipo_comunidad.replace(/_/g,' ')),
      datasets: [{ data: POR_TIPO.map(r => +r.cantidad), backgroundColor: GREEN }]
    },
    options: { animation: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 10 } } } } }
  });

  new Chart(document.getElementById('chart-depto'), {
    type: 'bar',
    data: {
      labels:   POR_DEPTO.slice(0,15).map(r => r.departamento),
      datasets: [{ label: 'Registros', data: POR_DEPTO.slice(0,15).map(r => +r.cantidad), backgroundColor: '#40916c' }]
    },
    options: {
      animation: false, indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { font: { size: 9 } } }, y: { ticks: { font: { size: 9 } } } }
    }
  });

  chartsReady = true;
  checkReady();
})();
</script>
</body>
</html>`
}

/* ──────────────────────────────────────────────────
   ENDPOINT: GET /api/export/pdf
────────────────────────────────────────────────── */
app.get('/api/export/pdf', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { where, params } = buildWhere(req.query)

    try {
        // 1 ── Consultar datos y estadísticas en paralelo
        const [dataRes, kpiRes, porTipoRes, porDeptoRes] = await Promise.all([
            pool.query(`${baseSelect()} ${where} ORDER BY c.fecha_registro DESC LIMIT 500`, params),
            pool.query(`
                SELECT COUNT(*) AS total_registros,
                       COALESCE(SUM(numero_personas), 0) AS total_personas,
                       COALESCE(SUM(numero_familias), 0) AS total_familias
                FROM tpc_interesado_comunidad`),
            pool.query(`
                SELECT tipo_comunidad, COUNT(*) AS cantidad
                FROM tpc_interesado_comunidad
                WHERE tipo_comunidad IS NOT NULL
                GROUP BY tipo_comunidad ORDER BY cantidad DESC`),
            pool.query(`
                SELECT p.departamento, COUNT(*) AS cantidad
                FROM ${TABLA_PREDIO} p
                JOIN tpc_interesado_comunidad c ON c.id = p.comunidad_id
                WHERE p.departamento IS NOT NULL
                GROUP BY p.departamento ORDER BY cantidad DESC LIMIT 15`),
        ])

        const stats = {
            kpi:     kpiRes.rows[0],
            porTipo: porTipoRes.rows,
            porDepto: porDeptoRes.rows,
        }

        // Descripción legible de los filtros aplicados
        const filtros = Object.entries(req.query)
            .filter(([k]) => !['page','limit'].includes(k))
            .map(([k, v]) => `${k}: ${v}`)
            .join(' · ')

        const meta = {
            filtros,
            fecha: new Date().toLocaleString('es-CO', {
                day: '2-digit', month: 'long', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
            }),
        }

        // 2 ── Construir HTML del reporte
        const html = buildReportHTML(dataRes.rows, stats, meta)

        // 3 ── Lanzar Puppeteer
        console.log('🖨️  Iniciando Puppeteer para generar PDF...')
        const browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        })
        const page = await browser.newPage()

        // Viewport amplio para que el mapa y las gráficas se rendericen bien
        await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1.5 })

        // Cargar el HTML directamente (sin network para los datos)
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 })

        // 4 ── Esperar a que el mapa y los charts terminen de renderizarse
        try {
            await page.waitForFunction(
                () => (window as any).__mapReady === true,
                { timeout: 18000 }
            )
            console.log('✅ Mapa y gráficas listos')
        } catch {
            console.warn('⚠️  Timeout esperando mapa — generando PDF con lo disponible')
        }

        // Pequeña pausa adicional para asegurar render de tiles visibles
        await new Promise(r => setTimeout(r, 1200))

        // 5 ── Generar PDF
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '18mm', right: '12mm', bottom: '14mm', left: '12mm' },
            displayHeaderFooter: true,
            headerTemplate: `
                <div style="font-size:8px;color:#9ca3af;width:100%;padding:0 12mm;display:flex;justify-content:space-between">
                    <span>🌿 Catastro Étnico — Registro Territorial Comunitario</span>
                    <span>${meta.fecha}</span>
                </div>`,
            footerTemplate: `
                <div style="font-size:8px;color:#9ca3af;width:100%;padding:0 12mm;display:flex;justify-content:space-between">
                    <span>Confidencial — solo para uso interno</span>
                    <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
                </div>`,
        })

        await browser.close()
        console.log(`✅ PDF generado (${(pdf.byteLength / 1024).toFixed(0)} KB)`)

        // 6 ── Enviar al cliente
        const filename = `catastro_etnico_${Date.now()}.pdf`
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
        res.setHeader('Content-Length', pdf.byteLength)
        res.send(Buffer.from(pdf))

    } catch (err) {
        console.error('❌ Error generando PDF:', (err as Error).message)
        res.status(500).json({ error: 'Error generando PDF: ' + (err as Error).message })
    }
})

/* =====================================================
   🗺️  PLANCHA CARTOGRÁFICA  (PDF tipo levantamiento)
   =====================================================

   El PDF que había era un informe de gestión: listados, KPIs y gráficas
   de toda la base. Sirve para mirar el avance, pero no es el documento
   que una comunidad necesita tener en la mano, ni el que se parece a lo
   que produce el IGAC en un levantamiento.

   Aquí se agregan dos modalidades más:

     · PREDIO    — una plancha del predio colectivo de una comunidad, con
                   sus colindantes alrededor, la retícula de coordenadas,
                   la ficha completa del registro y el cuadro de vértices.

     · TERRITORIO— el territorio con TODOS los predios que lo componen
                   (el colectivo y las parcelas familiares), cada uno
                   dibujado y descrito, con el consolidado de superficies.

   El mapa se dibuja como SVG generado aquí mismo a partir de las
   geometrías de PostGIS. No se usan tiles ni Leaflet a propósito: el PDF
   tiene que salir igual aunque el servidor no tenga internet, y un plano
   de levantamiento no lleva fotografía aérea de fondo, lleva el lindero
   sobre papel blanco con su retícula.
===================================================== */

/* ──────────────── Coordenadas en grados, minutos y segundos ────────────────
   El plano de referencia rotula así: 74° 04' 16" W / 4° 38' 06" N. */
function gradosMinSeg(valor: number, eje: 'lat' | 'lon'): string {
    const hemisferio = eje === 'lat' ? (valor >= 0 ? 'N' : 'S')
                                     : (valor >= 0 ? 'E' : 'W')
    const abs  = Math.abs(valor)
    const g    = Math.floor(abs)
    const minF = (abs - g) * 60
    const m    = Math.floor(minF)
    const s    = Math.round((minF - m) * 60)

    // El redondeo de los segundos puede dar 60: se arrastra al minuto.
    let gg = g, mm = m, ss = s
    if (ss === 60) { ss = 0; mm += 1 }
    if (mm === 60) { mm = 0; gg += 1 }

    const dosDig = (n: number) => String(n).padStart(2, '0')
    return `${gg}° ${dosDig(mm)}' ${dosDig(ss)}" ${hemisferio}`
}

/* Paso de la retícula. Se elige entre valores redondos en segundos de arco
   para que los rótulos caigan en números legibles y no en 4° 38' 06,37". */
const PASOS_SEG = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]

function pasoReticula(span: number): number {
    const objetivo = span / 4                 // unas 4 líneas por eje
    const seg      = objetivo * 3600
    return (PASOS_SEG.find(p => p >= seg) ?? PASOS_SEG[PASOS_SEG.length - 1]) / 3600
}

/* Recorre un GeoJSON de polígono y entrega sus anillos como listas de
   pares [lon, lat], sin importar si venía como Polygon o MultiPolygon. */
function anillosDe(geom: any): number[][][] {
    if (!geom) return []
    if (geom.type === 'Polygon')      return geom.coordinates
    if (geom.type === 'MultiPolygon') return geom.coordinates.flat()
    return []
}

function centroideDe(anillos: number[][][]): [number, number] {
    const pts = anillos.flat()
    if (!pts.length) return [0, 0]
    // Centroide del área, no de los vértices: en un lindero con muchos
    // puntos juntos en un lado, el promedio simple corre la etiqueta hacia
    // ese lado y termina fuera del polígono.
    const anillo = anillos[0]
    let a = 0, cx = 0, cy = 0
    for (let i = 0, n = anillo.length - 1; i < n; i++) {
        const [x1, y1] = anillo[i]
        const [x2, y2] = anillo[i + 1]
        const f = x1 * y2 - x2 * y1
        a  += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    }
    if (Math.abs(a) < 1e-12) {
        const s = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0])
        return [s[0] / pts.length, s[1] / pts.length]
    }
    a *= 0.5
    return [cx / (6 * a), cy / (6 * a)]
}

function escaparXML(s: any): string {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' } as any)[c])
}

interface PiezaPlancha {
    geom:      any        // GeoJSON
    etiqueta?: string     // nombre que va debajo (el predio)
    titulo?:   string     // nombre en cursiva encima (el interesado)
    principal?: boolean   // el predio objeto del levantamiento
}

/* ──────────────── El dibujo ────────────────
   Proyección equirectangular con corrección por coseno de la latitud: a
   la escala de un predio la deformación es despreciable, y evita depender
   de proj4 o de una reproyección en la base. */
function dibujarPlancha(
    piezas: PiezaPlancha[],
    ancho = 720,
    alto  = 470,
    /* En la plancha de predio el protagonista va ENCIMA: es el objeto del
       levantamiento y ningún vecino debe taparlo. En la de territorio va
       DEBAJO: el colectivo es el contenedor, y si se dibuja encima cubre
       con su relleno las parcelas familiares que están dentro de él. */
    principalAlFondo = false,
    /* Encuadre. Por defecto el plano abarca todo lo que se dibuja. En una
       parcela familiar eso no sirve: entre los colindantes está el lindero
       del territorio entero, que es cientos de veces más grande, y la
       parcela acabaría como una mancha diminuta en el centro. Con esto el
       encuadre lo fija el predio objeto del levantamiento y lo demás se
       dibuja alrededor, saliéndose del marco si hace falta. */
    encuadrarEnPrincipal = false,
): string {
    const conGeom = piezas.filter(p => anillosDe(p.geom).length)
    if (!conGeom.length) {
        return `<div class="sin-mapa">Este registro todavía no tiene el lindero capturado,
                por eso la plancha sale sin dibujo.</div>`
    }

    // 1 ── Extensión: la de todo, o la del predio principal si se pidió
    //      encuadrar en él.
    const paraEncuadre = encuadrarEnPrincipal
        ? (conGeom.filter(p => p.principal).length ? conGeom.filter(p => p.principal) : conGeom)
        : conGeom
    const todos = paraEncuadre.flatMap(p => anillosDe(p.geom).flat())
    let minLon = Math.min(...todos.map(c => c[0]))
    let maxLon = Math.max(...todos.map(c => c[0]))
    let minLat = Math.min(...todos.map(c => c[1]))
    let maxLat = Math.max(...todos.map(c => c[1]))

    // Margen del 12% para que el lindero no quede pegado al marco y quepan
    // los nombres de los colindantes.
    // Al encuadrar en el predio se deja más aire: el lindero del territorio
    // y las parcelas vecinas tienen que asomar para dar contexto.
    const margen = encuadrarEnPrincipal ? 0.45 : 0.12
    const dLon = (maxLon - minLon) || 0.001
    const dLat = (maxLat - minLat) || 0.001
    minLon -= dLon * margen; maxLon += dLon * margen
    minLat -= dLat * margen; maxLat += dLat * margen

    const latMedia = (minLat + maxLat) / 2
    const kx       = Math.cos(latMedia * Math.PI / 180)   // grados de lon → grados equivalentes

    // 2 ── Escala común para los dos ejes, para no deformar el predio
    const anchoGeo = (maxLon - minLon) * kx
    const altoGeo  =  maxLat - minLat
    const pad      = 46                                   // sitio para los rótulos del marco
    const escala   = Math.min((ancho - pad * 2) / anchoGeo, (alto - pad * 2) / altoGeo)

    const cxGeo = (minLon + maxLon) / 2
    const cyGeo = (minLat + maxLat) / 2
    const X = (lon: number) => ancho / 2 + (lon - cxGeo) * kx * escala
    const Y = (lat: number) => alto  / 2 - (lat - cyGeo) * escala

    const partes: string[] = []

    // 3 ── Retícula de coordenadas
    const pasoLon = pasoReticula(maxLon - minLon)
    const pasoLat = pasoReticula(maxLat - minLat)

    const rotulos: string[] = []
    for (let lon = Math.ceil(minLon / pasoLon) * pasoLon; lon <= maxLon; lon += pasoLon) {
        const x = X(lon)
        if (x < 4 || x > ancho - 4) continue
        partes.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${alto}" class="grid"/>`)
        rotulos.push(`<text x="${x.toFixed(1)}" y="${alto - 8}" class="rot" text-anchor="middle">${gradosMinSeg(lon, 'lon')}</text>`)
    }
    for (let lat = Math.ceil(minLat / pasoLat) * pasoLat; lat <= maxLat; lat += pasoLat) {
        const y = Y(lat)
        if (y < 4 || y > alto - 4) continue
        partes.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${ancho}" y2="${y.toFixed(1)}" class="grid"/>`)
        rotulos.push(`<text x="${ancho - 6}" y="${(y - 5).toFixed(1)}" class="rot" text-anchor="end">${gradosMinSeg(lat, 'lat')}</text>`)
    }

    // 4 ── Polígonos, en el orden que corresponda a la modalidad.
    const enOrden = principalAlFondo
        ? [...conGeom.filter(p =>  p.principal), ...conGeom.filter(p => !p.principal)]
        : [...conGeom.filter(p => !p.principal), ...conGeom.filter(p =>  p.principal)]

    for (const pieza of enOrden) {
        const d = anillosDe(pieza.geom).map(anillo =>
            'M ' + anillo.map(([lon, lat]) => `${X(lon).toFixed(1)},${Y(lat).toFixed(1)}`).join(' L ') + ' Z'
        ).join(' ')
        partes.push(`<path d="${d}" class="${pieza.principal ? 'predio' : 'vecino'}" fill-rule="evenodd"/>`)
    }

    // 5 ── Etiquetas encima de todos los polígonos
    for (const pieza of enOrden) {
        const [lon, lat] = centroideDe(anillosDe(pieza.geom))
        const x = X(lon), y = Y(lat)

        if (pieza.principal) {
            // Recuadro redondeado como el del plano de referencia. El ancho
            // se estima por número de caracteres: no hay métrica de fuente
            // disponible al generar el SVG del lado del servidor.
            const texto = pieza.etiqueta || 'Predio'
            const w = Math.max(38, texto.length * 6.4 + 14)
            partes.push(`
                <rect x="${(x - w / 2).toFixed(1)}" y="${(y - 9).toFixed(1)}" width="${w.toFixed(1)}" height="18"
                      rx="9" class="caja-predio"/>
                <text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" class="eti-predio" text-anchor="middle">${escaparXML(texto)}</text>`)
        } else {
            if (pieza.titulo) {
                partes.push(`<text x="${x.toFixed(1)}" y="${(y - 3).toFixed(1)}" class="eti-vecino-tit" text-anchor="middle">${escaparXML(pieza.titulo)}</text>`)
            }
            if (pieza.etiqueta) {
                partes.push(`<text x="${x.toFixed(1)}" y="${(y + (pieza.titulo ? 9 : 3)).toFixed(1)}" class="eti-vecino" text-anchor="middle">${escaparXML(pieza.etiqueta)}</text>`)
            }
        }
    }

    // 6 ── Escala gráfica: sin ella el plano no dice de qué tamaño es nada
    const metrosPorGrado = 111320
    const anchoUtilM     = anchoGeo * metrosPorGrado
    const objetivoM      = anchoUtilM / 5
    const pot            = Math.pow(10, Math.floor(Math.log10(objetivoM)))
    const barraM         = [1, 2, 5, 10].map(f => f * pot).find(v => v >= objetivoM) ?? pot * 10
    const barraPx        = (barraM / metrosPorGrado) * escala
    const bx = 14, by = alto - 24

    partes.push(`
        <g class="escala">
            <line x1="${bx}" y1="${by}" x2="${(bx + barraPx).toFixed(1)}" y2="${by}"/>
            <line x1="${bx}" y1="${by - 4}" x2="${bx}" y2="${by + 4}"/>
            <line x1="${(bx + barraPx).toFixed(1)}" y1="${by - 4}" x2="${(bx + barraPx).toFixed(1)}" y2="${by + 4}"/>
            <text x="${(bx + barraPx / 2).toFixed(1)}" y="${by - 7}" text-anchor="middle" class="rot">
                ${barraM >= 1000 ? (barraM / 1000) + ' km' : barraM + ' m'}
            </text>
        </g>
        <g class="norte" transform="translate(30, 30)">
            <path d="M 0,-13 L 5,7 L 0,2 L -5,7 Z"/>
            <text y="19" text-anchor="middle" class="rot-n">N</text>
        </g>`)

    return `
    <svg class="plancha" viewBox="0 0 ${ancho} ${alto}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${ancho}" height="${alto}" fill="#ffffff"/>
        ${partes.join('\n')}
        ${rotulos.join('\n')}
        <rect width="${ancho}" height="${alto}" fill="none" stroke="#cfd4d9" stroke-width="1"/>
    </svg>`
}

/* ──────────────── Estilos de la plancha ────────────────
   Papel blanco, tipografía de documento oficial y colores sobrios: es un
   documento que se imprime y se archiva, no una pantalla. */
const CSS_PLANCHA = `
  @page { size: A4 portrait; margin: 12mm 10mm 14mm 10mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 9.2px; color: #1f2937; margin: 0; background: #fff;
  }
  h1.titulo {
    font-size: 15px; margin: 0 0 2px; letter-spacing: .3px; color: #0f172a;
  }
  .subtitulo { font-size: 9px; color: #6b7280; margin-bottom: 10px; }
  .marca {
    display: flex; justify-content: space-between; align-items: flex-end;
    border-bottom: 2px solid #15803d; padding-bottom: 6px; margin-bottom: 10px;
  }
  .marca .sello {
    font-size: 8px; color: #15803d; text-align: right; line-height: 1.45;
  }

  /* Encabezado de identificación, como el del plano de referencia */
  table.identificacion {
    width: 100%; border-collapse: collapse; margin-bottom: 10px;
    border: 1px solid #d7dce1; border-radius: 3px;
  }
  table.identificacion td { padding: 4.5px 8px; vertical-align: top; width: 25%; }
  table.identificacion td.et { color: #1f2937; font-weight: 600; width: 16%; }
  table.identificacion td.va { color: #2563eb; }
  table.identificacion tr + tr td { border-top: 1px solid #eef1f4; }

  /* El dibujo */
  .caja-mapa { border: 1px solid #d7dce1; margin-bottom: 9px; }
  svg.plancha { display: block; width: 100%; height: auto; }
  svg .grid { stroke: #e3e7eb; stroke-width: 1; }
  svg .rot  { font-size: 8px; fill: #4b5563; font-family: inherit; }
  svg .rot-n{ font-size: 9px; fill: #374151; font-weight: 700; font-family: inherit; }
  svg .vecino { fill: #e8eaec; stroke: #9aa3ab; stroke-width: 1; }
  svg .predio { fill: #f9d7db; stroke: #d6455b; stroke-width: 1.6; }
  svg .caja-predio { fill: #fdeff1; stroke: #d6455b; stroke-width: 1.2; }
  svg .eti-predio { font-size: 8.5px; fill: #b02a3c; font-weight: 700; font-family: inherit; }
  svg .eti-vecino { font-size: 8px; fill: #374151; font-family: inherit; }
  svg .eti-vecino-tit { font-size: 8px; fill: #374151; font-style: italic; font-family: inherit; }
  svg .escala line { stroke: #374151; stroke-width: 1.2; }
  svg .norte path  { fill: #374151; }
  .sin-mapa {
    padding: 34px 18px; text-align: center; color: #9ca3af; font-style: italic;
    border: 1px dashed #d7dce1; font-size: 9.5px;
  }

  .nota-pie {
    border: 1px solid #d7dce1; padding: 7px 9px; font-size: 8.4px; color: #4b5563;
    line-height: 1.5; margin-bottom: 12px; background: #fbfcfd;
  }

  /* Secciones de datos */
  h2.sec {
    font-size: 10px; text-transform: uppercase; letter-spacing: .6px;
    color: #15803d; border-bottom: 1px solid #d7f0dc; padding-bottom: 3px;
    margin: 13px 0 7px;
  }
  table.datos { width: 100%; border-collapse: collapse; }
  table.datos td { padding: 3.4px 7px; vertical-align: top; border-bottom: 1px solid #f1f3f5; }
  table.datos td.k { width: 27%; color: #6b7280; }
  table.datos td.v { color: #111827; font-weight: 500; }
  .dos-col { display: flex; gap: 14px; }
  .dos-col > * { flex: 1; min-width: 0; }

  /* Cuadros numéricos */
  table.cuadro { width: 100%; border-collapse: collapse; font-size: 8.3px; }
  table.cuadro th {
    background: #f1f5f9; color: #334155; text-align: left; font-weight: 600;
    padding: 4px 6px; border: 1px solid #e2e8f0; white-space: nowrap;
  }
  table.cuadro td { padding: 3.2px 6px; border: 1px solid #eef1f4; }
  table.cuadro td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.cuadro tr:nth-child(even) td { background: #fafbfc; }

  .kpis { display: flex; gap: 8px; margin-bottom: 4px; }
  .kpi {
    flex: 1; border: 1px solid #e2e8f0; border-radius: 4px; padding: 7px 9px; background: #fbfcfd;
  }
  .kpi .n { font-size: 14px; font-weight: 700; color: #0f172a; font-variant-numeric: tabular-nums; }
  .kpi .e { font-size: 7.6px; color: #6b7280; text-transform: uppercase; letter-spacing: .4px; }
  .kpi .d { font-size: 7.6px; margin-top: 2px; }
  .kpi .d.ok   { color: #15803d; }
  .kpi .d.alto { color: #b45309; }

  .vacio { color: #9ca3af; font-style: italic; }
  .salto { page-break-before: always; }
  .juntos { page-break-inside: avoid; }
`

/* Formateo compartido: el guión largo marca «no se capturó», que en un
   documento oficial no es lo mismo que un cero. */
const val = (v: any): string =>
    (v === null || v === undefined || v === '') ? '<span class="vacio">—</span>' : escaparXML(v)

const num = (v: any, dec = 2): string =>
    (v === null || v === undefined || v === '')
        ? '<span class="vacio">—</span>'
        : Number(v).toLocaleString('es-CO', { minimumFractionDigits: dec, maximumFractionDigits: dec })

const legible = (v: any): string =>
    (v === null || v === undefined || v === '')
        ? '<span class="vacio">—</span>'
        : escaparXML(String(v).replace(/_/g, ' '))

const fila = (k: string, v: string) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`

/* ──────────────── Cuadro de coordenadas de los vértices ────────────────
   Sale de la topología LADM que ya construye migrate_ladm.sql: cada
   vértice con su posición, su exactitud y la distancia al siguiente. */
function cuadroVertices(vertices: any[]): string {
    if (!vertices.length) {
        return `<p class="vacio">El lindero no tiene vértices registrados en la topología.
                Se generan solos cuando el predio tiene perímetro capturado.</p>`
    }

    // Más de 60 vértices en un recorrido GPS llenarían páginas enteras de
    // números sin que nadie los lea; se muestra el arranque y se dice
    // cuántos quedaron fuera.
    const TOPE   = 60
    const visibles = vertices.slice(0, TOPE)
    const restan   = vertices.length - visibles.length

    return `
    <table class="cuadro">
      <thead>
        <tr>
          <th>Vértice</th><th>Anillo</th><th>Latitud</th><th>Longitud</th>
          <th>Exactitud</th><th>Tramo hasta el siguiente</th><th>Qué hay en el tramo</th>
        </tr>
      </thead>
      <tbody>
        ${visibles.map(v => `
          <tr>
            <td>${escaparXML(v.etiqueta || v.orden)}</td>
            <td>${v.anillo === 0 ? 'Exterior' : 'Hueco ' + v.anillo}</td>
            <td class="num">${gradosMinSeg(+v.lat, 'lat')}</td>
            <td class="num">${gradosMinSeg(+v.lon, 'lon')}</td>
            <td class="num">${v.exactitud_horizontal != null ? (+v.exactitud_horizontal).toFixed(1) + ' m' : '—'}</td>
            <td class="num">${v.longitud_m != null ? (+v.longitud_m).toFixed(1) + ' m' : '—'}</td>
            <td>${v.descripcion_lindero ? escaparXML(v.descripcion_lindero) : '<span class="vacio">sin describir</span>'}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${restan > 0 ? `<p style="font-size:8px;color:#6b7280;margin-top:5px">
        Se muestran los primeros ${TOPE} vértices de ${vertices.length}.
        El lindero completo está en la base de datos (col_punto) y en el GeoJSON exportable.</p>` : ''}`
}

/* ──────────────── Superficies medidas ────────────────
   La comparación entre lo medido y lo declarado es el dato que más se
   discute en un proceso de reconocimiento, así que va destacado arriba. */
function cuadroSuperficies(p: any): string {
    const real = p.area_real_ha != null ? +p.area_real_ha : null
    const decl = p.area_ha      != null ? +p.area_ha      : null
    const dif  = (real != null && decl != null) ? real - decl : null
    const pct  = (dif != null && decl) ? (dif / decl) * 100  : null

    return `
    <div class="kpis juntos">
      <div class="kpi">
        <div class="e">Área medida</div>
        <div class="n">${real != null ? num(real) : '—'}</div>
        <div class="d">hectáreas sobre el polígono</div>
      </div>
      <div class="kpi">
        <div class="e">Área declarada</div>
        <div class="n">${decl != null ? num(decl) : '—'}</div>
        <div class="d">hectáreas del acto administrativo</div>
      </div>
      <div class="kpi">
        <div class="e">Diferencia</div>
        <div class="n">${dif != null ? (dif >= 0 ? '+' : '−') + num(Math.abs(dif)) : '—'}</div>
        <div class="d ${pct != null && Math.abs(pct) > 10 ? 'alto' : 'ok'}">
          ${pct != null ? (pct >= 0 ? '+' : '−') + Math.abs(pct).toFixed(1) + '% respecto a lo declarado' : 'sin comparación posible'}
        </div>
      </div>
      <div class="kpi">
        <div class="e">Lindero</div>
        <div class="n">${p.perimetro_km != null ? num(p.perimetro_km, 3) : '—'}</div>
        <div class="d">kilómetros de perímetro</div>
      </div>
    </div>
    <p style="font-size:7.8px;color:#6b7280;margin:4px 0 0">
      Superficie y perímetro calculados con PostGIS sobre el elipsoide WGS-84 a partir del
      polígono capturado por la comunidad (${legible(p.metodo || p.metodo_captura_perimetro) || 'método sin registrar'}).
      No sustituyen un levantamiento topográfico con equipo certificado.
    </p>`
}

/* ──────────────── Encabezado de identificación ──────────────── */
function encabezadoIdentificacion(p: any, esParcela = false): string {
    /* En una parcela familiar el interesado no es la comunidad sino el
       hogar que la ocupa: es su jefe o jefa de hogar quien firma y a quien
       se le entrega el documento. La comunidad pasa a ser el territorio
       dentro del cual está la parcela, y se muestra en su propia fila. */
    const interesado = esParcela
        ? (p.jefe_hogar || p.nombre_familia || p.nombre_comunidad)
        : p.nombre_comunidad
    const documento = esParcela
        ? (p.documento_jefe_hogar || p.numero_documento_representante)
        : p.numero_documento_representante

    return `
    <table class="identificacion">
      <tr>
        <td class="et">Municipio:</td>          <td class="va">${val(p.municipio)}</td>
        <td class="et">Vereda:</td>             <td class="va">${val(p.vereda || p.corregimiento)}</td>
      </tr>
      <tr>
        <td class="et">Nombre del Interesado:</td><td class="va">${val(interesado)}</td>
        <td class="et">Documento:</td>          <td class="va">${val(documento)}</td>
      </tr>
      ${esParcela ? `
      <tr>
        <td class="et">Territorio colectivo:</td><td class="va">${val(p.nombre_comunidad)}</td>
        <td class="et">Familia:</td>            <td class="va">${val(p.nombre_familia)}</td>
      </tr>` : ''}
      <tr>
        <td class="et">Nombre del Predio:</td>  <td class="va">${val(p.nombre_predio || p.nombre_territorio)}</td>
        <td class="et">Cédula Catastral:</td>   <td class="va">${val(p.numero_predial)}</td>
      </tr>
      <tr>
        <td class="et">Folio de Matrícula:</td> <td class="va">${val(p.matricula_inmobiliaria)}</td>
        <td class="et">Código del registro:</td><td class="va">${val(p.local_id || p.nupre)}</td>
      </tr>
    </table>`
}

/* ──────────────── Ficha completa del registro ──────────────── */
function fichaCompleta(p: any, extras: any): string {
    return `
    <h2 class="sec">Comunidad e interesado</h2>
    <div class="dos-col">
      <table class="datos">
        ${fila('Comunidad',        val(p.nombre_comunidad))}
        ${fila('Tipo',             legible(p.tipo_comunidad))}
        ${fila('Pueblo o grupo',   val(p.pueblo_etnico))}
        ${fila('Familias',         val(p.numero_familias))}
        ${fila('Personas',         val(p.numero_personas))}
      </table>
      <table class="datos">
        ${fila('Mujeres',          val(p.numero_mujeres))}
        ${fila('Hombres',          val(p.numero_hombres))}
        ${fila('Autoridades',      val(p.nombres_autoridades))}
        ${fila('Cargo',            legible(p.cargo))}
        ${fila('Legitimidad',      legible(p.legitimidad))}
      </table>
    </div>

    <h2 class="sec">Territorio y predio</h2>
    <div class="dos-col">
      <table class="datos">
        ${fila('Territorio',       val(p.nombre_territorio))}
        ${fila('Procedimiento',    legible(p.tipo_procedimiento))}
        ${fila('Departamento',     val(p.departamento))}
        ${fila('Municipio',        val(p.municipio))}
        ${fila('Vereda',           val(p.vereda))}
        ${fila('Corregimiento',    val(p.corregimiento))}
      </table>
      <table class="datos">
        ${fila('Reconocimiento',   legible(p.reconocimiento_estado))}
        ${fila('Tipo de lindero',  legible(p.limites_territorio))}
        ${fila('Zonas especiales', val(p.zonas_especiales))}
        ${fila('Método de captura',legible(p.metodo_captura_perimetro || p.metodo))}
        ${fila('Punto de referencia', (p.latitud && p.longitud)
            ? `${gradosMinSeg(+p.latitud, 'lat')} · ${gradosMinSeg(+p.longitud, 'lon')}`
            : '<span class="vacio">—</span>')}
      </table>
    </div>

    <h2 class="sec">Derechos, restricciones y fuentes</h2>
    <div class="dos-col">
      <table class="datos">
        ${fila('Tipo de derecho',    legible(p.tipo_derecho))}
        ${fila('Restricción',        legible(p.tipo_restriccion))}
      </table>
      <table class="datos">
        ${fila('Fuente espacial',    legible(p.tipo_fuente_espacial))}
        ${fila('Número de plano',    val(p.numero_plano))}
      </table>
    </div>
    ${extras.fuentes?.length ? `
      <table class="cuadro" style="margin-top:6px">
        <thead><tr><th>Acto administrativo</th><th>Número</th><th>Fecha</th><th>Entidad</th></tr></thead>
        <tbody>
          ${extras.fuentes.map((f: any) => `
            <tr>
              <td>${legible(f.tipo_acto_administrativo || f.tipo_fuente)}</td>
              <td>${val(f.numero_acto_administrativo)}</td>
              <td>${f.fecha_acto_administrativo ? new Date(f.fecha_acto_administrativo).toLocaleDateString('es-CO') : '—'}</td>
              <td>${val(f.entidad_emisora)}</td>
            </tr>`).join('')}
        </tbody>
      </table>` : ''}

    <h2 class="sec">Historia, uso y validación comunitaria</h2>
    <table class="datos">
      ${fila('Antigüedad en el territorio', val(p.antiguedad_territorio))}
      ${fila('Tipo de uso',                 legible(p.tipo_uso))}
      ${fila('Reglas internas',             val(p.reglas_internas))}
      ${fila('Validado por la comunidad',   p.validado_por_comunidad === true ? 'Sí'
                                          : p.validado_por_comunidad === false ? 'No'
                                          : '<span class="vacio">sin registrar</span>')}
      ${fila('Consentimiento informado',    p.consentimiento === true ? 'Otorgado'
                                          : p.consentimiento === false ? 'No otorgado'
                                          : '<span class="vacio">sin registrar</span>')}
      ${fila('Observaciones finales',       val(p.observaciones_finales))}
    </table>
    ${p.descripcion_historia ? `
      <p style="margin:6px 0 0;line-height:1.55;text-align:justify">
        <b style="color:#6b7280">Historia del territorio, en palabras de la comunidad:</b><br>
        ${escaparXML(p.descripcion_historia)}
      </p>` : ''}`
}

/* ──────────────── Documento: MODALIDAD PREDIO ────────────────
   Una plancha de un predio con sus vecinos dibujados alrededor como
   colindantes. Sirve para los dos niveles de tenencia:

     · el predio COLECTIVO de la comunidad, y
     · una PARCELA FAMILIAR, donde el objeto principal del plano es la
       parcela y el interesado es su jefe o jefa de hogar.

   Es el mismo documento porque es el mismo tipo de trámite: un predio en
   el centro, quiénes lo rodean, y cuánto mide. Lo único que cambia es a
   nombre de quién sale. */
function documentoPredio(d: {
    predio: any; colindantes: any[]; vertices: any[]; fuentes: any[]; fecha: string
    esParcela?: boolean
}): string {
    const p         = d.predio
    const esParcela = !!d.esParcela

    const nombrePrincipal = esParcela
        ? (p.nombre_predio || p.nombre_familia || p.jefe_hogar || 'Parcela')
        : (p.nombre_predio || p.nombre_comunidad)

    const piezas: PiezaPlancha[] = [
        { geom: p.poligono, etiqueta: nombrePrincipal, principal: true },
        ...d.colindantes.map(c => ({
            geom:     c.poligono,
            titulo:   c.interesado,
            etiqueta: c.nombre_predio,
        })),
    ]

    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><style>${CSS_PLANCHA}</style></head><body>

  <div class="marca">
    <div>
      <h1 class="titulo">${esParcela ? 'Plancha de la parcela familiar' : 'Plancha del predio colectivo'}</h1>
      <div class="subtitulo">Catastro étnico · ${esParcela
        ? 'Tenencia familiar dentro del territorio colectivo'
        : 'Registro territorial comunitario'}</div>
    </div>
    <div class="sello">
      Expedido el ${escaparXML(d.fecha)}<br>
      Registro N° ${escaparXML(p.local_id || p.id)}
    </div>
  </div>

  ${encabezadoIdentificacion(p, esParcela)}

  <div class="caja-mapa">${dibujarPlancha(piezas, 720, 470, false, esParcela)}</div>

  <div class="nota-pie">
    ${esParcela ? `
      El polígono resaltado es la parcela familiar objeto de este documento; los polígonos en gris
      son las parcelas vecinas y el lindero del territorio colectivo que la contiene, rotulados con
      su hogar. La parcela describe la tenencia interna reconocida por la propia comunidad: el
      derecho sobre el territorio sigue siendo colectivo y esta parcela no constituye un predio
      independiente ni es susceptible de venta a terceros.` : `
      El polígono resaltado corresponde al predio objeto de este documento; los polígonos en gris
      son los predios colindantes registrados en el catastro étnico, rotulados con su interesado y
      su nombre.`}
    El lindero fue capturado por la propia comunidad
    (${legible(p.metodo_captura_perimetro)}) y su superficie se calculó con PostGIS sobre el
    elipsoide WGS-84. Este documento da cuenta de lo declarado y medido por la comunidad; no
    constituye por sí mismo título de propiedad ni levantamiento topográfico certificado.
  </div>

  <h2 class="sec">Superficie y lindero medidos</h2>
  ${cuadroSuperficies(p)}

  ${d.colindantes.length ? `
    <h2 class="sec">Colindantes</h2>
    <table class="cuadro">
      <thead><tr><th>Predio colindante</th><th>Interesado</th><th>Nivel</th><th>Municipio</th><th>Área medida (ha)</th></tr></thead>
      <tbody>
        ${d.colindantes.map(c => `
          <tr>
            <td>${val(c.nombre_predio)}</td>
            <td>${val(c.interesado)}</td>
            <td>${c.nivel === 'Familiar' ? 'Parcela familiar' : 'Predio colectivo'}</td>
            <td>${val(c.municipio)}</td>
            <td class="num">${num(c.area_real_ha)}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : `
    <h2 class="sec">Colindantes</h2>
    <p class="vacio">No hay predios colindantes registrados en el catastro étnico alrededor de este lindero.</p>`}

  ${esParcela ? `
    <h2 class="sec">Hogar que ocupa la parcela</h2>
    <div class="dos-col">
      <table class="datos">
        ${fila('Familia',           val(p.nombre_familia))}
        ${fila('Jefe de hogar',     val(p.jefe_hogar))}
        ${fila('Personas',          val(p.personas_familia))}
        ${fila('Mujeres',           val(p.mujeres_familia))}
      </table>
      <table class="datos">
        ${fila('Hombres',           val(p.hombres_familia))}
        ${fila('Antigüedad ocupando', val(p.antiguedad_ocupacion))}
        ${fila('Origen de la asignación', legible(p.origen_asignacion))}
        ${fila('Derecho sobre la parcela', legible(p.tipo_derecho))}
      </table>
    </div>` : ''}

  <div class="salto"></div>
  <h2 class="sec">${esParcela
    ? 'Ficha del territorio colectivo al que pertenece'
    : 'Ficha completa del registro'}</h2>
  ${fichaCompleta(p, { fuentes: d.fuentes })}

  <div class="salto"></div>
  <h2 class="sec">Cuadro de coordenadas de los vértices del lindero</h2>
  ${cuadroVertices(d.vertices)}

</body></html>`
}

/* ──────────────── Documento: MODALIDAD TERRITORIO ────────────────
   El territorio completo con todos los predios que lo componen: el
   colectivo y las parcelas familiares, cada uno dibujado y descrito. */
function documentoTerritorio(d: {
    predio: any; predios: any[]; vertices: any[]; fuentes: any[]; familias: any[]; fecha: string
}): string {
    const p = d.predio

    // El colectivo se resalta; las parcelas familiares van en gris con el
    // nombre de su hogar, que es lo que permite leer el territorio por dentro.
    const piezas: PiezaPlancha[] = d.predios.map(x => ({
        geom:      x.poligono,
        etiqueta:  x.nivel === 'Familiar' ? (x.nombre_predio || x.familia) : (x.nombre_predio || p.nombre_comunidad),
        titulo:    x.nivel === 'Familiar' ? x.familia : undefined,
        principal: x.nivel !== 'Familiar',
    }))

    const familiares   = d.predios.filter(x => x.nivel === 'Familiar')
    const haFamiliares = familiares.reduce((s, x) => s + (+x.area_real_ha || 0), 0)
    const haColectivo  = p.area_real_ha != null ? +p.area_real_ha : null
    const cobertura    = (haColectivo && haColectivo > 0) ? (haFamiliares / haColectivo) * 100 : null

    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><style>${CSS_PLANCHA}</style></head><body>

  <div class="marca">
    <div>
      <h1 class="titulo">Plancha del territorio colectivo</h1>
      <div class="subtitulo">Catastro étnico · Territorio y predios que lo componen</div>
    </div>
    <div class="sello">
      Expedido el ${escaparXML(d.fecha)}<br>
      Registro N° ${escaparXML(p.local_id || p.id)}
    </div>
  </div>

  ${encabezadoIdentificacion(p)}

  <div class="caja-mapa">${dibujarPlancha(piezas, 720, 520, true)}</div>

  <div class="nota-pie">
    El polígono resaltado es el perímetro del territorio colectivo; los polígonos en gris son las
    parcelas familiares registradas dentro de él, rotuladas con el hogar que las ocupa. El
    territorio colectivo es la unidad de derecho; las parcelas familiares describen la tenencia
    interna reconocida por la propia comunidad y no constituyen predios independientes.
  </div>

  <h2 class="sec">Superficie del territorio colectivo</h2>
  ${cuadroSuperficies(p)}

  <div class="kpis juntos" style="margin-top:8px">
    <div class="kpi">
      <div class="e">Predios que lo componen</div>
      <div class="n">${d.predios.length}</div>
      <div class="d">${familiares.length} parcela(s) familiar(es) + 1 colectivo</div>
    </div>
    <div class="kpi">
      <div class="e">Superficie familiar</div>
      <div class="n">${num(haFamiliares)}</div>
      <div class="d">hectáreas medidas en parcelas</div>
    </div>
    <div class="kpi">
      <div class="e">Cobertura interna</div>
      <div class="n">${cobertura != null ? cobertura.toFixed(1) + '%' : '—'}</div>
      <div class="d ${cobertura != null && cobertura > 100 ? 'alto' : 'ok'}">
        ${cobertura != null && cobertura > 100
          ? 'las parcelas suman más que el colectivo: hay traslapes'
          : 'del territorio colectivo está repartido en parcelas'}
      </div>
    </div>
    <div class="kpi">
      <div class="e">Personas en parcelas</div>
      <div class="n">${familiares.reduce((s, x) => s + (+x.personas || 0), 0)}</div>
      <div class="d">registradas en los hogares</div>
    </div>
  </div>

  <h2 class="sec">Predios que componen el territorio</h2>
  <table class="cuadro">
    <thead>
      <tr><th>Predio</th><th>Nivel</th><th>Hogar / interesado</th><th>Derecho</th>
          <th>Vereda</th><th>Área medida (ha)</th><th>Captura</th></tr>
    </thead>
    <tbody>
      ${d.predios.map(x => `
        <tr>
          <td>${val(x.nombre_predio || (x.nivel === 'Familiar' ? x.familia : p.nombre_comunidad))}</td>
          <td>${x.nivel === 'Familiar' ? 'Parcela familiar' : 'Colectivo'}</td>
          <td>${val(x.familia || p.nombre_comunidad)}</td>
          <td>${legible(x.tipo_derecho)}</td>
          <td>${val(x.vereda)}</td>
          <td class="num">${num(x.area_real_ha)}</td>
          <td>${legible(x.metodo_captura_perimetro)}</td>
        </tr>`).join('')}
    </tbody>
  </table>

  ${d.familias?.length ? `
    <h2 class="sec">Hogares registrados en el territorio</h2>
    <table class="cuadro">
      <thead>
        <tr><th>Familia</th><th>Jefe de hogar</th><th>Personas</th><th>Mujeres</th><th>Hombres</th>
            <th>Antigüedad</th><th>Origen de la asignación</th></tr>
      </thead>
      <tbody>
        ${d.familias.map((f: any) => `
          <tr>
            <td>${val(f.nombre_familia)}</td>
            <td>${val(f.jefe_hogar)}</td>
            <td class="num">${val(f.numero_personas)}</td>
            <td class="num">${val(f.numero_mujeres)}</td>
            <td class="num">${val(f.numero_hombres)}</td>
            <td>${val(f.antiguedad_ocupacion)}</td>
            <td>${legible(f.origen_asignacion)}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : ''}

  <div class="salto"></div>
  <h2 class="sec">Ficha completa del registro</h2>
  ${fichaCompleta(p, { fuentes: d.fuentes })}

  <div class="salto"></div>
  <h2 class="sec">Cuadro de coordenadas del lindero del territorio</h2>
  ${cuadroVertices(d.vertices)}

</body></html>`
}

/* ──────────────── Render con Puppeteer ────────────────
   Se reutiliza el mismo lanzamiento que el informe general. El SVG va
   embebido en el HTML, así que no hay nada que esperar: ni tiles, ni
   fuentes remotas, ni gráficas que se dibujen solas. */
async function planchaAPdf(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
    try {
        const page = await browser.newPage()
        await page.setViewport({ width: 1000, height: 1400, deviceScaleFactor: 2 })
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 })

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '12mm', right: '10mm', bottom: '14mm', left: '10mm' },
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: `
                <div style="font-size:7px;color:#9ca3af;width:100%;padding:0 10mm;display:flex;justify-content:space-between">
                    <span>Catastro Étnico — documento generado desde el geovisor territorial</span>
                    <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span>
                </div>`,
        })
        return Buffer.from(pdf)
    } finally {
        await browser.close()
    }
}

/* Consulta los vértices del lindero con la distancia de cada tramo.
   El LEFT JOIN con col_cadenadelimite es por (anillo, orden): cada tramo
   arranca en el vértice de ese mismo orden. */
async function verticesDe(predioId: number) {
    const { rows } = await pool.query(`
        SELECT pt.anillo,
               pt.orden,
               pt.local_id                 AS etiqueta,
               ST_Y(pt.posicion)           AS lat,
               ST_X(pt.posicion)           AS lon,
               pt.exactitud_horizontal,
               cd.longitud_m,
               cd.descripcion_lindero
          FROM col_punto pt
          LEFT JOIN col_cadenadelimite cd
                 ON cd.predio_id = pt.predio_id
                AND cd.anillo    = pt.anillo
                AND cd.orden     = pt.orden
         WHERE pt.predio_id = $1
         ORDER BY pt.anillo, pt.orden`, [predioId])
    return rows
}

async function fuentesDe(comunidadId: number) {
    try {
        const { rows } = await pool.query(
            `SELECT * FROM tpc_fuente_administrativa WHERE comunidad_id = $1
              ORDER BY fecha_acto_administrativo DESC NULLS LAST`, [comunidadId])
        return rows
    } catch { return [] }
}

/* Nombre de archivo sin acentos ni espacios: Windows, Linux y los
   navegadores tratan distinto los caracteres no ASCII en Content-Disposition. */
const nombreArchivo = (s: string) =>
    String(s || 'registro').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase().slice(0, 50)

const fechaLarga = () => new Date().toLocaleString('es-CO', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

/* ──────────────── Datos del hogar y de la parcela ────────────────
   Una parcela familiar necesita, además de la ficha de su comunidad, quién
   la ocupa: es ese hogar el que figura como interesado en el documento. */
async function datosParcela(predioId: number) {
    const { rows } = await pool.query(`
        SELECT x.id,
               x.comunidad_id,
               x.nombre_predio,
               x.numero_predial,
               x.matricula_inmobiliaria,
               x.nupre,
               x.local_id,
               x.vereda,
               x.corregimiento,
               x.metodo_captura_perimetro,
               ST_AsGeoJSON(x.geom_perimetro)::json AS poligono,
               ROUND((ST_Area(x.geom_perimetro::geography) / 10000)::numeric, 4) AS area_real_ha,
               ROUND((ST_Perimeter(x.geom_perimetro::geography) / 1000)::numeric, 3) AS perimetro_km,
               f.nombre_familia,
               f.jefe_hogar,
               f.numero_personas  AS personas_familia,
               f.numero_mujeres   AS mujeres_familia,
               f.numero_hombres   AS hombres_familia,
               f.antiguedad_ocupacion,
               f.origen_asignacion,
               d.tipo_derecho
          FROM tpc_predio x
          LEFT JOIN tpc_derecho d            ON d.predio_id = x.id
          LEFT JOIN tpc_interesado_familia f ON f.id = d.familia_id
         WHERE x.id = $1`, [predioId])
    return rows[0] || null
}

/* =====================================================
   ENDPOINT: plancha en PDF, en sus tres modalidades
   GET /api/export/plancha/:modalidad/:id
        predio     → :id es la COMUNIDAD  (su predio colectivo)
        territorio → :id es la COMUNIDAD  (con todas sus parcelas)
        parcela    → :id es el PREDIO de la parcela familiar
===================================================== */
app.get('/api/export/plancha/:modalidad/:id', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const modalidad = String(req.params.modalidad)

    if (!['predio', 'territorio', 'parcela'].includes(modalidad)) {
        res.status(400).json({ error: 'La modalidad tiene que ser «predio», «territorio» o «parcela»' }); return
    }

    /* En modalidad parcela lo que llega es el id del predio familiar; la
       comunidad se deduce de él, porque la ficha del territorio sigue
       formando parte del documento. */
    let comunidadId = +req.params.id
    let parcela: any = null

    try {
        if (modalidad === 'parcela') {
            parcela = await datosParcela(+req.params.id)
            if (!parcela)            { res.status(404).json({ error: 'Esa parcela no existe' }); return }
            if (!parcela.poligono)   { res.status(422).json({ error: 'Esa parcela todavía no tiene el lindero capturado' }); return }
            comunidadId = parcela.comunidad_id
        }

        // 1 ── El registro completo, con el mismo SELECT que alimenta la ficha
        const base = await pool.query(`${baseSelect()} WHERE c.id = $1`, [comunidadId])
        if (!base.rowCount) { res.status(404).json({ error: 'Ese registro no existe' }); return }

        const p = base.rows[0]

        // Campos de identificación que la ficha del visor no necesita pero
        // la plancha sí (son los del encabezado tipo IGAC).
        const ident = await pool.query(`
            SELECT id, nombre_predio, numero_predial, matricula_inmobiliaria, nupre, local_id
              FROM tpc_predio
             WHERE comunidad_id = $1
               AND (nivel_tenencia = 'Colectivo' OR nivel_tenencia IS NULL)
             ORDER BY id LIMIT 1`, [comunidadId])

        if (!ident.rowCount) { res.status(404).json({ error: 'Esa comunidad no tiene predio colectivo' }); return }
        Object.assign(p, ident.rows[0])

        const predioId = ident.rows[0].id

        /* En modalidad parcela, los datos de la parcela pisan a los del
           colectivo: el plano es de la parcela, así que su lindero, su
           superficie y su identificación son las que mandan. Lo que queda
           del colectivo es la ficha del territorio, que sigue siendo el
           marco jurídico de la parcela.

           El área declarada se anula a propósito: la del acto
           administrativo es la del territorio entero, y compararla con la
           superficie de una parcela daría una diferencia sin sentido. */
        if (modalidad === 'parcela') {
            Object.assign(p, parcela, { area_ha: null })
        }

        const predioObjeto = modalidad === 'parcela' ? parcela.id : predioId

        const [vertices, fuentes] = await Promise.all([
            verticesDe(predioObjeto).catch(() => []),
            fuentesDe(comunidadId),
        ])

        const fecha = fechaLarga()
        let html: string

        if (modalidad === 'predio' || modalidad === 'parcela') {
            /* Colindantes: cualquier predio del catastro que toque o quede
               cerca del lindero. ST_DWithin sobre geography usa metros, así
               que el radio se lee como lo que es: 300 m alrededor. */
            const vecinos = await pool.query(`
                SELECT v.id,
                       v.nombre_predio,
                       v.municipio,
                       COALESCE(v.nivel_tenencia, 'Colectivo') AS nivel,
                       COALESCE(f.nombre_familia, f.jefe_hogar, cv.nombre_comunidad) AS interesado,
                       ROUND((ST_Area(v.geom_perimetro::geography) / 10000)::numeric, 4) AS area_real_ha,
                       ST_AsGeoJSON(v.geom_perimetro)::json AS poligono
                  FROM tpc_predio v
                  JOIN tpc_predio base ON base.id = $1
                  JOIN tpc_interesado_comunidad cv ON cv.id = v.comunidad_id
                  LEFT JOIN tpc_derecho d           ON d.predio_id = v.id
                  LEFT JOIN tpc_interesado_familia f ON f.id = d.familia_id
                 WHERE v.id <> base.id
                   AND v.geom_perimetro IS NOT NULL
                   AND ST_DWithin(v.geom_perimetro::geography, base.geom_perimetro::geography, $2)
                 ORDER BY ST_Distance(v.geom_perimetro::geography, base.geom_perimetro::geography)
                 LIMIT 12`,
                 /* Una parcela familiar es mucho más pequeña que un
                    territorio: con un radio de 300 m entrarían parcelas del
                    otro extremo del resguardo y el plano quedaría ilegible.
                    60 m alcanza para las que de verdad lindan con ella. */
                 [predioObjeto, modalidad === 'parcela' ? 60 : 300])

            html = documentoPredio({
                predio: p, colindantes: vecinos.rows, vertices, fuentes, fecha,
                esParcela: modalidad === 'parcela',
            })

        } else {
            /* Territorio: el colectivo y todas sus parcelas familiares. */
            const predios = await pool.query(`
                SELECT x.id,
                       x.nombre_predio,
                       x.vereda,
                       x.metodo_captura_perimetro,
                       COALESCE(x.nivel_tenencia, 'Colectivo') AS nivel,
                       COALESCE(f.nombre_familia, f.jefe_hogar) AS familia,
                       f.numero_personas                        AS personas,
                       d.tipo_derecho,
                       ROUND((ST_Area(x.geom_perimetro::geography) / 10000)::numeric, 4) AS area_real_ha,
                       ST_AsGeoJSON(x.geom_perimetro)::json AS poligono
                  FROM tpc_predio x
                  LEFT JOIN tpc_derecho d            ON d.predio_id = x.id
                  LEFT JOIN tpc_interesado_familia f ON f.id = d.familia_id
                 WHERE x.comunidad_id = $1
                 ORDER BY (COALESCE(x.nivel_tenencia, 'Colectivo') = 'Familiar'), x.id`, [comunidadId])

            let familias: any[] = []
            try {
                const r = await pool.query(
                    `SELECT * FROM tpc_interesado_familia WHERE comunidad_id = $1 ORDER BY id`, [comunidadId])
                familias = r.rows
            } catch { /* sin migrate_familias.sql no hay nivel familiar */ }

            html = documentoTerritorio({
                predio: p, predios: predios.rows, vertices, fuentes, familias, fecha,
            })
        }

        // 2 ── Vista previa sin PDF: sirve para revisar el diseño en el
        //      navegador sin esperar a Puppeteer, y para depurar cuando algo
        //      sale corrido en la impresión.
        if (req.query.formato === 'html') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.send(html)
            return
        }

        // 3 ── Render
        console.log(`🖨️  Generando plancha (${modalidad}) de la comunidad ${comunidadId}…`)
        const pdf = await planchaAPdf(html)

        // La plancha de una parcela se archiva por el hogar, no por la
        // comunidad: en un resguardo con cuarenta parcelas, cuarenta
        // archivos con el mismo nombre no le sirven a nadie.
        const nombre = modalidad === 'parcela'
            ? `plancha_parcela_${nombreArchivo(p.jefe_hogar || p.nombre_familia || p.nombre_predio)}.pdf`
            : `plancha_${modalidad}_${nombreArchivo(p.nombre_comunidad)}.pdf`
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`)
        res.setHeader('Content-Length', pdf.byteLength)
        res.send(pdf)
        console.log(`✅ Plancha generada (${(pdf.byteLength / 1024).toFixed(0)} KB)`)

    } catch (err) {
        console.error('❌ Error generando la plancha:', (err as Error).message)
        res.status(500).json({ error: 'Error generando la plancha: ' + (err as Error).message })
    }
})

/* =====================================================
   ✅ VALIDACIÓN COMUNITARIA POR WHATSAPP
   =====================================================

   El formulario ya preguntaba por la validación al final, pero ahí la
   comunidad todavía no había visto el resultado: contestaba sobre datos que
   acababa de dictar, sin el lindero dibujado delante. Ahora que la plancha
   existe se puede cerrar el círculo — mandarles por WhatsApp la imagen de lo
   que quedó capturado y esperar a que digan si están de acuerdo.

   Lo que va por este canal es una revisión de autoridad, no el acuerdo de
   una asamblea: el sí llega de un teléfono, no de una reunión. El catálogo
   ext_validaciontipo ya distinguía las dos cosas y aquí se respeta —
   WhatsApp escribe «Revisada_Autoridades» y «Validada_Asamblea» queda para
   cuando haya un acta que lo sostenga.

   Requiere migrate_validacion_comunitaria.sql.
===================================================== */

/* Dónde puede alcanzarnos el bot para descargar la imagen. Los dos procesos
   viven en la misma máquina, así que localhost basta; la variable existe por
   si algún día el bot corre en otro sitio. */
const GEOVISOR_PUBLIC_URL = process.env.GEOVISOR_PUBLIC_URL || `http://localhost:${PORT}`

/* ──────────────── La imagen que ve la comunidad ────────────────
   No es la plancha en PDF: es una tarjeta pensada para mirarse en un
   teléfono, de un vistazo y sin ampliar. El mapa arriba, y debajo los
   cuatro o cinco datos sobre los que se está pidiendo el sí. Un PDF de
   200 KB en zona de mala señal puede no bajar nunca; una imagen sí. */
function tarjetaValidacionHTML(p: any, piezas: PiezaPlancha[]): string {
    return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><style>
  @page { margin: 0 }
  * { box-sizing: border-box }
  body {
    margin: 0; width: 820px;
    font-family: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #fff; color: #1f2937;
  }
  .cab { background: #15803d; color: #fff; padding: 18px 22px; }
  .cab h1 { margin: 0 0 3px; font-size: 22px; letter-spacing: .2px; }
  .cab .sub { font-size: 12.5px; opacity: .9; }
  .mapa { border-bottom: 1px solid #e3e7eb; }
  svg.plancha { display: block; width: 100%; height: auto; }
  svg .grid { stroke: #e3e7eb; stroke-width: 1 }
  svg .rot  { font-size: 10px; fill: #4b5563; font-family: inherit }
  svg .rot-n{ font-size: 11px; fill: #374151; font-weight: 700; font-family: inherit }
  svg .vecino { fill: #e8eaec; stroke: #9aa3ab; stroke-width: 1 }
  svg .predio { fill: #f9d7db; stroke: #d6455b; stroke-width: 2 }
  svg .caja-predio { fill: #fdeff1; stroke: #d6455b; stroke-width: 1.4 }
  svg .eti-predio { font-size: 11px; fill: #b02a3c; font-weight: 700; font-family: inherit }
  svg .eti-vecino { font-size: 10px; fill: #374151; font-family: inherit }
  svg .eti-vecino-tit { font-size: 10px; fill: #374151; font-style: italic; font-family: inherit }
  svg .escala line { stroke: #374151; stroke-width: 1.4 }
  svg .norte path { fill: #374151 }
  .sin-mapa { padding: 60px 20px; text-align: center; color: #9ca3af; font-style: italic }
  .datos { padding: 16px 22px 6px; }
  .dato { display: flex; justify-content: space-between; align-items: baseline;
          padding: 9px 0; border-bottom: 1px solid #f1f3f5; font-size: 15px; }
  .dato .k { color: #6b7280; }
  .dato .v { font-weight: 600; text-align: right; max-width: 60%; }
  .grande { font-size: 19px; color: #15803d; }
  .pie { margin: 12px 22px 20px; background: #f0fdf4; border: 1px solid #bbf7d0;
         border-radius: 10px; padding: 14px 16px; font-size: 14px; line-height: 1.55; color: #14532d; }
  .pie b { color: #15803d }
</style></head><body>

  <div class="cab">
    <h1>${escaparXML(p.nombre_territorio || p.nombre_comunidad)}</h1>
    <div class="sub">Esto fue lo que quedó registrado de su territorio</div>
  </div>

  <div class="mapa">${dibujarPlancha(piezas, 820, 520, true)}</div>

  <div class="datos">
    <div class="dato"><span class="k">Comunidad</span><span class="v">${escaparXML(p.nombre_comunidad || '—')}</span></div>
    <div class="dato"><span class="k">Ubicación</span><span class="v">${escaparXML([p.vereda, p.municipio, p.departamento].filter(Boolean).join(', ') || '—')}</span></div>
    <div class="dato"><span class="k">Superficie medida</span><span class="v grande">${
      p.area_real_ha != null ? Number(p.area_real_ha).toLocaleString('es-CO', { maximumFractionDigits: 2 }) + ' hectáreas' : '—'}</span></div>
    <div class="dato"><span class="k">Lindero</span><span class="v">${
      p.perimetro_km != null ? Number(p.perimetro_km).toLocaleString('es-CO', { maximumFractionDigits: 2 }) + ' km' : '—'}</span></div>
    <div class="dato"><span class="k">Cómo se midió</span><span class="v">${escaparXML(String(p.metodo_captura_perimetro || '—').replace(/_/g, ' '))}</span></div>
    <div class="dato"><span class="k">Autoridad registrada</span><span class="v">${escaparXML(p.nombres_autoridades || '—')}</span></div>
    <div class="dato"><span class="k">Familias · personas</span><span class="v">${
      (p.numero_familias ?? '—')} familias · ${(p.numero_personas ?? '—')} personas</span></div>
  </div>

  <div class="pie">
    Revisen con calma el dibujo y los datos.<br>
    Para responder, escriban la palabra <b>validar</b> en este mismo chat.
  </div>

</body></html>`
}

/* Convierte esa tarjeta en PNG. Se guarda en memoria y se sirve por el
   token: no hace falta escribirla a disco, y así no quedan imágenes viejas
   acumulándose en el servidor. */
const imagenesValidacion = new Map<string, { png: Buffer; creada: number }>()

async function renderizarTarjeta(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
    try {
        const page = await browser.newPage()
        // El alto se deja corto a propósito: con fullPage, la captura toma
        // el mayor entre el contenido y la ventana, y una ventana alta deja
        // una franja blanca debajo de la tarjeta.
        await page.setViewport({ width: 820, height: 400, deviceScaleFactor: 2 })
        await page.setContent(html, { waitUntil: 'load', timeout: 30000 })
        const png = await page.screenshot({ type: 'png', fullPage: true })
        return Buffer.from(png)
    } finally {
        await browser.close()
    }
}

/* Se descartan las imágenes de más de un día: para entonces el teléfono ya
   la descargó, y si la solicitud sigue viva el recordatorio genera una nueva. */
function limpiarImagenesViejas() {
    const limite = Date.now() - 24 * 60 * 60 * 1000
    for (const [token, v] of imagenesValidacion) {
        if (v.creada < limite) imagenesValidacion.delete(token)
    }
}

/* ──────────────────────────────────────────────────
   ENVIAR EL LEVANTAMIENTO A VALIDACIÓN
────────────────────────────────────────────────── */
app.post('/api/comunidad/:id/validacion/solicitar', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    const comunidadId = +req.params.id
    const { telefono, dias_plazo = 8 } = req.body || {}

    try {
        const base = await pool.query(`${baseSelect()} WHERE c.id = $1`, [comunidadId])
        if (!base.rowCount) { res.status(404).json({ error: 'Ese registro no existe' }); return }
        const p = base.rows[0]

        const ident = await pool.query(`
            SELECT id, nombre_predio, whatsapp_id
              FROM tpc_predio
             WHERE comunidad_id = $1
               AND (nivel_tenencia = 'Colectivo' OR nivel_tenencia IS NULL)
             ORDER BY id LIMIT 1`, [comunidadId])
        if (!ident.rowCount) { res.status(404).json({ error: 'Esa comunidad no tiene predio colectivo' }); return }

        const predioId = ident.rows[0].id
        Object.assign(p, ident.rows[0])

        if (!p.poligono) {
            res.status(422).json({
                error: 'No se puede pedir validación de un territorio sin lindero capturado: no habría nada que mostrarles.',
            }); return
        }

        // El número puede venir del formulario del visor; si no, se usa el
        // que quedó registrado cuando la comunidad habló con el bot.
        const numero = String(telefono || ident.rows[0].whatsapp_id || '').replace(/\D/g, '')
        if (!numero) {
            res.status(422).json({
                error: 'Esta comunidad no tiene un número de WhatsApp registrado. Indique a qué número enviarlo.',
            }); return
        }

        // Las parcelas familiares entran en el dibujo: al mirar el mapa, la
        // comunidad reconoce su territorio por lo que hay dentro.
        const dentro = await pool.query(`
            SELECT ST_AsGeoJSON(x.geom_perimetro)::json AS poligono,
                   COALESCE(f.nombre_familia, f.jefe_hogar) AS familia,
                   x.nombre_predio
              FROM tpc_predio x
              LEFT JOIN tpc_derecho d            ON d.predio_id = x.id
              LEFT JOIN tpc_interesado_familia f ON f.id = d.familia_id
             WHERE x.comunidad_id = $1
               AND x.nivel_tenencia = 'Familiar'
               AND x.geom_perimetro IS NOT NULL`, [comunidadId])

        const piezas: PiezaPlancha[] = [
            { geom: p.poligono, etiqueta: p.nombre_predio || p.nombre_comunidad, principal: true },
            ...dentro.rows.map(x => ({
                geom: x.poligono, titulo: x.familia, etiqueta: x.nombre_predio,
            })),
        ]

        const png   = await renderizarTarjeta(tarjetaValidacionHTML(p, piezas))
        const token = crypto.randomBytes(24).toString('hex')
        limpiarImagenesViejas()
        imagenesValidacion.set(token, { png, creada: Date.now() })

        const huella = await pool.query(`SELECT fn_huella_geometria($1) AS h`, [predioId])
        const usuario: JWTPayload = (req as any).user

        const sol = await pool.query(`
            INSERT INTO ext_solicitud_validacion
                (comunidad_id, predio_id, token, huella_geometria, area_ha_enviada,
                 telefono_destino, enviada_por, vence_en, estado)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + ($8 || ' days')::interval, 'enviada')
            RETURNING id, vence_en`,
            [comunidadId, predioId, token, huella.rows[0].h, p.area_real_ha,
             numero, usuario.nombre || usuario.username, String(Math.max(1, +dias_plazo || 8))])

        const nombre = p.nombre_territorio || p.nombre_comunidad
        const mensaje = [
            `👋 Buen día. Le escribimos del Registro Territorial Comunitario.`,
            ``,
            `Ya terminamos de organizar la información del territorio *${nombre}* y queremos que la revisen antes de darla por buena.`,
            ``,
            `En la imagen está el lindero tal como quedó dibujado y los datos principales:`,
            `📐 ${p.area_real_ha != null ? Number(p.area_real_ha).toLocaleString('es-CO', { maximumFractionDigits: 2 }) + ' hectáreas medidas' : 'superficie sin medir'}`,
            `📏 ${p.perimetro_km != null ? Number(p.perimetro_km).toLocaleString('es-CO', { maximumFractionDigits: 2 }) + ' km de lindero' : 'lindero sin medir'}`,
            ``,
            `Mírenlo con calma, consúltenlo con quien deban consultarlo, y cuando estén listos escriban la palabra *validar* en este chat para responder.`,
            ``,
            `Nada queda en firme hasta que ustedes respondan.`,
        ].join('\n')

        // El bot descarga la imagen de esta URL: lleva el token y no el id
        // del predio, para que no se pueda adivinar la de otra comunidad.
        const urlImagen = `${GEOVISOR_PUBLIC_URL}/api/validacion/img/${token}`

        try {
            const r = await fetch(`${BOT_URL}/v1/messages`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ number: numero, message: mensaje, urlMedia: urlImagen }),
                signal:  AbortSignal.timeout(20000),
            })
            if (!r.ok) throw new Error(`el bot respondió ${r.status}`)
        } catch (err) {
            // La solicitud ya quedó creada: se marca el fallo de envío en vez
            // de borrarla, para que no se pierda el rastro del intento.
            await pool.query(
                `UPDATE ext_solicitud_validacion
                    SET respuesta_texto = $2, estado = 'enviada'
                  WHERE id = $1`,
                [sol.rows[0].id, `No se pudo entregar por WhatsApp: ${(err as Error).message}`])
            res.status(502).json({
                error: `La solicitud quedó registrada, pero no se pudo enviar por WhatsApp: ${(err as Error).message}. ¿Está el bot conectado?`,
                solicitud_id: sol.rows[0].id,
                url_imagen: urlImagen,
            })
            return
        }

        broadcast({ tipo: 'validacion_solicitada', comunidad_id: comunidadId })
        res.json({
            ok: true,
            solicitud_id: sol.rows[0].id,
            vence_en:     sol.rows[0].vence_en,
            telefono:     numero,
            url_imagen:   urlImagen,
        })
    } catch (err: any) {
        console.error('Error solicitando validación:', err)
        if (err?.code === '42P01' || err?.code === '42883') {
            res.status(501).json({ error: 'Falta aplicar migrate_validacion_comunitaria.sql en la base de datos.' }); return
        }
        res.status(500).json({ error: 'No se pudo enviar a validación: ' + (err as Error).message })
    }
})

/* ──────────────────────────────────────────────────
   LA IMAGEN, SIN SESIÓN
   La descarga el bot para adjuntarla, y la puede abrir
   quien reciba el mensaje. Va protegida por el token
   y no por el inicio de sesión, porque quien la mira
   es la comunidad y no un usuario del visor.
────────────────────────────────────────────────── */
app.get('/api/validacion/img/:token', async (req: Request, res: Response): Promise<void> => {
    const guardada = imagenesValidacion.get(String(req.params.token))

    if (guardada) {
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Cache-Control', 'public, max-age=86400')
        res.send(guardada.png)
        return
    }

    /* Si el servidor se reinició, la imagen en memoria se perdió pero la
       solicitud sigue en la base: se vuelve a dibujar con la geometría de
       ese momento, no con la actual — si el lindero cambió, lo que la
       comunidad debe seguir viendo es lo que se le envió. */
    try {
        const { rows } = await pool.query(`
            SELECT s.comunidad_id, s.predio_id, s.huella_geometria
              FROM ext_solicitud_validacion s
             WHERE s.token = $1`, [String(req.params.token)])

        if (!rows.length) { res.status(404).send('Imagen no encontrada'); return }

        const huellaHoy = await pool.query(`SELECT fn_huella_geometria($1) AS h`, [rows[0].predio_id])
        if (huellaHoy.rows[0].h !== rows[0].huella_geometria) {
            res.status(409).send('El lindero cambió después de enviar esta solicitud; pida una nueva validación.')
            return
        }

        const base = await pool.query(`${baseSelect()} WHERE c.id = $1`, [rows[0].comunidad_id])
        if (!base.rowCount) { res.status(404).send('Imagen no encontrada'); return }
        const p = base.rows[0]

        const piezas: PiezaPlancha[] = [
            { geom: p.poligono, etiqueta: p.nombre_predio || p.nombre_comunidad, principal: true },
        ]
        const png = await renderizarTarjeta(tarjetaValidacionHTML(p, piezas))
        imagenesValidacion.set(String(req.params.token), { png, creada: Date.now() })

        res.setHeader('Content-Type', 'image/png')
        res.send(png)
    } catch (err) {
        console.error('Error sirviendo la imagen de validación:', err)
        res.status(500).send('No se pudo generar la imagen')
    }
})

/* ──────────────────────────────────────────────────
   ESTADO DE LA VALIDACIÓN DE UNA COMUNIDAD
────────────────────────────────────────────────── */
app.get('/api/comunidad/:id/validacion', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    try {
        const estado = await pool.query(
            `SELECT * FROM vista_estado_validacion WHERE comunidad_id = $1`, [+req.params.id])

        const historial = await pool.query(`
            SELECT id, estado, fecha_envio, fecha_respuesta, telefono_destino,
                   telefono_respuesta, enviada_por, secciones, respuesta_texto,
                   transcripcion, vence_en, recordatorios
              FROM ext_solicitud_validacion
             WHERE comunidad_id = $1
             ORDER BY fecha_envio DESC
             LIMIT 20`, [+req.params.id])

        res.json({
            estado:    estado.rows[0] || null,
            historial: historial.rows,
        })
    } catch (err: any) {
        if (err?.code === '42P01') {
            res.json({ estado: null, historial: [], sin_migracion: true }); return
        }
        console.error('Error consultando validación:', err)
        res.status(500).json({ error: 'Error consultando el estado de validación' })
    }
})

/* Listado para las alertas de la pestaña Informes: lo que está esperando
   respuesta, lo que llegó con observaciones y lo que caducó porque el
   lindero cambió después de aprobado. */
app.get('/api/validaciones/pendientes', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
    try {
        const { rows } = await pool.query(`
            SELECT comunidad_id, nombre_comunidad, estado, fecha_envio, fecha_respuesta,
                   telefono_destino, respuesta_texto, transcripcion, secciones, vence_en
              FROM vista_estado_validacion
             WHERE estado IN ('esperando_respuesta', 'con_observaciones', 'caduca', 'sin_enviar')
             ORDER BY CASE estado
                        WHEN 'con_observaciones'   THEN 1
                        WHEN 'caduca'              THEN 2
                        WHEN 'esperando_respuesta' THEN 3
                        ELSE 4 END,
                      fecha_envio DESC NULLS LAST`)
        res.json({ total: rows.length, validaciones: rows })
    } catch (err: any) {
        if (err?.code === '42P01') { res.json({ total: 0, validaciones: [], sin_migracion: true }); return }
        console.error('Error consultando validaciones pendientes:', err)
        res.status(500).json({ error: 'Error consultando las validaciones' })
    }
})

/* ──────────────────────────────────────────────────
   EXPORTAR EXCEL
────────────────────────────────────────────────── */
app.get('/api/export/excel', authMiddleware, async (req: Request, res: Response): Promise<void> => {
    const { where, params } = buildWhere(req.query)
    try {
        const { rows } = await pool.query(`${baseSelect()} ${where} ORDER BY c.fecha_registro DESC`, params)

        const wb   = new ExcelJS.Workbook()
        wb.creator = 'Catastro Étnico Bot'
        wb.created = new Date()

        const ws = wb.addWorksheet('Registros', { views: [{ state: 'frozen', ySplit: 1 }] })

        ws.columns = [
            { header: 'ID',              key: 'id',               width: 8  },
            { header: 'Comunidad',       key: 'nombre_comunidad', width: 30 },
            { header: 'Tipo',            key: 'tipo_comunidad',   width: 22 },
            { header: 'Pueblo Étnico',   key: 'pueblo_etnico',    width: 22 },
            { header: 'Familias',        key: 'numero_familias',  width: 10 },
            { header: 'Personas',        key: 'numero_personas',  width: 10 },
            { header: 'Mujeres',         key: 'numero_mujeres',   width: 10 },
            { header: 'Hombres',         key: 'numero_hombres',   width: 10 },
            { header: 'Fecha Registro',  key: 'fecha_registro',   width: 18 },
            { header: 'Representante',   key: 'nombres_autoridades', width: 28 },
            { header: 'Cargo',           key: 'cargo',            width: 22 },
            { header: 'Departamento',    key: 'departamento',     width: 18 },
            { header: 'Municipio',       key: 'municipio',        width: 18 },
            { header: 'Vereda',          key: 'vereda',           width: 18 },
            { header: 'Territorio',      key: 'nombre_territorio',width: 30 },
            { header: 'Área (ha)',        key: 'area_ha',          width: 12 },
            { header: 'Reconocimiento',  key: 'reconocimiento_estado', width: 16 },
            { header: 'Latitud',         key: 'latitud',          width: 14 },
            { header: 'Longitud',        key: 'longitud',         width: 14 },
            { header: 'Tipo Derecho',    key: 'tipo_derecho',     width: 22 },
            { header: 'Restricción',     key: 'tipo_restriccion', width: 22 },
            { header: 'Validación',      key: 'validado_por_comunidad', width: 22 },
            { header: 'Observaciones',   key: 'observaciones_finales', width: 40 },
        ]

        // Estilo encabezado
        ws.getRow(1).eachCell(cell => {
            cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D6A4F' } }
            cell.font   = { bold: true, color: { argb: 'FFFFFFFF' } }
            cell.border = { bottom: { style: 'thin' } }
        })

        rows.forEach((r, i) => {
            const row = ws.addRow({
                ...r,
                fecha_registro: r.fecha_registro ? new Date(r.fecha_registro) : null,
                latitud:  r.latitud  ? parseFloat(r.latitud)  : null,
                longitud: r.longitud ? parseFloat(r.longitud) : null,
                area_ha:  r.area_ha  ? parseFloat(r.area_ha)  : null,
            })
            if (i % 2 === 1) row.eachCell(c => {
                c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0FFF4' } }
            })
        })

        // Hoja de estadísticas rápidas
        const ws2 = wb.addWorksheet('Resumen')
        ws2.addRow(['Catastro Étnico — Resumen de exportación'])
        ws2.addRow(['Generado el', new Date().toLocaleString('es-CO')])
        ws2.addRow(['Total registros exportados', rows.length])
        ws2.addRow(['Filtros aplicados', JSON.stringify(req.query)])

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        res.setHeader('Content-Disposition', `attachment; filename="catastro_etnico_${Date.now()}.xlsx"`)
        await wb.xlsx.write(res)
        res.end()
    } catch (err) {
        console.error('Error Excel:', err)
        res.status(500).json({ error: 'Error generando Excel' })
    }
})

/* ──────────────────────────────────────────────────
   INTEGRACIÓN BIDIRECCIONAL CON EL CHATBOT
────────────────────────────────────────────────── */
app.post('/api/chatbot/mensaje', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    const { numero, mensaje } = req.body
    if (!numero || !mensaje) { res.status(400).json({ error: 'Faltan número y mensaje' }); return }
    try {
        const r = await fetch(`${BOT_URL}/v1/messages`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ number: numero, message: mensaje }),
            signal:  AbortSignal.timeout(8000),
        })
        if (!r.ok) throw new Error(`Bot respondió ${r.status}`)
        res.json({ ok: true, mensaje: 'Mensaje enviado al bot' })
    } catch (err) {
        res.status(502).json({ error: `No se pudo contactar al bot: ${(err as Error).message}` })
    }
})

/* ──────────────────────────────────────────────────
   GESTIÓN DE USUARIOS (admin only)
────────────────────────────────────────────────── */
app.get('/api/usuarios', authMiddleware, adminOnly, async (_req: Request, res: Response): Promise<void> => {
    const { rows } = await pool.query(
        'SELECT id, username, nombre, rol, activo, created_at, last_login FROM geovisor_users ORDER BY created_at'
    )
    res.json(rows)
})

app.post('/api/usuarios', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    const { username, password, nombre, rol } = req.body
    if (!username || !password) { res.status(400).json({ error: 'Faltan datos' }); return }
    try {
        const hash = await bcrypt.hash(password, 10)
        await pool.query(
            'INSERT INTO geovisor_users (username, password_hash, nombre, rol) VALUES ($1,$2,$3,$4)',
            [username, hash, nombre || username, rol || 'viewer']
        )
        res.status(201).json({ ok: true })
    } catch (err: any) {
        if (err.code === '23505') { res.status(409).json({ error: 'Nombre de usuario ya existe' }); return }
        res.status(500).json({ error: 'Error creando usuario' })
    }
})

app.put('/api/usuarios/:id', authMiddleware, adminOnly, async (req: Request, res: Response): Promise<void> => {
    const { nombre, rol, activo, password } = req.body
    const { id } = req.params
    if (password) {
        const hash = await bcrypt.hash(password, 10)
        await pool.query('UPDATE geovisor_users SET password_hash=$1 WHERE id=$2', [hash, id])
    }
    await pool.query(
        'UPDATE geovisor_users SET nombre=$1, rol=$2, activo=$3 WHERE id=$4',
        [nombre, rol, activo, id]
    )
    res.json({ ok: true })
})

/* ──────────────────────────────────────────────────
   OPCIONES PARA FILTROS (evita hardcode en frontend)
────────────────────────────────────────────────── */
app.get('/api/opciones', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
    const [tipos, deptos, derechos] = await Promise.all([
        pool.query('SELECT DISTINCT tipo_comunidad FROM tpc_interesado_comunidad WHERE tipo_comunidad IS NOT NULL ORDER BY 1'),
        pool.query(`SELECT DISTINCT departamento FROM ${TABLA_PREDIO} WHERE departamento IS NOT NULL ORDER BY 1`),
        pool.query('SELECT DISTINCT tipo_derecho FROM tpc_derecho WHERE tipo_derecho IS NOT NULL ORDER BY 1'),
    ])
    res.json({
        tipos:    tipos.rows.map(r => r.tipo_comunidad),
        deptos:   deptos.rows.map(r => r.departamento),
        derechos: derechos.rows.map(r => r.tipo_derecho),
    })
})

/* ──────────────────────────────────────────────────
   PÁGINA PRINCIPAL → sirve geovisor.html
────────────────────────────────────────────────── */
app.get('/', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.join(PUBLIC_DIR, 'geovisor.html'))
})
app.get('/login', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'))
})

/* =====================================================
   🚀 HTTP + WEBSOCKET
===================================================== */
const server = createServer(app)
const wss    = new WebSocketServer({ server })

const broadcast = (data: object) => {
    const msg = JSON.stringify(data)
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(msg)
    })
}

wss.on('connection', (ws: WebSocket) => {
    console.log(`🔌 Cliente WS conectado (total: ${wss.clients.size})`)
    broadcast({ tipo: 'usuarios_conectados', count: wss.clients.size })

    ws.on('close', () => {
        broadcast({ tipo: 'usuarios_conectados', count: wss.clients.size })
    })
    ws.on('error', err => console.warn('WS error:', err.message))
})

/* =====================================================
   📡 POSTGRESQL LISTEN — tiempo real
===================================================== */
const startListen = async () => {
    const pgListen = new Client(dbConfig)
    try {
        await pgListen.connect()
        await pgListen.query('LISTEN nuevo_registro')
        console.log('📡 PostgreSQL LISTEN activo en canal "nuevo_registro"')

        pgListen.on('notification', msg => {
            try {
                const data = JSON.parse(msg.payload ?? '{}')
                broadcast({ tipo: 'nuevo_registro', data })
                console.log(`📨 Nuevo registro recibido vía NOTIFY: ${data.nombre_comunidad}`)
            } catch {}
        })

        pgListen.on('error', err => {
            console.error('PG LISTEN error:', err.message)
            setTimeout(startListen, 5000) // reconectar en 5s
        })
    } catch (err) {
        console.error('No se pudo iniciar PG LISTEN:', (err as Error).message)
        setTimeout(startListen, 10000)
    }
}

/* =====================================================
   ▶️  INICIO
===================================================== */
/**
 * Avisa con claridad si falta correr alguna migración, en vez de dejar que
 * las consultas fallen después con un error críptico de columna inexistente.
 */
const verificarMigraciones = async () => {
    const faltantes: string[] = []

    const col = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tpc_predio' AND column_name = 'geom_perimetro'`)
    if (!col.rows.length) faltantes.push('migrate_perimetro.sql  → falta la columna geom_perimetro (polígonos)')

    const tab = await pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('ext_foto_registro', 'ext_transcripcion_respuesta')`)
    if (tab.rows.length < 2) faltantes.push('migrate_voz_fotos.sql  → faltan las tablas de fotos y transcripciones')

    const ladm = await pool.query(`
        SELECT to_regclass('public.col_rrrfuente') IS NOT NULL AS ok`)
    if (!ladm.rows[0].ok) faltantes.push('migrate_ladm.sql       → falta la alineación con el modelo LADM-COL')

    // Si existe la vista, hay que leer de ella para no contar las parcelas
    // familiares como si fueran territorios.
    const fam = await pool.query(`
        SELECT to_regclass('public.vista_predio_colectivo') IS NOT NULL AS ok`)
    if (fam.rows[0].ok) {
        TABLA_PREDIO = 'vista_predio_colectivo'
        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS n FROM tpc_predio WHERE nivel_tenencia = 'Familiar'`)
        console.log(`👨‍👩‍👧 Levantamiento familiar activo — ${rows[0].n} parcela(s) registrada(s)`)
    } else {
        faltantes.push('migrate_familias.sql   → falta el levantamiento por familias')
    }

    if (faltantes.length) {
        console.warn('\n⚠️  Faltan migraciones por aplicar:')
        faltantes.forEach(f => console.warn('   • ' + f))
        console.warn('   Ejecútalas con:  psql -U postgres -d catastro_etnico -f <archivo>\n')
    } else {
        console.log('✅ Migraciones al día (polígonos, fotos, transcripciones y LADM-COL)')
    }
}

const main = async () => {
    try {
        await pool.query('SELECT 1')
        console.log('✅ PostgreSQL conectado')
    } catch (err) {
        console.error('❌ PostgreSQL no disponible:', (err as Error).message)
        process.exit(1)
    }

    await verificarMigraciones()

    await startListen()

    server.listen(PORT, () => {
        // El visor siempre escucha en localhost — eso es correcto y no hay
        // que cambiarlo. Lo que lo hace alcanzable desde internet es el
        // túnel que lo publica por fuera (npm run geovisor:publico, o el
        // config.yml de Cloudflare). Aquí solo se anuncia la dirección
        // pública cuando de verdad hay una, para no dar a entender que el
        // visor está encerrado en el computador cuando no lo está.
        const dominioNgrok = process.env.NGROK_STATIC_DOMAIN?.trim()
        const dominioTunel = process.env.TUNEL_DOMINIO?.trim()
        const publica = dominioTunel ? `https://visor.${dominioTunel}`
                      : dominioNgrok ? `https://${dominioNgrok}`
                      : null

        console.log(`\n🌍 Geovisor Catastro Étnico`)
        if (publica) {
            console.log(`   Pública : ${publica}`)
            console.log(`             (solo si el túnel está corriendo — npm run geovisor:publico)`)
        } else {
            console.log(`   Pública : sin configurar — agrega NGROK_STATIC_DOMAIN o TUNEL_DOMINIO al .env`)
        }
        console.log(`   Local   : http://localhost:${PORT}`)
        console.log(`   API     : http://localhost:${PORT}/api/estadisticas\n`)
    })
}

main().catch(err => {
    console.error('❌ Error fatal:', err)
    process.exit(1)
})
