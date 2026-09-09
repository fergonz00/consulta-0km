-- ============================================================================
-- Schema para módulo Consulta 0KM (consulta0km.titogonzalez.online)
-- Proyecto Supabase: wjfglsafgaltusmbnccl
--
-- Reutiliza tabla `tasador_usuarios` existente (mismo login que tasador).
-- Crea 2 tablas nuevas: consultas_0km (cabecera) + consultas_0km_items (unidades).
--
-- Correr este script desde el SQL Editor del panel de Supabase.
-- ============================================================================

DROP TABLE IF EXISTS consultas_0km_items;
DROP TABLE IF EXISTS consultas_0km;

CREATE TABLE consultas_0km (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Vendedor que armó la consulta
  vendedor_id UUID REFERENCES tasador_usuarios(id),
  vendedor_usuario TEXT,
  vendedor_nombre TEXT,

  -- Tipo de cliente
  tipo_cliente TEXT NOT NULL CHECK (tipo_cliente IN ('particular', 'reventa')),

  -- Datos comunes (provincia + localidad)
  provincia TEXT,
  localidad TEXT,

  -- Particular
  cliente_nombre TEXT,
  cliente_apellido TEXT,
  fuente_dato TEXT, -- 'referido','salon','redes','tu0km','mercadolibre','otro'
  fuente_dato_otro TEXT,
  tiene_usado BOOLEAN,

  -- Reventa
  reventa_nombre TEXT,

  -- Financiación
  -- Reventa: financia con VWFS si/no (entidad implícita = vwfs si financia=true)
  -- Particular: financia si/no + entidad ('vwfs','tg','otros') + monto
  financia BOOLEAN,
  financia_entidad TEXT, -- 'vwfs','tg','otros' (null en reventa)
  financia_entidad_otro TEXT,
  financia_monto NUMERIC(14, 2),
  -- Análisis: % financiación = monto / (precio_pedido_unidad - 1.110.000)
  -- Se calcula client-side al mostrar; se persiste el valor calculado para consulta histórica.
  financia_pct NUMERIC(8, 4),

  -- Competencia (otro presupuesto)
  vs_otro_concesionario TEXT, -- 'si','no','no_quiere_pasar'
  concesionario_nombre TEXT,
  concesionario_precio NUMERIC(14, 2),

  -- Estado y respuesta admin
  estado TEXT DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'aceptada', 'rechazada')),
  admin_respuesta_at TIMESTAMPTZ,
  admin_user_id UUID REFERENCES tasador_usuarios(id),
  precio_max_admin NUMERIC(14, 2), -- si rechaza, mejor precio máximo (con FyF)
  observaciones_admin TEXT
);

CREATE TABLE consultas_0km_items (
  id BIGSERIAL PRIMARY KEY,
  consulta_id BIGINT NOT NULL REFERENCES consultas_0km(id) ON DELETE CASCADE,
  orden SMALLINT NOT NULL DEFAULT 1, -- 1, 2 o 3 dentro de la consulta

  -- Modelo + versión consultada
  modelo TEXT NOT NULL,
  version TEXT,

  -- Snapshot de chasis seleccionados (hasta 3 colores distintos del mismo modelo+versión)
  -- JSONB array: [{serie, color, oferta_vigente, gcia_vigente, fuente_oferta}]
  -- fuente_oferta = 'baratito' | 'stock_limitado'
  chasis JSONB NOT NULL,

  -- Snapshot al momento de la consulta (referencia para análisis)
  precio_lista NUMERIC(14, 2),    -- mismo para todos los chasis (mismo modelo+versión)
  oferta_vigente_min NUMERIC(14, 2), -- la mejor (más baja) entre los chasis -> usado para el análisis
  gcia_vigente_min NUMERIC(8, 4),    -- gcia correspondiente al chasis con oferta más baja

  -- Input del vendedor
  precio_pedido NUMERIC(14, 2) NOT NULL, -- con FyF

  -- Análisis automático calculado
  dto_extra_pedido NUMERIC(8, 4), -- (oferta_vigente_min - precio_pedido) / precio_lista
  gcia_resultante NUMERIC(8, 4)   -- gcia_vigente_min - dto_extra_pedido
);

CREATE INDEX idx_consultas_0km_estado     ON consultas_0km(estado);
CREATE INDEX idx_consultas_0km_vendedor   ON consultas_0km(vendedor_id);
CREATE INDEX idx_consultas_0km_created_at ON consultas_0km(created_at DESC);
CREATE INDEX idx_consultas_0km_items_consulta ON consultas_0km_items(consulta_id);

