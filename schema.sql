-- ============================================================================
-- Schema para módulo Consulta 0KM (consulta0km.titogonzalez.online)
-- Proyecto Supabase: wjfglsafgaltusmbnccl
--
-- Reutiliza tabla `tasador_usuarios` existente (mismo login que tasador).
-- Crea 2 tablas nuevas: consultas_0km (cabecera) + consultas_0km_items (unidades).
--
-- Correr este script desde el SQL Editor del panel de Supabase.
-- ============================================================================

CREATE TABLE IF NOT EXISTS consultas_0km (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Vendedor que armó la consulta
  vendedor_id BIGINT REFERENCES tasador_usuarios(id),
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
  admin_user_id BIGINT REFERENCES tasador_usuarios(id),
  precio_max_admin NUMERIC(14, 2), -- si rechaza, mejor precio máximo (con FyF)
  observaciones_admin TEXT
);

CREATE TABLE IF NOT EXISTS consultas_0km_items (
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

CREATE INDEX IF NOT EXISTS idx_consultas_0km_estado     ON consultas_0km(estado);
CREATE INDEX IF NOT EXISTS idx_consultas_0km_vendedor   ON consultas_0km(vendedor_id);
CREATE INDEX IF NOT EXISTS idx_consultas_0km_created_at ON consultas_0km(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_consultas_0km_items_consulta ON consultas_0km_items(consulta_id);
