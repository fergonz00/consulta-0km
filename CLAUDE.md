# Consulta 0KM — Contexto del proyecto para Claude Code

## Qué es

Módulo independiente para que los **vendedores de Tito González Automotores (TGA)** carguen consultas de mejora de precio de 0km, con pre-análisis automático que replica la planilla manual de Fer.

Producción: https://consulta0km.titogonzalez.online (GitHub Pages + CNAME)

A futuro lo va a integrar Mati en el CRM. Por ahora es independiente.

## Stack

- HTML único `index.html` (vanilla JS + CSS inline, sin build/framework)
- Supabase REST directa con fetch (sin SDK). Project: `wjfglsafgaltusmbnccl`
- Tablas: `consultas_0km` + `consultas_0km_items` (ver `schema.sql`)
- Login: contra tabla existente `tasador_usuarios` (mismo user/clave que tasador.titogonzalez.online)
- CSV de stock: dos hojas del sheet espejo "Tito — espejo público consulta0km" (IMPORTRANGE del sheet maestro privado "Tito")
- Notificaciones WhatsApp: CallMeBot directo (sin Edge Function), patrón heredado del tasador

## Constantes de negocio

- `FYF = 1.110.000` — flete y formulario, monto fijo. Todos los precios manejados son con FyF incluido.
- `ADMIN_PHONE = '5491156559854'` + `ADMIN_KEY = '6552632'` — CallMeBot del admin (Fer)

## Fórmulas clave

**Análisis automático del dto extra pedido** (live, sin guardar hasta submit):

```
oferta_vigente = oferta_final_fyf  si chasis está en stock_limitado
                 oferta_baratito   si no

gcia_vigente   = gcia_resultante   si chasis está en stock_limitado
                 gcia_actual       si no

dto_extra_pedido = (oferta_vigente − precio_pedido) / precio_lista
gcia_resultante  = gcia_vigente − dto_extra_pedido
```

Cuando hay múltiples chasis para una misma unidad (hasta 3 colores), uso el de **oferta_vigente más baja** como base del análisis (peor caso para el concesionario).

**Análisis admin "mejor precio máximo"** (live al tipear, en vista admin):

Misma fórmula que arriba pero usando `precio_max_admin` en lugar de `precio_pedido`. Permite tipear cualquier valor y ver gcia resultante en tiempo real.

**% financiación** (solo si financia):

```
% financiación = monto_a_financiar / (precio_pedido − 1.110.000)
```

`precio_pedido` es el de la unidad consultada. Si hay varias unidades en la consulta, se aplica a la primera (o se replica por unidad — TBD según uso).

## Reglas de stock

- **Disponibilidad**: en hoja `stock`, columna `disponibilidad === '#N/A'` significa libre. Cualquier otro valor (típicamente el modelo) significa vendida.
- **Override de oferta**: si el `serie` está en hoja `stock_limitado`, vale el `oferta_final_fyf` y `gcia_resultante` de esa hoja, sin importar la `oferta_baratito` del stock. Stock limitado siempre baja el precio (es superador).
- **Cruce vendido + stock_limitado**: aunque un serie figure en stock_limitado, si en stock está marcada como vendida, hay que descartarla.

## Flujo del vendedor (wizard / form dinámico)

Por consulta: hasta **3 unidades**. Por unidad: hasta **3 chasis** (mismo modelo+versión, distintos colores).

1. Por cada unidad: modelo → versión → colores disponibles libres (auto resuelve chasis) → precio pedido (con FyF)
   - Live: muestra dto_extra_pedido + gcia_resultante
2. Datos del cliente:
   - Tipo: particular / reventa
   - **Particular**: nombre+apellido cliente, provincia+localidad, fuente del dato (Referido/Salón/Instagram-redes/Tu0KM/Mercadolibre/Otro), ¿tiene usado? sí/no, ¿financia? sí/no → si sí: entidad (VWFS/TG/Otros) + monto, ¿vs otro presupuesto? sí/no/no quiere pasar → si sí: nombre concesionario + precio
   - **Reventa**: nombre del reventa, provincia+localidad, ¿financia con VWFS? sí/no → si sí: monto, ¿vs otro presupuesto? sí/no/no quiere pasar → si sí: nombre concesionario + precio
3. Submit → guarda en Supabase + dispara WhatsApp a Fer

## Vista admin (Fer)

Tabs: **Pendientes** / **Resueltas**. Por cada consulta:
- Resumen de unidades + chasis + análisis snapshot
- Datos cliente
- Botón **Aceptar mejora** → estado='aceptada'
- Botón **No acepto** → input "mejor precio máximo" con cálculo live de gcia → estado='rechazada' + precio_max_admin guardado
- Notificación WA al vendedor cuando se responde (TBD si va por CallMeBot o solo se ve en la app del vendedor al refrescar)

## Sheet de datos (espejo público)

Sheet "Tito — espejo público consulta0km" (CSV publicado):

- **stock**: serie, modelo, color, disponibilidad, oferta_baratito, gcia_actual, precio_lista, dto_baratito
  - URL CSV: https://docs.google.com/spreadsheets/d/e/2PACX-1vRxMSuaIaQ9krTGnAYj73w1H9BuQnIyTQo1f9WwOgRVCAcf3eniWiCji7GFR2Ts__HtCvoFZkjbC5o1/pub?gid=0&single=true&output=csv
- **stock_limitado**: serie, dto_nuevo, gcia_resultante, oferta_final_fyf
  - URL CSV: https://docs.google.com/spreadsheets/d/e/2PACX-1vRxMSuaIaQ9krTGnAYj73w1H9BuQnIyTQo1f9WwOgRVCAcf3eniWiCji7GFR2Ts__HtCvoFZkjbC5o1/pub?gid=1137307261&single=true&output=csv

Usa IMPORTRANGE desde el sheet privado maestro `1KvuRZzHuVpWSppZqT8xDf8WSrplR-vYzeY0gQPftlpQ`. El espejo NO trae costo histórico ni paga/impaga (sensibles).

Parseo de CSV:
- Precios: quitar `$` y comas → `parseFloat`
- Porcentajes: quitar `%` y dividir entre 100 → decimal (ej: `15.00%` → `0.15`)
- Disponibilidad: `=== '#N/A'` → libre

## Deploy

GitHub Pages desde rama `main`. CNAME en root apunta a `consulta0km.titogonzalez.online`. DNS lo configura Fer.

## Convenciones heredadas del tasador

- Login no hashea claves (deuda técnica conocida, NO arreglar acá sin avisar)
- Tabla `tasador_usuarios` tiene campos: `usuario`, `clave`, `activo`, `roles`, `rol`, `nombre`, `email`, `telefono_wa`, `callmebot_key`, `debe_cambiar_clave`
- Patrón `sbFetch(path, options)` directo a `/rest/v1/`
- CSS variables VW (`--vw-blue: #001E50`, etc.)
- Fonts: DM Sans + JetBrains Mono