-- Deshabilitar RLS (mismo patrón que tasador_usuarios y resto del stack TGA).
-- El front usa la anon key directamente; sin RLS deshabilitado, los inserts fallan
-- con error 42501 "new row violates row-level security policy".
ALTER TABLE consultas_0km DISABLE ROW LEVEL SECURITY;
ALTER TABLE consultas_0km_items DISABLE ROW LEVEL SECURITY;

-- ============================================================================
-- Notificaciones WhatsApp (Edge Function notify-whatsapp-consulta)
-- ============================================================================

CREATE TABLE IF NOT EXISTS consultas_0km_notif_config (
  evento             TEXT PRIMARY KEY,
  incluir_vendedor   BOOLEAN DEFAULT FALSE,
  incluir_gerente    BOOLEAN DEFAULT FALSE,
  usuarios_ids       UUID[] DEFAULT '{}',
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_by         TEXT
);
ALTER TABLE consultas_0km_notif_config DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS consultas_0km_notif_log (
  id                     BIGSERIAL PRIMARY KEY,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  consulta_id            BIGINT,
  destinatario_id        UUID,
  destinatario_telefono  TEXT,
  template               TEXT,
  evento                 TEXT,
  estado                 TEXT, -- 'enviado' | 'error' | 'fallido'
  meta_message_id        TEXT,
  error_detalle          TEXT,
  payload                JSONB
);
ALTER TABLE consultas_0km_notif_log DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_consultas_0km_notif_log_consulta ON consultas_0km_notif_log(consulta_id);

-- Configuración inicial:
-- Nueva consulta -> al admin (Fer, fngonzalez) + a todos los gerentes activos
-- (Daniel). No toca al vendedor que la creó.
INSERT INTO consultas_0km_notif_config (evento, incluir_vendedor, incluir_gerente, usuarios_ids)
SELECT 'consulta_0km_nueva', FALSE, TRUE, ARRAY[id]
FROM tasador_usuarios WHERE usuario = 'fngonzalez'
ON CONFLICT (evento) DO NOTHING;

-- Respuesta -> al vendedor original + a todos los gerentes (Daniel)
INSERT INTO consultas_0km_notif_config (evento, incluir_vendedor, incluir_gerente, usuarios_ids)
VALUES ('consulta_0km_respondida', TRUE, TRUE, '{}'::uuid[])
ON CONFLICT (evento) DO NOTHING;

-- ============================================================================
-- Migrations (correr individualmente en SQL Editor sobre instalaciones existentes)
-- ============================================================================

-- 2026-04-28: campo libre para que el vendedor agregue aclaraciones/pedidos
-- adicionales al cargar la consulta. Visible para el admin en el detalle.
ALTER TABLE consultas_0km ADD COLUMN IF NOT EXISTS observaciones_vendedor TEXT;

-- 2026-04-28: estado nuevo "contraoferta" — admin propone algo distinto
-- (ej: ese precio pero con otro chasis) sin aceptar ni rechazar de plano.
-- El comentario va en observaciones_admin (que ya existia).
ALTER TABLE consultas_0km DROP CONSTRAINT IF EXISTS consultas_0km_estado_check;
ALTER TABLE consultas_0km ADD CONSTRAINT consultas_0km_estado_check
  CHECK (estado IN ('pendiente', 'aceptada', 'rechazada', 'contraoferta'));

-- 2026-04-28: resultado de venta (lo carga el vendedor despues de tener
-- respuesta del admin y hablar con el cliente). Si no se vendio, motivo
-- obligatorio.
ALTER TABLE consultas_0km ADD COLUMN IF NOT EXISTS resultado_venta TEXT
  CHECK (resultado_venta IS NULL OR resultado_venta IN ('vendida', 'no_vendida'));
ALTER TABLE consultas_0km ADD COLUMN IF NOT EXISTS motivo_no_venta TEXT;
ALTER TABLE consultas_0km ADD COLUMN IF NOT EXISTS resultado_venta_at TIMESTAMPTZ;

-- 2026-04-28: notificaciones — al cargar una consulta nueva, sumar a los
-- gerentes (Daniel) ademas del admin. La respuesta ya incluia gerentes;
-- ademas, en la edge function se suma automaticamente al admin que
-- respondio (no requiere config aca).
UPDATE consultas_0km_notif_config
SET incluir_gerente = TRUE
WHERE evento = 'consulta_0km_nueva';

-- 2026-05-11: items "en reparto" (modelos sin stock libre, llegan en reparto).
-- Cuando es_reparto=TRUE el item no tiene chasis seleccionados; chasis JSONB
-- queda como '[]' y oferta_vigente_min / gcia_vigente_min / dto_extra_pedido /
-- gcia_resultante quedan en NULL.
ALTER TABLE consultas_0km_items ADD COLUMN IF NOT EXISTS es_reparto BOOLEAN DEFAULT FALSE;

