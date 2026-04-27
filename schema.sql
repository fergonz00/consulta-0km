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
-- Nueva consulta -> al admin (Fer, fngonzalez); no toca al vendedor que la creó
INSERT INTO consultas_0km_notif_config (evento, incluir_vendedor, incluir_gerente, usuarios_ids)
SELECT 'consulta_0km_nueva', FALSE, FALSE, ARRAY[id]
FROM tasador_usuarios WHERE usuario = 'fngonzalez'
ON CONFLICT (evento) DO NOTHING;

-- Respuesta -> al vendedor original + a todos los gerentes (Daniel)
INSERT INTO consultas_0km_notif_config (evento, incluir_vendedor, incluir_gerente, usuarios_ids)
VALUES ('consulta_0km_respondida', TRUE, TRUE, '{}'::uuid[])
ON CONFLICT (evento) DO NOTHING;
