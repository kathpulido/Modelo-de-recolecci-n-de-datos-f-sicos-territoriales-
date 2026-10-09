-- =====================================================
-- RECORDATORIO AUTOMÁTICO PARA COMPLETAR EL PERÍMETRO
-- =====================================================
-- Desde ahora el territorio colectivo se puede guardar sin haber
-- dibujado el croquis o caminado el lindero con GPS todavía (ver
-- MÓDULO 4C en app.ts) — eso se puede completar después, incluso
-- después de haber registrado las parcelas de las familias.
--
-- Estas columnas le dan al bot lo que necesita para avisarle
-- automáticamente a la comunidad que lo complete:
--   - whatsapp_id: a quién escribirle (el mismo número/BSUID con el
--     que se registró la comunidad).
--   - fecha_registro: desde cuándo existe el predio, para calcular el
--     primer recordatorio (24 horas después).
--   - recordatorio_perimetro_conteo / _enviado_en: cuántos
--     recordatorios van y cuándo fue el último, para no enviar más de
--     3 en total ni repetir antes de 3 días.
-- =====================================================

ALTER TABLE tpc_predio
    ADD COLUMN IF NOT EXISTS whatsapp_id VARCHAR(50),
    ADD COLUMN IF NOT EXISTS fecha_registro TIMESTAMP DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS recordatorio_perimetro_enviado_en TIMESTAMP,
    ADD COLUMN IF NOT EXISTS recordatorio_perimetro_conteo INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN tpc_predio.whatsapp_id IS
    'Número o BSUID de WhatsApp de quien registró este predio. Se usa para reenviarle el recordatorio de completar el perímetro si lo dejó pendiente.';
COMMENT ON COLUMN tpc_predio.recordatorio_perimetro_conteo IS
    'Cuántos recordatorios automáticos de "complete el perímetro" se le han enviado a esta comunidad (máximo 3).';