-- 2026-08-20: ORIGEN de la unidad consultada. El vendedor elige primero de qué bolsa
-- sale el auto y el wizard le muestra solo eso:
--   stock              -> lo que ya le compramos a VW (físico libre + a recibir).
--   reparto            -> lo que VW nos ofrece y todavía no tenemos. Solo las
--                         combinaciones modelo+color que NO están en stock.
--   sin_disponibilidad -> lo que no está ni en stock ni en el reparto. El vendedor
--                         elige modelo y color a mano; el admin consulta al zonal.
ALTER TABLE consultas_0km ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'stock';
ALTER TABLE consultas_0km DROP CONSTRAINT IF EXISTS consultas_0km_origen_check;
ALTER TABLE consultas_0km ADD CONSTRAINT consultas_0km_origen_check
  CHECK (origen IN ('stock','reparto','sin_disponibilidad'));
CREATE INDEX IF NOT EXISTS idx_consultas_0km_origen ON consultas_0km(origen);

-- 2026-08-20: estado "en_gestion" — el admin ya vio la consulta pero está esperando
-- respuesta del gerente zonal. Sigue abierta (aparece en Pendientes) pero SALE del
-- barrido de recordatorios de notify-sin-responder, que filtra estado='pendiente'.
ALTER TABLE consultas_0km DROP CONSTRAINT IF EXISTS consultas_0km_estado_check;
ALTER TABLE consultas_0km ADD CONSTRAINT consultas_0km_estado_check
  CHECK (estado IN ('pendiente','en_gestion','aceptada','rechazada','contraoferta'));

-- 2026-08-20: respuesta de disponibilidad. En las consultas sin_disponibilidad lo
-- primero que se responde no es un precio sino si el auto se consigue. El estado
-- sigue siendo aceptada/rechazada (para que tabs, recordatorios, resultado de venta
-- y WhatsApp funcionen sin cambios); el matiz vive acá.
ALTER TABLE consultas_0km ADD COLUMN IF NOT EXISTS disponibilidad TEXT;
ALTER TABLE consultas_0km DROP CONSTRAINT IF EXISTS consultas_0km_disponibilidad_check;
ALTER TABLE consultas_0km ADD CONSTRAINT consultas_0km_disponibilidad_check
  CHECK (disponibilidad IS NULL OR disponibilidad IN ('se_consigue','no_se_consigue'));

-- 2026-08-20: color pedido a mano (solo sin_disponibilidad; en los otros orígenes el
-- color va dentro del snapshot JSONB `chasis`), y precio_pedido pasa a ser opcional
-- porque una consulta puede ser solo "¿se consigue este auto?" sin pedir un número.
ALTER TABLE consultas_0km_items ADD COLUMN IF NOT EXISTS color_pedido TEXT;
ALTER TABLE consultas_0km_items ALTER COLUMN precio_pedido DROP NOT NULL;


-- ============================================================================
-- 2026-09-09: pago por TRANSFERENCIA bancaria
--
-- El cliente tiene que pagar en la cuenta recaudadora de VW (SICE) con deposito
-- en efectivo o con cheque a la orden que el concesionario endosa a esa cuenta:
-- asi la plata no pasa por nuestro banco. Si transfiere, entra y sale de nuestra
-- cuenta y deja 0,6% + 0,6% de impuesto a los debitos y creditos mas el SIRCREB
-- del mes. Es plata que no cobramos: equivale a haber vendido mas barato.
-- ============================================================================

-- Alicuotas por mes. Las carga Fer en precios.titogonzalez.online/precios con el
-- dato que le pasa Valeria Reyna a principio de mes. Todo en FRACCION.
CREATE TABLE IF NOT EXISTS costos_financieros_mes (
  periodo      DATE PRIMARY KEY,           -- primer dia del mes
  sircreb_pct  NUMERIC(8,6) NOT NULL DEFAULT 0,      -- 0.003  = 0,30%
  deb_cred_pct NUMERIC(8,6) NOT NULL DEFAULT 0.012,  -- 0.012  = 1,20%
  nota         TEXT,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_by   TEXT
);
-- RLS ON con policy solo de SELECT: la anon key (index.html) lee, pero no puede
-- escribir. Se escribe unicamente desde portal-precios con la service_role.
ALTER TABLE costos_financieros_mes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS costos_financieros_lectura ON costos_financieros_mes;
CREATE POLICY costos_financieros_lectura ON costos_financieros_mes FOR SELECT USING (true);

INSERT INTO costos_financieros_mes (periodo, sircreb_pct, deb_cred_pct, updated_by)
VALUES ('2026-09-01', 0.003, 0.012, 'claude')
ON CONFLICT (periodo) DO NOTHING;

-- Control del recordatorio de WhatsApp del dia 1 (cron /api/cron/sircreb).
CREATE TABLE IF NOT EXISTS costos_financieros_avisos (
  periodo         DATE PRIMARY KEY,
  avisos          INTEGER NOT NULL DEFAULT 0,
  ultimo_aviso_at TIMESTAMPTZ,
  ultimo_error    TEXT
);
ALTER TABLE costos_financieros_avisos ENABLE ROW LEVEL SECURITY;

-- Monto que el cliente pide pagar por transferencia. La alicuota va como
-- snapshot para poder releer la consulta meses despues; el analisis del admin
-- recalcula SIEMPRE con la de hoy.
ALTER TABLE consultas_0km_items
  ADD COLUMN IF NOT EXISTS transferencia_monto    NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS transferencia_alicuota NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS transferencia_costo    NUMERIC(14,2);

ALTER TABLE consultas_usados
  ADD COLUMN IF NOT EXISTS transferencia_monto    NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS transferencia_alicuota NUMERIC(8,6),
  ADD COLUMN IF NOT EXISTS transferencia_costo    NUMERIC(14,2);

-- Reapertura: la consulta ya respondida vuelve a pendiente porque el cliente
-- ahora pide pagar una parte por transferencia. `pendiente_desde` existe para
-- que el recordatorio de "sin responder" cuente desde la reapertura y no desde
-- la carga original (si no, dispara al toque diciendo "hace 20 dias").
ALTER TABLE consultas_0km    ADD COLUMN IF NOT EXISTS reabierta_at TIMESTAMPTZ;
ALTER TABLE consultas_usados ADD COLUMN IF NOT EXISTS reabierta_at TIMESTAMPTZ;
ALTER TABLE consultas_0km    ADD COLUMN IF NOT EXISTS pendiente_desde TIMESTAMPTZ
  GENERATED ALWAYS AS (COALESCE(reabierta_at, created_at)) STORED;
ALTER TABLE consultas_usados ADD COLUMN IF NOT EXISTS pendiente_desde TIMESTAMPTZ
  GENERATED ALWAYS AS (COALESCE(reabierta_at, created_at)) STORED;
CREATE INDEX IF NOT EXISTS idx_consultas_0km_pendiente_desde    ON consultas_0km(pendiente_desde);
CREATE INDEX IF NOT EXISTS idx_consultas_usados_pendiente_desde ON consultas_usados(pendiente_desde);

-- Historial de reaperturas: congela la respuesta que habia antes del pedido
-- nuevo. Una sola tabla para 0km y usados (los id de las dos se pisan, de ahi
-- `tipo`). NO guarda ganancia: se recalcula en vivo del lado del admin para no
-- exponer el margen en una tabla que se lee con la anon key.
CREATE TABLE IF NOT EXISTS consultas_reaperturas (
  id                         BIGSERIAL PRIMARY KEY,
  created_at                 TIMESTAMPTZ DEFAULT NOW(),
  tipo                       TEXT NOT NULL CHECK (tipo IN ('0km','usado')),
  consulta_id                BIGINT NOT NULL,
  motivo                     TEXT NOT NULL DEFAULT 'transferencia',
  solicitada_por_id          UUID,
  solicitada_por_nombre      TEXT,
  estado_previo              TEXT,
  disponibilidad_previa      TEXT,
  precio_previo              NUMERIC(14,2),
  observaciones_previas      TEXT,
  respuesta_previa_at        TIMESTAMPTZ,
  resultado_venta_previo     TEXT,
  transferencia_monto_previo NUMERIC(14,2),
  transferencia_monto        NUMERIC(14,2),
  alicuota                   NUMERIC(8,6),
  nota                       TEXT
);
CREATE INDEX IF NOT EXISTS idx_consultas_reaperturas_consulta ON consultas_reaperturas(tipo, consulta_id);
ALTER TABLE consultas_reaperturas DISABLE ROW LEVEL SECURITY;

-- 2026-09-09: N° de preventa que el vendedor carga al marcar la consulta como
-- VENDIDA. Es el nexo entre la consulta (donde quedo el monto por transferencia)
-- y la venta real: la solapa Ventas cruza por aca para descontarle el costo a la
-- ganancia. Normalizado tipo "8114/1" (sin el "PV 0..." de Oversoft). Lo valida la
-- Edge `validar-preventa` contra la replica de Oversoft.
ALTER TABLE consultas_0km    ADD COLUMN IF NOT EXISTS preventa TEXT;
ALTER TABLE consultas_usados ADD COLUMN IF NOT EXISTS preventa TEXT;
CREATE INDEX IF NOT EXISTS idx_consultas_0km_preventa    ON consultas_0km(preventa)    WHERE preventa IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_consultas_usados_preventa ON consultas_usados(preventa) WHERE preventa IS NOT NULL;
