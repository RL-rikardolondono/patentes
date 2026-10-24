// Servidor de Patent-IA — SkyNet Genesis (versión para la venta)
// Varias empresas, usuarios con clave propia, superadministrador, Market de módulos y pagos con el Bold de SkyNet Genesis.
// Los documentos de cada empresa se sirven desde memoria para que Neon pueda dormir entre cambios.
"use strict";
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const ENV = process.env;
const PUERTO = ENV.PORT || 3000;
const APP_URL = (ENV.APP_URL || "https://patent-ia.skynetgenesis.com").replace(/\/$/, "");
const ORIGENES = (ENV.ORIGENES || ENV.ORIGEN || `${APP_URL},https://patentes.skynetgenesis.com`).split(",").map(s => s.trim()).filter(Boolean);
const DUENOS = (ENV.DUENO_EMAILS || "superadmin@skynetgenesis.com").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const ADMIN_SKYNET = (ENV.ADMIN_SKYNET || "rikardolondono@gmail.com").toLowerCase();
const BREVO_KEY = ENV.BREVO_API_KEY || "";
const REMITENTE = ENV.BREVO_REMITENTE || "patent-ia@skynetgenesis.com";
const LIMITE_CORREOS_DIA = +(ENV.LIMITE_CORREOS_DIA || 100);
const CLAVE_CRON = ENV.CLAVE_CRON || "";
const BOLD_SECRETO = ENV.BOLD_SECRETO || "";
const VERIFICADOR = ENV.BOLD_VERIFICAR || "https://skynetgenesis.com/bold-verificar.php";
const VALOR_MENSUAL = +(ENV.VALOR_MENSUAL || 99000);
const MODO_PRUEBA = ENV.MODO_PRUEBA === "1"; // solo en pruebas locales: devuelve los enlaces de clave en la respuesta
const APP_ID = "patent-ia";
const MODULOS = { grupos: 60000, licencias: 50000, plantillas: 60000, costos: 30000, importar: 25000 };
const COLECCIONES = new Set(["proyectos", "tramites", "licencias", "movimientos", "bitacora", "archivos", "documentos", "config", "dibujos"]);
const MAXDOC = 250000;
const ID_OK = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const ROLES = ["admin", "investigador", "consulta"];
const DIAS_PRUEBA = 15; // cuenta gratis: máximo 15 días, sin renovación
const DIA_CIERRE = 5;   // sin mora: si no ha pagado, el día 5 del mes siguiente se cierra
/* IA para empresas: créditos prepagados. Solo pueden comprarlos las empresas que ya compraron algún módulo.
   1 crédito cubre hasta US$ IA_USD_CREDITO de costo real de la API (con el dólar a IA_COP_USD, más alto que el real, como colchón). */
const ANTHROPIC_KEY = ENV.ANTHROPIC_API_KEY || "";
const IA_URL = ENV.IA_URL || "https://api.anthropic.com/v1/messages";
const IA_MODELOS = {
  default: { id: ENV.IA_MODELO_LIGERO || "claude-haiku-5-5", entrada: +(ENV.IA_PRECIO_LIGERO_ENTRADA || 0.10), salida: +(ENV.IA_PRECIO_LIGERO_SALIDA || 0.50), maxSalida: 3000 },
  complex: { id: ENV.IA_MODELO_FUERTE || "claude-sonnet-5-5", entrada: +(ENV.IA_PRECIO_FUERTE_ENTRADA || 2), salida: +(ENV.IA_PRECIO_FUERTE_SALIDA || 10), maxSalida: 4000 }
}; // US$ por millón de tokens
const IA_USD_CREDITO = +(ENV.IA_USD_CREDITO || 0.025);
const IA_TOPE_USD_MES = +(ENV.IA_TOPE_USD_MES || 40); // tope de gasto de toda la plataforma en un mes
const IA_PAQUETES = { ia100: { creditos: 100, valor: 60000 }, ia300: { creditos: 300, valor: 150000 }, ia1000: { creditos: 1000, valor: 400000 } };
const IA_DIAS = 30; // plan mensual de IA: los créditos valen 30 días desde el pago; lo no usado se pierde (no cuesta nada: la API cobra solo lo usado)

const pool = new Pool({
  connectionString: ENV.DATABASE_URL,
  ssl: ENV.DATABASE_URL && !/localhost|127\.0\.0\.1|host=\/tmp/.test(ENV.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 3, idleTimeoutMillis: 10000
});
const q = (sql, p) => pool.query(sql, p);
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const nuevoToken = () => crypto.randomBytes(32).toString("base64url");
const log = (...a) => console.log(new Date().toISOString(), ...a);
const hoyCO = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
const pad = n => String(n).padStart(2, "0");
function finMes(iso) { const [y, m] = iso.split("-").map(Number); const d = new Date(Date.UTC(y, m, 0)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function sumarMesFin(iso, n) { const [y, m] = iso.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n + 1, 0)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
const diasEntre = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

const MESES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const fechaLarga = iso => { const [y, m, d] = String(iso).split("-").map(Number); return `${d} de ${MESES_ES[m - 1]} de ${y}`; };
const sumarDias = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
/* Créditos de IA vigentes (plan mensual): vencidos valen 0 y no reviven al comprar otro plan */
const lotesIA = (info, hoy) => { const ia = info.ia || {}; const L = Array.isArray(ia.lotes) ? ia.lotes : (ia.vence && ia.creditos ? [{ c: ia.creditos, vence: ia.vence }] : []);
  return L.filter(l => l && l.c > 0 && l.vence >= hoy).sort((a, b) => a.vence.localeCompare(b.vence)); };
const iaVigentes = (info, hoy) => lotesIA(info, hoy).reduce((t, l) => t + l.c, 0);
/* deja en info.ia solo los lotes vigentes y el resumen (creditos = suma, vence = el último vencimiento) */
function guardarLotes(info, L) { info.ia = info.ia || { usados: 0 }; info.ia.lotes = L.filter(l => l.c > 0); info.ia.creditos = info.ia.lotes.reduce((t, l) => t + l.c, 0); info.ia.vence = info.ia.lotes.length ? info.ia.lotes[info.ia.lotes.length - 1].vence : null; }
function tomarIA(info, hoy, n) { const L = lotesIA(info, hoy).map(l => ({ ...l })); let falta = n; for (const l of L) { const t = Math.min(l.c, falta); l.c -= t; falta -= t; if (!falta) break; } guardarLotes(info, L); return n - falta; }
function devolverIA(info, hoy, n) { const L = lotesIA(info, hoy).map(l => ({ ...l })); if (!L.length) return; L[L.length - 1].c += n; guardarLotes(info, L); } // si todos vencieron, no revive nada
/* "Pagado hasta" después de pagar n meses (directiva 19 oct 2026):
   - primer pago (desde la prueba): la prueba no se recorta; el primer día pagado es el siguiente al fin de la prueba (u hoy si ya terminó);
     si ese día cae del 1 al 5, cubre ese mes; si no, el resto de ese mes va gratis y cubre el mes siguiente completo;
   - al día: corre n meses desde "Pagado hasta";
   - atrasado o cerrado: se reconecta desde el mes en que paga, sin cobrar los meses que estuvo cerrado. */
function phTrasPago(info, hoy, n) {
  n = Math.max(1, n || 1);
  if (info.prueba && !info.prueba.terminada && info.prueba.hasta) {
    const ini = hoy > info.prueba.hasta ? hoy : sumarDias(info.prueba.hasta, 1);
    return +ini.slice(8, 10) <= DIA_CIERRE ? sumarMesFin(ini, n - 1) : sumarMesFin(ini, n);
  }
  const ph = info.pagadoHasta || hoy;
  return hoy > ph ? sumarMesFin(hoy, n - 1) : sumarMesFin(ph, n);
}
/* Regla de cobro (todas las apps de SkyNet Genesis): no hay mora.
   - Prueba gratis: 15 días, sin renovación; el día 16 se cierra si no ha pagado.
   - Con mensualidad: "Pagado hasta" es fin de mes; el día 5 del mes siguiente se cierra si no ha pagado. Sin cuenta regresiva. */
function estadoPago(org, hoy) {
  if (org.interna || org.plataforma) return { estado: "activa", meses: 0 };
  const pr = org.prueba;
  if (pr && !pr.terminada) {
    if (hoy <= pr.hasta) return { estado: "prueba", dias: diasEntre(hoy, pr.hasta) + 1, hasta: pr.hasta, meses: 1 };
    return { estado: "bloqueada", motivo: "prueba", hasta: pr.hasta, meses: 1 };
  }
  const ph = org.pagadoHasta || hoy;
  if (hoy <= ph) return { estado: "activa", meses: 0, pagadoHasta: ph };
  let meses = 0; while (sumarMesFin(ph, meses) < hoy && meses < 60) meses++;
  meses = Math.max(1, meses);
  const cierre = sumarDias(ph, DIA_CIERRE);
  if (hoy >= cierre) return { estado: "bloqueada", motivo: "pago", meses, pagadoHasta: ph };
  return { estado: "pendiente", cierre, meses, pagadoHasta: ph };
}

/* ---------- esquema y migración desde la versión de un solo usuario ---------- */
async function preparar() {
  const viejo = await q("select column_name from information_schema.columns where table_name='docs'");
  const cols = viejo.rows.map(r => r.column_name);
  if (cols.length && !cols.includes("org_id")) {
    await q("alter table docs rename to docs_v1");
    log("Migración: tabla docs anterior guardada como docs_v1");
  }
  await q(`create table if not exists orgs(id text primary key, info jsonb not null, creado timestamptz default now(), actualizado timestamptz default now());
  create table if not exists usuarios(id text primary key, org_id text not null, email text unique not null, nombre text not null, rol text not null, activo boolean not null default true, clave_hash text, creado timestamptz default now());
  create table if not exists sesiones(token_hash text primary key, usuario_id text not null, expira timestamptz not null);
  create table if not exists enlaces(token_hash text primary key, email text not null, tipo text not null, expira timestamptz not null, usado boolean default false);
  create table if not exists docs(org_id text not null, col text not null, id text not null, data jsonb not null, actualizado timestamptz not null default now(), primary key(org_id,col,id));
  create table if not exists pagos_bold(pago_id text primary key, org_id text, plan text, valor numeric, resultado jsonb, creado timestamptz default now());
  create table if not exists pagos_claves(clave text primary key, pago_id text, creado timestamptz default now());
  create table if not exists avisos_sa(id serial primary key, texto text not null, creado timestamptz default now(), leido boolean default false);
  create table if not exists contador_correos(dia text primary key, n int not null default 0);
  create table if not exists accesos(usuario_id text primary key, ultimo timestamptz not null default now());
  create table if not exists ia_gasto(mes text primary key, usd numeric not null default 0, llamadas int not null default 0);
  alter table sesiones add column if not exists control text;
  create table if not exists manuales(clave text primary key, pdf bytea not null, actualizado timestamptz not null default now());
  create index if not exists sesiones_u on sesiones(usuario_id);`);
  // Empresa SkyNet Genesis con los datos de la versión anterior y su mismo usuario y clave
  const ya = await q("select 1 from orgs where id='skynet'");
  if (!ya.rows.length) {
    const info = { nombre: "SkyNet Genesis", pais: "CO", interna: true, pagadoHasta: "2099-12-31", valor: VALOR_MENSUAL, modulos: Object.fromEntries(Object.keys(MODULOS).map(m => [m, true])), compras: [], pagos: [], creado: Date.now() };
    await q("insert into orgs(id,info) values('skynet',$1)", [info]);
    const t = await q("select to_regclass('docs_v1') r, to_regclass('usuario') u");
    if (t.rows[0].r) { const n = await q("insert into docs(org_id,col,id,data,actualizado) select 'skynet',col,id,data,actualizado from docs_v1 on conflict do nothing"); log("Migrados", n.rowCount, "documentos a SkyNet Genesis"); }
    let email = ADMIN_SKYNET, hash = null;
    if (t.rows[0].u) { const u = await q("select email,hash from usuario limit 1"); if (u.rows.length) { email = u.rows[0].email.toLowerCase(); hash = u.rows[0].hash; } }
    await q("insert into usuarios(id,org_id,email,nombre,rol,clave_hash) values($1,'skynet',$2,$3,'admin',$4) on conflict(email) do nothing", ["u-" + crypto.randomBytes(5).toString("hex"), email, "Ricardo Londoño González", hash]);
    log("Empresa SkyNet Genesis lista; administrador", email);
  }
  // Superadministrador: espacio aparte, sin empresa ni datos de trabajo
  const pl = await q("select 1 from orgs where id='plataforma'");
  if (!pl.rows.length) await q("insert into orgs(id,info) values('plataforma',$1)", [{ nombre: "Administración Patent-IA", plataforma: true, interna: true, pagadoHasta: "2099-12-31", modulos: {} }]);
  const viejos = await q("select id, info from orgs where (info->'ia'->>'creditos')::int > 0 and not (info->'ia' ? 'lotes') and not (info->'ia' ? 'vence')");
  for (const r of viejos.rows) { const info = r.info; info.ia.lotes = [{ c: +info.ia.creditos, vence: sumarDias(hoyCO(), IA_DIAS - 1) }]; info.ia.vence = info.ia.lotes[0].vence; await q("update orgs set info=$1 where id=$2", [info, r.id]); log("Créditos de IA sin vencimiento pasados a lote de 30 días:", r.id); }
  for (const email of DUENOS) await q("insert into usuarios(id,org_id,email,nombre,rol) values($1,'plataforma',$2,'Superadministrador','super') on conflict(email) do nothing", ["u-sa-" + crypto.randomBytes(4).toString("hex"), email]);
}

/* ---------- empresas en memoria ---------- */
const cache = new Map(); // orgId -> {info, cols:{col:Map}, version, usado}
const cargando = new Map();
async function cargar(orgId) {
  const c = cache.get(orgId); if (c) { c.usado = Date.now(); return c; }
  if (cargando.has(orgId)) return cargando.get(orgId);
  const pr = cargarDeBase(orgId).finally(() => cargando.delete(orgId)); cargando.set(orgId, pr); return pr;
}
async function cargarDeBase(orgId) {
  const o = await q("select info from orgs where id=$1", [orgId]); if (!o.rows.length) return null;
  const cols = {}; for (const k of COLECCIONES) cols[k] = new Map();
  const r = await q("select col,id,data from docs where org_id=$1", [orgId]);
  for (const f of r.rows) if (cols[f.col]) cols[f.col].set(f.id, f.data);
  const e = { info: o.rows[0].info, cols, version: Date.now(), usado: Date.now() }; cache.set(orgId, e); return e;
}
const colas = new Map();
function enCola(id, fn) { const prev = colas.get(id) || Promise.resolve(); const sig = prev.then(fn, fn); colas.set(id, sig.catch(() => {})); return sig; }
async function cambiarInfo(orgId, fn) {
  return enCola("info:" + orgId, async () => {
    const e = await cargar(orgId); if (!e) throw Object.assign(new Error("Empresa no encontrada"), { status: 404 });
    const copia = JSON.parse(JSON.stringify(e.info)); const r = await fn(copia);
    await q("update orgs set info=$1, actualizado=now() where id=$2", [copia, orgId]); e.info = copia; e.version = Date.now(); return r;
  });
}

/* ---------- correo (Brevo): solo para crear o recuperar la clave ---------- */
async function cuposUsados() { const { rows } = await q("select n from contador_correos where dia=$1", [hoyCO()]); return rows.length ? rows[0].n : 0; }
async function usarCupo() { const { rows } = await q("insert into contador_correos(dia,n) values($1,1) on conflict(dia) do update set n=contador_correos.n+1 where contador_correos.n < $2 returning n", [hoyCO(), LIMITE_CORREOS_DIA]); return rows.length > 0; }
const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function plantillaCorreo(titulo, cuerpo, boton) {
  return `<!doctype html><html><body style="margin:0;background:#F4F8FB;font-family:Arial,Helvetica,sans-serif;color:#1C2B39"><table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F8FB;padding:24px 12px"><tr><td align="center">
  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #DCE5EE;border-radius:12px;overflow:hidden">
  <tr><td style="background:#0B4F8A;padding:18px 22px;color:#fff;font-size:22px;font-weight:bold">Patent-IA <span style="font-size:12px;font-weight:normal;opacity:.85">· SkyNet Genesis</span></td></tr>
  <tr><td style="padding:22px"><h2 style="margin:0 0 12px;font-size:20px;color:#0B4F8A">${escH(titulo)}</h2>${cuerpo}
  ${boton ? `<p style="margin:22px 0 6px"><a href="${escH(boton.url)}" style="background:#14A38B;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;display:inline-block">${escH(boton.texto)}</a></p>` : ""}</td></tr>
  <tr><td style="padding:14px 22px;border-top:1px solid #DCE5EE;font-size:12px;color:#5D6B78">Patent-IA es un producto de SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 304 437 5758</td></tr></table></td></tr></table></body></html>`;
}
async function enviarCorreo(para, nombre, asunto, html) {
  if (!BREVO_KEY) { log("[correo simulado]", para, asunto); return false; }
  if (!await usarCupo()) { log("Cupo diario de correos agotado:", para); return false; }
  try {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": BREVO_KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { name: "Patent-IA · SkyNet Genesis", email: REMITENTE }, to: [{ email: para, name: nombre || para }], subject: asunto, htmlContent: html }) });
    if (!r.ok) { log("Brevo respondió", r.status, await r.text()); return false; }
    return true;
  } catch (e) { log("Error enviando correo", e.message); return false; }
}
async function enviarEnlace(email, tipo) {
  const { rows } = await q("select u.*, o.info from usuarios u join orgs o on o.id=u.org_id where u.email=$1", [email]);
  if (!rows.length || !rows[0].activo) return null;
  const u = rows[0]; const tk = nuevoToken(); const horas = tipo === "invitacion" ? 72 : 1;
  await q("insert into enlaces(token_hash,email,tipo,expira) values($1,$2,$3,now()+($4||' hours')::interval)", [sha(tk), email, tipo, String(horas)]);
  const url = `${APP_URL}/#clave=${tk}&tipo=${tipo}`;
  const titulo = tipo === "invitacion" ? `Bienvenido a Patent-IA, ${u.nombre.split(" ")[0]}` : "Crear una clave nueva";
  const cuerpo = tipo === "invitacion" ? `<p style="margin:0 0 10px">Lo invitaron a trabajar en <b>${escH(u.info.nombre)}</b> con Patent-IA, la fábrica de patentes de SkyNet Genesis. Cree su clave con el botón (el enlace vence en 3 días).</p><p style="margin:0;font-size:14px;color:#5D6B78">Su usuario es: ${escH(email)}</p>`
    : `<p style="margin:0 0 10px">Recibimos una solicitud para cambiar su clave de Patent-IA. El enlace vence en una hora.</p><p style="margin:0;font-size:14px;color:#5D6B78">Si usted no lo pidió, ignore este correo: su clave sigue igual.</p>`;
  await enviarCorreo(email, u.nombre, titulo, plantillaCorreo(titulo, cuerpo, { url, texto: tipo === "invitacion" ? "Crear mi clave" : "Crear clave nueva" }));
  return MODO_PRUEBA ? url : true;
}
async function avisarSA(texto) { await q("insert into avisos_sa(texto) values($1)", [String(texto).slice(0, 400)]).catch(() => {}); }

/* ---------- aplicación ---------- */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && (ORIGENES.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))) { res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.post("/api/bold/aplicar", express.raw({ type: "*/*", limit: "50kb" }), (req, res) => aplicarBold(req, res));
app.use(express.json({ limit: "6mb" }));

// IP del visitante: en Render el último X-Forwarded-For cambia en cada petición; Cloudflare manda la real en CF-Connecting-IP
const ipDe = req => { const cf = String(req.headers["cf-connecting-ip"] || "").trim(); if (cf) return cf; const x = String(req.headers["x-forwarded-for"] || "").split(",").map(v => v.trim()).filter(Boolean); return x.length >= 2 ? x[x.length - 2] : x.length ? x[0] : (req.socket && req.socket.remoteAddress) || ""; };
const intentos = new Map();
const bloqueos = new Map(); // ingreso: { n, ultimo, hasta }
setInterval(() => { const lim = Date.now() - 3600e3; for (const [k, v] of bloqueos) if (v.ultimo < lim && (!v.hasta || v.hasta < Date.now())) bloqueos.delete(k); }, 600e3).unref();
function limitar(clave, max, minutos) { const ahora = Date.now(), v = (intentos.get(clave) || []).filter(t => t > ahora - minutos * 60e3); if (v.length >= max) return false; v.push(ahora); intentos.set(clave, v); return true; }
function cuenta(clave, minutos) { const ahora = Date.now(); return (intentos.get(clave) || []).filter(t => t > ahora - minutos * 60e3).length; }
function anotar(clave) { const v = intentos.get(clave) || []; v.push(Date.now()); intentos.set(clave, v); }
setInterval(() => { const lim = Date.now() - 3600e3; for (const [k, v] of intentos) if (!v.some(t => t > lim)) intentos.delete(k); }, 600e3).unref();
const err = (res, status, error, extra) => res.status(status).json({ error, ...(extra || {}) });
const envolver = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { if (e.status) return err(res, e.status, e.message); log("ERROR", req.method, req.path, e.stack || e); err(res, 500, "Ocurrió un error en el servidor. Intente de nuevo."); });
const claveValida = c => typeof c === "string" && c.length >= 10 && c.length <= 100 && /[A-Za-z]/.test(c) && /\d/.test(c);
const MSG_CLAVE = "La clave debe tener mínimo 10 caracteres, con letras y números.";
const ocultarCorreo = e => { const [a, d] = String(e || "").split("@"); return d ? a.slice(0, 2) + "••••••@" + d : ""; };
const emailValido = e => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120;

async function sesion(req, res, next) {
  try {
    const h = req.headers.authorization || ""; const tk = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!tk) return err(res, 401, "Debe iniciar sesión.");
    const { rows } = await q("select u.*, s.control from sesiones s join usuarios u on u.id=s.usuario_id where s.token_hash=$1 and s.expira>now()", [sha(tk)]);
    if (!rows.length) return err(res, 401, "Su sesión terminó. Vuelva a entrar.");
    const u = rows[0]; if (!u.activo) return err(res, 401, "Su usuario está desactivado.");
    req.tk = sha(tk);
    if (u.control) { // Superadministrador dentro de una empresa, con funciones de administrador (la sesión, no el usuario, lleva el modo)
      if (!(u.rol === "super" && u.org_id === "plataforma")) return err(res, 401, "Sesión no válida.");
      req.u = { ...u, org_id: u.control, rol: "admin", nombre: "Superadministrador (SkyNet Genesis)" }; req.control = true; req.super = false; return next();
    }
    req.u = u; req.super = u.rol === "super" && u.org_id === "plataforma";
    if (limitar("acceso:" + u.id, 1, 10)) {
      q("insert into accesos(usuario_id,ultimo) values($1,now()) on conflict(usuario_id) do update set ultimo=now()", [u.id]).catch(() => {});
      q("update sesiones set expira=now()+interval '30 days' where token_hash=$1", [req.tk]).catch(() => {});
    }
    next();
  } catch (e) { log("ERROR sesion", e); err(res, 500, "Error de sesión."); }
}
const soloSuper = (req, res, next) => req.super ? next() : err(res, 403, "Solo para el superadministrador.");
const soloAdmin = (req, res, next) => req.u.rol === "admin" ? next() : err(res, 403, "Solo el administrador de la empresa puede hacer esto.");
const sinControl = (req, res, next) => req.control ? err(res, 403, "En modo Superadministrador no se paga, no se invitan usuarios, no se cambian claves ni se gasta IA de la empresa.") : next();
// Acceso a los datos de la empresa: lo bloquea el servidor si la empresa está suspendida o en mora desde el día 10
async function empresaActiva(req, res, next) {
  if (req.super) return err(res, 403, "El superadministrador no trabaja dentro de las empresas.");
  const e = await cargar(req.u.org_id); if (!e) return err(res, 404, "Empresa no encontrada.");
  req.org = e;
  if (e.info.suspendida) return err(res, 423, req.u.rol === "admin" ? `Su empresa está suspendida: ${e.info.suspendida.motivo || "comuníquese con SkyNet Genesis"}.` : "El acceso está suspendido. Comuníquese con la administración de su empresa.", { bloqueo: "suspendida" });
  const p = estadoPago(e.info, hoyCO());
  if (p.estado === "bloqueada") return err(res, 402, req.u.rol !== "admin" ? "El acceso está cerrado temporalmente. Comuníquese con la administración de su empresa."
    : p.motivo === "prueba" ? "Terminaron sus 15 días de prueba gratis. Pague la mensualidad para seguir trabajando: sus datos están guardados." : "El acceso se cerró porque la mensualidad no se pagó antes del día 5. Pague para seguir trabajando: sus datos están guardados.", { bloqueo: "pago", motivo: p.motivo });
  next();
}
const tieneModulo = info => Object.values(info.modulos || {}).some(Boolean);
function vistaOrg(e, u) {
  const i = e.info; const p = estadoPago(i, hoyCO()); const ia = i.ia || {};
  return { id: u.org_id, nombre: i.nombre, modulos: i.modulos || {}, pago: u.rol === "admin" ? p : { estado: p.estado, dias: p.dias, cierre: p.cierre, motivo: p.motivo }, valor: i.valor || VALOR_MENSUAL, interna: !!i.interna,
    pagadoHasta: u.rol === "admin" ? i.pagadoHasta : undefined, suspendida: i.suspendida ? true : false, compras: u.rol === "admin" ? (i.compras || []).slice(-30) : undefined,
    ia: { creditos: iaVigentes(i, hoyCO()), vence: lotesIA(i, hoyCO()).map(l => l.vence).pop() || null, lotes: lotesIA(i, hoyCO()), plan: ia.plan || null, usados: ia.usados || 0, servicio: !!ANTHROPIC_KEY, puedeComprar: tieneModulo(i) },
    quedaHasta: u.rol === "admin" && !i.interna ? phTrasPago(i, hoyCO(), 1) : undefined };
}

app.get("/api/ping", (req, res) => res.json({ ok: true, app: "Patent-IA", hora: new Date().toISOString() }));
app.get("/api/precios", (req, res) => res.json({ mensual: VALOR_MENSUAL, modulos: MODULOS, ia: IA_PAQUETES, diasPrueba: DIAS_PRUEBA }));

app.post("/api/login", envolver(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase(), clave = String(req.body.clave || "");
  const ip = ipDe(req), kEm = "ei|" + email + "|" + ip, ahora = Date.now();
  const bl = bloqueos.get(kEm) || { n: 0, ultimo: 0, hasta: 0 };
  const glob = k => { const b = bloqueos.get(k) || { n: 0, ultimo: 0 }; return ahora - b.ultimo > 15 * 60e3 ? 0 : b.n; };
  if (bl.hasta > ahora || glob("ip|" + ip) >= 30 || glob("em|" + email) >= 20) return err(res, 429, 'Por seguridad el ingreso quedó bloqueado 15 minutos. Espere o use "¿Olvidó su clave?".');
  for (const k of ["ip|" + ip, "em|" + email]) { const b = bloqueos.get(k) || { n: 0, ultimo: 0 }; if (ahora - b.ultimo > 15 * 60e3) b.n = 0; b.n++; b.ultimo = ahora; bloqueos.set(k, b); }
  if ((bl.hasta && bl.hasta <= ahora) || ahora - bl.ultimo > 15 * 60e3) { bl.n = 0; bl.hasta = 0; }
  // se cuenta el intento ANTES de comparar la clave (así varias peticiones a la vez no prueban más de 5)
  bl.n++; bl.ultimo = ahora; if (bl.n >= 5) bl.hasta = ahora + 15 * 60e3; bloqueos.set(kEm, bl);
  const { rows } = await q("select * from usuarios where email=$1", [email]);
  const ok = rows.length && rows[0].clave_hash && await bcrypt.compare(clave, rows[0].clave_hash);
  if (!ok) {
    await new Promise(r => setTimeout(r, 400)); const quedan = 5 - bl.n;
    return err(res, quedan > 0 ? 400 : 429, quedan > 0 ? `Correo o clave incorrectos. Le quedan ${quedan} intento(s). Si aún no ha creado su clave, use "¿Olvidó su clave?".` : 'Correo o clave incorrectos. Por seguridad el ingreso quedó bloqueado 15 minutos. Use "¿Olvidó su clave?" si no la recuerda.'); }
  bloqueos.delete(kEm); for (const k of ["ip|" + ip, "em|" + email]) { const b = bloqueos.get(k); if (b) b.n = Math.max(0, b.n - 1); } // un ingreso correcto no cuenta como intento
  if (!rows[0].activo) return err(res, 400, "Este usuario está desactivado. Hable con el administrador de su empresa.");
  const tk = nuevoToken(); await q("insert into sesiones(token_hash,usuario_id,expira) values($1,$2,now()+interval '30 days')", [sha(tk), rows[0].id]);
  await q("delete from sesiones where usuario_id=$1 and token_hash not in (select token_hash from sesiones where usuario_id=$1 order by expira desc limit 10)", [rows[0].id]);
  res.json({ token: tk });
}));
app.post("/api/salir", sesion, envolver(async (req, res) => { await q("delete from sesiones where token_hash=$1", [req.tk]); res.json({ ok: true }); }));
app.post("/api/olvide", envolver(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!limitar("olvide:" + ipDe(req), 10, 60) || !limitar("olvide:" + email, 3, 60)) return err(res, 429, "Ya enviamos varios enlaces. Espere una hora o revise su correo (y la carpeta de spam).");
  let enlace = null;
  if (emailValido(email)) { const { rows } = await q("select clave_hash from usuarios where email=$1", [email]); if (rows.length) enlace = await enviarEnlace(email, rows[0].clave_hash ? "recuperar" : "invitacion").catch(e => log("enlace", e.message)); }
  res.json({ ok: true, oculto: ocultarCorreo(email), ...(MODO_PRUEBA && typeof enlace === "string" ? { enlace } : {}) });
}));
app.post("/api/restablecer", envolver(async (req, res) => {
  const tk = String(req.body.token || ""), clave = req.body.clave;
  if (!limitar("rest:" + ipDe(req), 10, 15)) return err(res, 429, "Demasiados intentos. Espere unos minutos.");
  if (!claveValida(clave)) return err(res, 400, MSG_CLAVE);
  const { rows } = await q("update enlaces set usado=true where token_hash=$1 and usado=false and expira>now() returning email", [sha(tk)]);
  if (!rows.length) return err(res, 400, 'El enlace venció o ya se usó. Pida uno nuevo con "¿Olvidó su clave?".');
  const u = await q("update usuarios set clave_hash=$1 where email=$2 returning id", [await bcrypt.hash(clave, 10), rows[0].email]);
  if (u.rows.length) await q("delete from sesiones where usuario_id=$1", [u.rows[0].id]);
  res.json({ ok: true, email: rows[0].email });
}));
app.post("/api/clave", sesion, sinControl, envolver(async (req, res) => {
  const { actual, nueva } = req.body;
  if (!limitar("clave:" + req.u.id, 6, 15)) return err(res, 429, "Demasiados intentos. Espere unos minutos.");
  if (!claveValida(nueva)) return err(res, 400, MSG_CLAVE);
  if (!req.u.clave_hash || !await bcrypt.compare(String(actual || ""), req.u.clave_hash)) return err(res, 400, "La clave actual no es correcta.");
  await q("update usuarios set clave_hash=$1 where id=$2", [await bcrypt.hash(nueva, 10), req.u.id]);
  await q("delete from sesiones where usuario_id=$1 and token_hash<>$2", [req.u.id, req.tk]);
  res.json({ ok: true });
}));
// Registro de una empresa nueva: prueba gratis de 15 días, sin renovación; el administrador recibe un correo para crear su clave
const normEmpresa = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\b(s\.?\s?a\.?\s?s|s\.?\s?a|ltda|sas|e\.?\s?u)\.?$/g, "").replace(/[^a-z0-9]/g, "");
app.post("/api/registro", envolver(async (req, res) => {
  if (!limitar("registro:" + ipDe(req), 3, 60)) return err(res, 429, "Ya se crearon cuentas desde esta conexión. Intente más tarde o escríbanos.");
  const empresa = String(req.body.empresa || "").trim().slice(0, 100), nombre = String(req.body.nombre || "").trim().slice(0, 80), email = String(req.body.email || "").trim().toLowerCase();
  if (empresa.length < 3 || nombre.length < 3 || !emailValido(email)) return err(res, 400, "Revise los datos: empresa, nombre y correo.");
  const { rows } = await q("select 1 from usuarios where email=$1", [email]);
  if (rows.length) return err(res, 400, 'Ese correo ya tiene cuenta en Patent-IA. Use "¿Olvidó su clave?" si no la recuerda.');
  const n = normEmpresa(empresa);
  if (n.length >= 3) { const ya = await q("select info->>'nombre' nombre from orgs where id not in ('plataforma','skynet')"); if (ya.rows.some(r => normEmpresa(r.nombre) === n)) return err(res, 400, "Esa empresa ya tiene (o tuvo) una cuenta en Patent-IA. La prueba gratis es una sola por empresa y no se renueva: entre con la cuenta existente o escríbanos por WhatsApp."); }
  const orgId = "org-" + crypto.randomBytes(6).toString("hex"), uId = "u-" + crypto.randomBytes(5).toString("hex");
  const hoy = hoyCO(), hasta = sumarDias(hoy, DIAS_PRUEBA - 1);
  const info = { nombre: empresa, pais: "CO", prueba: { desde: hoy, hasta }, pagadoHasta: hasta, valor: VALOR_MENSUAL, modulos: {}, compras: [], pagos: [], ia: { creditos: 0, usados: 0 }, creado: Date.now() };
  await q("insert into orgs(id,info) values($1,$2)", [orgId, info]);
  await q("insert into usuarios(id,org_id,email,nombre,rol) values($1,$2,$3,$4,'admin')", [uId, orgId, email, nombre]);
  const enlace = await enviarEnlace(email, "invitacion");
  avisarSA(`Nueva empresa en Patent-IA: ${empresa} · ${nombre} · ${email}`);
  res.json({ ok: true, ...(MODO_PRUEBA && typeof enlace === "string" ? { enlace } : {}) });
}));

app.get("/api/yo", sesion, envolver(async (req, res) => {
  const base = { usuario: { id: req.u.id, nombre: req.u.nombre, email: req.u.email, rol: req.u.rol }, ...(req.control ? { control: true } : {}) };
  if (req.super) { const n = await q("select count(*)::int n from avisos_sa where not leido"); return res.json({ ...base, super: true, avisos: n.rows[0].n, precios: { mensual: VALOR_MENSUAL, modulos: MODULOS, ia: IA_PAQUETES } }); }
  const e = await cargar(req.u.org_id); if (!e) return err(res, 404, "Empresa no encontrada.");
  res.json({ ...base, org: vistaOrg(e, req.u), precios: { mensual: VALOR_MENSUAL, modulos: MODULOS, ia: IA_PAQUETES } });
}));

// Datos de la empresa (desde memoria). Si la versión no cambió, responde corto.
app.get("/api/datos", sesion, envolver(empresaActiva), envolver(async (req, res) => {
  const e = req.org;
  if (String(req.query.v) === String(e.version)) return res.json({ version: e.version, sinCambios: true });
  const datos = {}; for (const c of COLECCIONES) datos[c] = [...e.cols[c]].map(([id, d]) => ({ id, ...d }));
  res.json({ version: e.version, datos, org: vistaOrg(e, req.u) });
}));
function puedeEscribir(req, res) {
  const { col, id } = req.params;
  if (!COLECCIONES.has(col) || !ID_OK.test(id)) { err(res, 400, "Ruta no válida."); return false; }
  if (req.u.rol === "consulta") { err(res, 403, "Su usuario es solo de consulta: no puede hacer cambios."); return false; }
  if (col === "bitacora") { // la bitácora del inventor es prueba legal: no se borra ni se reescribe; solo se anula con motivo
    if (req.control) { err(res, 403, "En modo Superadministrador no se escribe en la bitácora del inventor de la empresa."); return false; }
    const existe = req.org.cols.bitacora.has(id);
    if (req.method === "DELETE") { err(res, 403, "La bitácora del inventor es prueba legal: no se borra. Use «Anular» con un motivo."); return false; }
    if (req.method === "PUT" && existe) { err(res, 403, "Una entrada de la bitácora ya guardada no se puede cambiar. Puede anularla con un motivo y escribir una nueva."); return false; }
    if (req.method === "PATCH") { const b = req.body || {}; const ks = Object.keys(b); const mot = String(b.motivo || "").trim();
      if (ks.some(k => !["anulada", "motivo"].includes(k)) || b.anulada !== true || mot.length < 5) { err(res, 400, "Para anular una entrada escriba el motivo (mínimo 5 letras)."); return false; }
      const prev = req.org.cols.bitacora.get(id); if (prev && prev.anulada) { err(res, 400, "Esa entrada ya está anulada."); return false; }
      req.body = { anulada: true, motivoAnulacion: mot.slice(0, 300), anuladaEl: new Date().toISOString(), anuladaPor: req.u.nombre }; }
  }
  const m = req.org.info.modulos || {};
  const necesita = col === "licencias" ? "licencias" : col === "movimientos" ? "costos" : col === "config" && id === "grupos" ? "grupos" : null;
  if (necesita && !m[necesita]) { err(res, 403, "Esta función es de un módulo que su empresa no ha activado. Actívelo en el Market.", { modulo: necesita }); return false; }
  return true;
}
async function escribir(e, orgId, col, id, data) {
  if (Buffer.byteLength(JSON.stringify(data)) > MAXDOC) throw Object.assign(new Error("El registro pasa del tamaño máximo (250 KB)."), { status: 413 });
  await q("insert into docs(org_id,col,id,data,actualizado) values($1,$2,$3,$4,now()) on conflict(org_id,col,id) do update set data=excluded.data, actualizado=now()", [orgId, col, id, data]);
  e.cols[col].set(id, data); e.version = Date.now();
}
function fusionar(a, b) { const o = { ...a }; for (const k in b) { const v = b[k]; o[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? fusionar(a[k], v) : v; } return o; }
app.put("/api/doc/:col/:id", sesion, envolver(empresaActiva), envolver(async (req, res) => {
  if (!puedeEscribir(req, res)) return;
  const data = req.body; if (!data || typeof data !== "object" || Array.isArray(data)) return err(res, 400, "Documento no válido.");
  delete data.id;
  if (req.params.col === "bitacora") { // el servidor pone la fecha y el autor reales del registro
    for (const k of ["registradoEl", "registradoPor", "anulada", "motivoAnulacion", "anuladaEl", "anuladaPor"]) delete data[k];
    data.registradoEl = new Date().toISOString(); data.registradoPor = req.u.nombre;
  }
  await enCola("docs:" + req.u.org_id, () => { if (req.params.col === "bitacora" && req.org.cols.bitacora.has(req.params.id)) throw Object.assign(new Error("Esa entrada de la bitácora ya existe y no se puede cambiar."), { status: 403 }); return escribir(req.org, req.u.org_id, req.params.col, req.params.id, data); });
  res.json({ ok: true, version: req.org.version });
}));
app.patch("/api/doc/:col/:id", sesion, envolver(empresaActiva), envolver(async (req, res) => {
  if (!puedeEscribir(req, res)) return;
  const data = req.body; if (!data || typeof data !== "object" || Array.isArray(data)) return err(res, 400, "Cambio no válido.");
  delete data.id;
  await enCola("docs:" + req.u.org_id, async () => {
    const prev = req.org.cols[req.params.col].get(req.params.id);
    if (!prev) throw Object.assign(new Error("El registro ya no existe."), { status: 404 });
    if (req.params.col === "bitacora" && prev.anulada) throw Object.assign(new Error("Esa entrada ya está anulada."), { status: 400 });
    await escribir(req.org, req.u.org_id, req.params.col, req.params.id, fusionar(prev, data));
  });
  res.json({ ok: true, version: req.org.version });
}));
app.delete("/api/doc/:col/:id", sesion, envolver(empresaActiva), envolver(async (req, res) => {
  if (!puedeEscribir(req, res)) return;
  await enCola("docs:" + req.u.org_id, async () => { await q("delete from docs where org_id=$1 and col=$2 and id=$3", [req.u.org_id, req.params.col, req.params.id]); req.org.cols[req.params.col].delete(req.params.id); req.org.version = Date.now(); });
  res.json({ ok: true, version: req.org.version });
}));
// Restaurar un respaldo de la empresa (reemplaza todos sus datos). Solo el administrador.
app.post("/api/importar", sesion, sinControl, envolver(empresaActiva), soloAdmin, envolver(async (req, res) => {
  const b = req.body || {}; const filas = [];
  for (const c of COLECCIONES) for (const d of Array.isArray(b[c]) ? b[c] : []) {
    if (!d || typeof d !== "object" || !ID_OK.test(String(d.id || ""))) continue;
    const { id, ...data } = d;
    if (c === "archivos" && data.assetId && !data.url) continue;
    const mods = req.org.info.modulos || {};
    if (c === "bitacora" && !req.org.cols.bitacora.has(String(id))) data.importadoEl = new Date().toISOString(); // lo restaurado queda marcado
    if ((c === "licencias" && !mods.licencias) || (c === "movimientos" && !mods.costos) || (c === "config" && String(id) === "grupos" && !mods.grupos)) continue;
    if (Buffer.byteLength(JSON.stringify(data)) > MAXDOC) return err(res, 413, `El registro ${c}/${id} pasa de 250 KB.`);
    filas.push([c, String(id), data]);
  }
  const orgId = req.u.org_id;
  await enCola("docs:" + orgId, async () => {
    const cli = await pool.connect();
    try {
      // la bitácora del inventor no se borra al restaurar: se conservan sus entradas y se agregan las del respaldo que falten
      await cli.query("begin"); await cli.query("delete from docs where org_id=$1 and col<>'bitacora'", [orgId]);
      for (const [c, id, data] of filas) await cli.query("insert into docs(org_id,col,id,data) values($1,$2,$3,$4)" + (c === "bitacora" ? " on conflict do nothing" : ""), [orgId, c, id, data]);
      await cli.query("commit");
    } catch (e) { await cli.query("rollback").catch(() => {}); throw e; } finally { cli.release(); }
    cache.delete(orgId);
  });
  res.json({ ok: true, importados: filas.length });
}));

/* ---------- usuarios de la empresa (el administrador los maneja; usuarios ilimitados) ---------- */
app.get("/api/usuarios", sesion, envolver(empresaActiva), soloAdmin, envolver(async (req, res) => {
  const { rows } = await q("select u.id,u.nombre,u.email,u.rol,u.activo,(u.clave_hash is not null) tiene_clave,a.ultimo from usuarios u left join accesos a on a.usuario_id=u.id where u.org_id=$1 order by u.creado", [req.u.org_id]);
  res.json({ usuarios: rows });
}));
app.post("/api/usuarios", sesion, sinControl, envolver(empresaActiva), soloAdmin, envolver(async (req, res) => {
  const nombre = String(req.body.nombre || "").trim().slice(0, 80), email = String(req.body.email || "").trim().toLowerCase(), rol = ROLES.includes(req.body.rol) ? req.body.rol : "investigador";
  if (nombre.length < 3 || !emailValido(email)) return err(res, 400, "Escriba el nombre y un correo válido.");
  if (!limitar("invitar:" + req.u.org_id, 30, 60)) return err(res, 429, "Ya invitó a muchas personas seguidas. Espere un momento.");
  const ya = await q("select 1 from usuarios where email=$1", [email]); if (ya.rows.length) return err(res, 400, "Ese correo ya tiene cuenta en Patent-IA (quizás en otra empresa).");
  const id = "u-" + crypto.randomBytes(5).toString("hex");
  await q("insert into usuarios(id,org_id,email,nombre,rol) values($1,$2,$3,$4,$5)", [id, req.u.org_id, email, nombre, rol]);
  const enlace = await enviarEnlace(email, "invitacion");
  res.json({ ok: true, id, ...(MODO_PRUEBA && typeof enlace === "string" ? { enlace } : {}) });
}));
app.patch("/api/usuarios/:id", sesion, sinControl, envolver(empresaActiva), soloAdmin, envolver(async (req, res) => {
  const { rows } = await q("select * from usuarios where id=$1 and org_id=$2", [req.params.id, req.u.org_id]); if (!rows.length) return err(res, 404, "Usuario no encontrado.");
  const u = rows[0]; const rol = req.body.rol !== undefined ? (ROLES.includes(req.body.rol) ? req.body.rol : u.rol) : u.rol;
  const activo = req.body.activo !== undefined ? !!req.body.activo : u.activo; const nombre = req.body.nombre ? String(req.body.nombre).trim().slice(0, 80) : u.nombre;
  if (u.rol === "admin" && (rol !== "admin" || !activo)) { const n = await q("select count(*)::int n from usuarios where org_id=$1 and rol='admin' and activo and id<>$2", [req.u.org_id, u.id]); if (!n.rows[0].n) return err(res, 400, "La empresa debe tener al menos un administrador activo."); }
  await q("update usuarios set rol=$1, activo=$2, nombre=$3 where id=$4", [rol, activo, nombre, u.id]);
  if (!activo || rol !== u.rol) await q("delete from sesiones where usuario_id=$1", [u.id]);
  res.json({ ok: true });
}));
app.post("/api/usuarios/:id/reenviar", sesion, sinControl, envolver(empresaActiva), soloAdmin, envolver(async (req, res) => {
  const { rows } = await q("select email,clave_hash from usuarios where id=$1 and org_id=$2", [req.params.id, req.u.org_id]); if (!rows.length) return err(res, 404, "Usuario no encontrado.");
  if (!limitar("reenviar:" + req.params.id, 3, 60)) return err(res, 429, "Ya se reenvió varias veces. Espere una hora.");
  const enlace = await enviarEnlace(rows[0].email, rows[0].clave_hash ? "recuperar" : "invitacion");
  res.json({ ok: true, ...(MODO_PRUEBA && typeof enlace === "string" ? { enlace } : {}) });
}));

/* ---------- pagos con el Bold de SkyNet Genesis ---------- */
function interpretarPlan(plan) {
  const p = String(plan || "");
  if (p === `${APP_ID}:mensual`) return { mensual: true, modulos: [] };
  const ia = /^patent-ia:(ia\d+)$/.exec(p); if (ia && IA_PAQUETES[ia[1]]) return { mensual: false, modulos: [], ia: ia[1] };
  let m = /^patent-ia:mod-([a-z]+)$/.exec(p); if (m && MODULOS[m[1]]) return { mensual: false, modulos: [m[1]] };
  m = /^patent-ia:paq((?:_[a-z0-9-]+){1,12})$/.exec(p);
  if (m) { const partes = [...new Set(m[1].split("_").filter(Boolean))]; if (partes.some(x => x !== "mensual" && !IA_PAQUETES[x] && !(x.startsWith("mod-") && MODULOS[x.slice(4)]))) return null;
    const ias = partes.filter(x => IA_PAQUETES[x]); if (ias.length > 1) return null;
    return { mensual: partes.includes("mensual"), modulos: partes.filter(x => x.startsWith("mod-")).map(x => x.slice(4)), ia: ias[0] || null }; }
  return null;
}
async function reservarClaves(claves, pagoId) {
  const cli = await pool.connect();
  try { await cli.query("begin"); for (const k of claves) { const r = await cli.query("insert into pagos_claves(clave,pago_id) values($1,$2) on conflict do nothing returning clave", [k, pagoId]); if (!r.rows.length) { await cli.query("rollback"); return false; } } await cli.query("commit"); return true; }
  catch (e) { await cli.query("rollback").catch(() => {}); throw e; } finally { cli.release(); }
}
async function aplicarPago(d, forzar) {
  const plan = String(d.plan || ""), pagoId = String(d.pago_id || d.pagoId || "").slice(0, 80), ref = String(d.referencia || "").slice(0, 100), orgId = String(d.empresa || "").split("~")[0];
  if (!pagoId && !ref) return { ok: false, error: "pago" };
  const claves = [...new Set([pagoId && "pago:" + pagoId, ref && "ref:" + ref].filter(Boolean))];
  if (plan === `${APP_ID}:prueba`) { if (await reservarClaves(claves, pagoId || ref)) { await q("insert into pagos_bold(pago_id,org_id,plan,valor,resultado) values($1,$2,$3,$4,$5) on conflict do nothing", [pagoId || ref, orgId, plan, +d.valor || 0, { prueba: true }]); avisarSA(`Pago de prueba con Bold recibido: $${Number(d.valor || 0).toLocaleString("es-CO")} (pago ${pagoId || ref}). La conexión con Bold funciona.`); } return { ok: true }; }
  const pq = interpretarPlan(plan); if (!pq) return { ok: false, error: "plan" };
  if (!orgId || orgId === "plataforma") return { ok: false, error: "empresa" };
  const e = await cargar(orgId); if (!e) return { ok: false, error: "empresa" };
  // Primero se reservan las claves del pago (pago_id y referencia del pedido): un mismo pago nunca se aplica dos veces, aunque lleguen avisos al mismo tiempo
  if (!await reservarClaves(claves, pagoId || ref)) return { ok: true, repetido: true };
  const meses = 1, valor = +d.valor || 0; // solo pago mes a mes (sin pagos anuales ni de varios meses)
  const esperado = (pq.mensual ? (e.info.valor || VALOR_MENSUAL) : 0) + pq.modulos.reduce((s, m) => s + MODULOS[m], 0) + (pq.ia ? IA_PAQUETES[pq.ia].valor : 0);
  let resultado;
  try {
    await cambiarInfo(orgId, async info => {
      const reg = { pagoId: pagoId || ref, plan, valor, meses, fecha: new Date().toISOString(), referencia: ref, medio: "Bold" };
      if (!forzar && valor + 1 < esperado) { reg.paraRevisar = true; (info.pagos = info.pagos || []).push(reg); resultado = { paraRevisar: true }; return; }
      const hoyP = hoyCO();
      if (pq.mensual) {
        info.pagadoHasta = phTrasPago(info, hoyP, 1);
        if (info.prueba && !info.prueba.terminada) { info.prueba.terminada = true; info.prueba.pagada = hoyP; }
        reg.pagadoHasta = info.pagadoHasta;
      }
      if (pq.ia) { const pk = IA_PAQUETES[pq.ia]; info.ia = info.ia || { creditos: 0, usados: 0 };
        const L = lotesIA(info, hoyP); L.push({ c: pk.creditos, vence: sumarDias(hoyP, IA_DIAS - 1) }); guardarLotes(info, L); info.ia.plan = pq.ia; reg.iaVence = sumarDias(hoyP, IA_DIAS - 1); (info.ia.compras = info.ia.compras || []).push({ paquete: pq.ia, creditos: pk.creditos, pagoId: reg.pagoId, fecha: reg.fecha }); if (!tieneModulo(info)) reg.iaSinModulo = true; reg.creditosIA = pk.creditos; }
      for (const m of pq.modulos) { info.modulos = info.modulos || {}; if (info.modulos[m]) reg.yaActivo = (reg.yaActivo || []).concat(m); info.modulos[m] = true; (info.compras = info.compras || []).push({ modulo: m, pagoId: reg.pagoId, fecha: reg.fecha, valor: MODULOS[m] }); }
      (info.pagos = info.pagos || []).push(reg); if (info.pagos.length > 200) info.pagos = info.pagos.slice(-200);
      resultado = { aplicado: true, pagadoHasta: info.pagadoHasta, modulos: pq.modulos, ...(pq.ia ? { creditosIA: IA_PAQUETES[pq.ia].creditos, iaVence: reg.iaVence } : {}) };
    });
  } catch (er) { await q("delete from pagos_claves where clave = any($1)", [claves]).catch(() => {}); throw er; }
  await q("insert into pagos_bold(pago_id,org_id,plan,valor,resultado) values($1,$2,$3,$4,$5) on conflict do nothing", [pagoId || ref, orgId, plan, valor, resultado]);
  avisarSA(resultado.paraRevisar ? `Pago Bold para revisar en ${e.info.nombre}: $${valor.toLocaleString("es-CO")} no cubre ${plan}.` : `Pago Bold de ${e.info.nombre}: ${plan} por $${valor.toLocaleString("es-CO")}.`);
  log("Pago Bold", orgId, pagoId || ref, JSON.stringify(resultado));
  return { ok: true, ...resultado };
}
// Consulta al verificador central de skynetgenesis.com (no necesita secretos): solo aplica lo que el central confirma
async function verificarCentral(params) {
  const u = `${VERIFICADOR}?${new URLSearchParams({ ...params, app: APP_ID })}`;
  const r = await fetch(u, { headers: { "User-Agent": "SkyNetGenesis-PatentIA/1.0", Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => ({}));
  if (!j || !j.ok) return null;
  const o = j.orden || j.pedido || j.pago || j;
  const v = { plan: o.plan, empresa: o.empresa, meses: o.meses, valor: o.valor ?? o.monto ?? o.amount, pago_id: o.pago_id || o.pagoId || "", referencia: o.referencia || o.orderId || o.order_id || params.ref || "" };
  if (!v.plan || !v.empresa || v.valor == null || (!v.pago_id && !v.referencia)) return null;
  return v;
}
async function aplicarBold(req, res) {
  try {
    const cuerpo = req.body instanceof Buffer ? req.body : Buffer.from("");
    let d; try { d = JSON.parse(cuerpo.toString("utf8")); } catch { return res.status(400).json({ ok: false }); }
    const firma = String(req.headers["x-skynet-firma"] || "");
    if (BOLD_SECRETO) { // con secreto configurado, la firma es obligatoria
      const esperada = crypto.createHmac("sha256", BOLD_SECRETO).update(cuerpo).digest("hex");
      if (firma.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) { log("Pago Bold con firma inválida"); return res.status(401).json({ ok: false }); }
    } else { // sin secreto: solo se aplica lo que confirma el verificador central, con sus propios datos
      if (!limitar("bold:" + ipDe(req), 30, 10)) return res.status(429).json({ ok: false });
      const v = await verificarCentral({ pago: String(d.pago_id || d.pagoId || "") }).catch(() => null);
      if (!v) { log("Pago Bold no confirmado por el verificador", d.pago_id); return res.status(401).json({ ok: false }); }
      d = v;
    }
    if (!String(d.plan || "").startsWith(APP_ID + ":")) return res.status(400).json({ ok: false, error: "plan" });
    const r = await aplicarPago(d);
    res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true } : r);
  } catch (e) { log("pago Bold", e.message); res.status(500).json({ ok: false }); }
}
// Al volver de Bold: respaldo por si el aviso de Bold tarda o no llega
app.post("/api/bold/volver", sesion, sinControl, envolver(async (req, res) => {
  const ref = String(req.body.ref || "").slice(0, 100); if (!ref) return err(res, 400, "Falta la referencia.");
  if (!limitar("volver:" + req.u.org_id, 10, 10)) return res.json({ ok: false });
  const v = await verificarCentral({ ref }).catch(() => null);
  if (!v) return res.json({ ok: false, pendiente: true });
  if (String(v.empresa || "").split("~")[0] !== req.u.org_id) return res.json({ ok: false });
  const r = await aplicarPago(v); res.json(r);
}));

/* ---------- IA para empresas (créditos prepagados; el costo real nunca supera lo cobrado) ---------- */
const mesCO = () => hoyCO().slice(0, 7);
const sinTilde = t => String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const RAICES_TEMA = ["protej", "patent", "invent", "invenc", "modelo de utilidad", "diseno", "marca", "software", "registr", "dnda", "derecho de autor", "licenc", "regalia", "contrat", "cesion", "confidencial", "secreto", "producto", "prototip", "innova", "reivindic", "solicitud", "radic", "novedad", "estado del arte", "antecedent", "nivel inventivo", "aplicacion industrial", "fabric", "material", "pieza", "mecanism", "funcion", "mercado", "vender", "venta", "precio", "costo", "tasa", "comprador", "empresa", "inversion", "grupo", "minciencias", "gruplac", "cvlac", "articulo", "investig", "proyecto", "dibujo", "plano", "figura", "protec", "propiedad", "tecnolog", "tecnic", "ingenier", "prueba", "ensayo", "proceso", "metodo", "dispositivo", "sistema", "aparato", "aplicacion", "plazo", "examen", "oposicion", "anualidad", "pct", "internacional", "decision 486", "ompi", "wipo", "cpc", "claim"];
// Pregunta del tema: contiene una raíz de propiedad intelectual o comparte una palabra (5+ letras) con los datos del proyecto
function temaPatentes(pregunta, contexto) {
  const p = sinTilde(pregunta); const pal = p.match(/[a-z0-9]+/g) || [];
  // raíces al comienzo de una palabra (así "pieza" no coincide con "empieza" ni "venta" con "ventana")
  if (RAICES_TEMA.some(r => r.includes(" ") ? p.includes(r) : pal.some(w => w.startsWith(r) && !(r === "venta" && w.startsWith("ventan")))) || /\b(sic|nda|app|idea|ideas|pi)\b/.test(p)) return true;
  const resto = new Set(sinTilde(contexto).match(/[a-z0-9]{5,}/g) || []); // solo los datos del proyecto (sin las instrucciones fijas)
  return (p.match(/[a-z0-9]{5,}/g) || []).some(w => resto.has(w));
}
const SISTEMA_IA = "Trabajas dentro de Patent-IA (SkyNet Genesis), una aplicación para crear, proteger y licenciar inventos, diseños, software y otras creaciones en Colombia. Responde solo sobre propiedad intelectual, innovación, investigación y el proyecto que te muestran; si piden otra cosa, dilo con amabilidad y vuelve al tema. Español latinoamericano neutro.";
app.post("/api/ia", sesion, sinControl, envolver(empresaActiva), envolver(async (req, res) => {
  if (req.u.rol === "consulta") return err(res, 403, "Su usuario es solo de consulta: no puede usar la IA.");
  if (!ANTHROPIC_KEY) return err(res, 503, "La IA no está disponible en este momento.", { ia: "servicio" });
  const prompt = String(req.body.prompt || ""); const nivel = req.body.nivel === "complex" ? "complex" : "default"; const M = IA_MODELOS[nivel];
  if (prompt.length < 5) return err(res, 400, "Falta el pedido.");
  // filtro propio sin costo: una pregunta libre que no es del tema no se envía a la IA ni gasta créditos
  if (req.body.pregunta !== undefined && !temaPatentes(String(req.body.pregunta), String(req.body.contexto || ""))) return err(res, 422, "Esa pregunta no parece de su proyecto ni de propiedad intelectual, así que no se envió a la IA ni se descontaron créditos. Pregunte sobre su invento, la protección, la solicitud ante la SIC, la venta o la licencia.", { code: "fuera_tema" });
  if (prompt.length > 40000) return err(res, 413, "El texto es demasiado largo para enviarlo de una vez. Acórtelo.", { code: "prompt_too_large" });
  if (!limitar("ia:" + req.u.org_id, 20, 1) || !limitar("iah:" + req.u.org_id, 300, 60)) return err(res, 429, "Muchas consultas seguidas. Espere un momento.", { code: "rate_limited" });
  // costo en US$ por token y tope de salida que cabe en los créditos reservados
  const pin = M.entrada / 1e6, pout = M.salida / 1e6, tokIn = Math.ceil((prompt.length + SISTEMA_IA.length) / 3) + 50;
  const reservaMax = nivel === "complex" ? 12 : 4;
  let reservados = 0;
  await cambiarInfo(req.u.org_id, info => { const c = iaVigentes(info, hoyCO()); reservados = Math.min(reservaMax, c); if (reservados >= 1) tomarIA(info, hoyCO(), reservados); else if (info.ia) guardarLotes(info, []); });
  if (reservados < 1) return err(res, 402, "Su empresa no tiene créditos de IA vigentes. El administrador puede tomar un plan de IA en Mi empresa → Market.", { ia: "sinCreditos" });
  const devolver = async n => { if (n > 0) await cambiarInfo(req.u.org_id, info => { devolverIA(info, hoyCO(), n); }).catch(e => log("devolver créditos", e.message)); };
  const presupuesto = reservados * IA_USD_CREDITO;
  const maxTokens = Math.min(M.maxSalida, Math.floor((presupuesto - tokIn * pin) / pout));
  if (maxTokens < 250) { await devolver(reservados); return err(res, 402, "Le quedan muy pocos créditos de IA para este pedido. Compre más en el Market.", { ia: "sinCreditos" }); }
  // el tope del mes se reserva antes de llamar (así varias consultas a la vez no lo pasan) y luego se ajusta al costo real
  const mes = mesCO(); await q("insert into ia_gasto(mes) values($1) on conflict do nothing", [mes]);
  const cupo = await q("update ia_gasto set usd=usd+$2, llamadas=llamadas+1 where mes=$1 and usd+$2 <= $3 returning usd", [mes, presupuesto, IA_TOPE_USD_MES]);
  if (!cupo.rows.length) { await devolver(reservados); if (limitar("tope-aviso:" + mes, 1, 60 * 24 * 31)) avisarSA(`Patent-IA llegó al tope de gasto de IA del mes (US$ ${IA_TOPE_USD_MES}). Las consultas de IA quedaron en pausa hasta el mes siguiente (o hasta subir IA_TOPE_USD_MES en Render).`); return err(res, 503, "La IA está en pausa este mes por alta demanda. Escríbanos por WhatsApp; no se descontaron créditos.", { ia: "tope" }); }
  const ajustarGasto = usd => q("update ia_gasto set usd=greatest(0,usd+$2) where mes=$1", [mes, usd]).catch(e => log("ia_gasto", e.message));
  let j;
  try {
    const r = await fetch(IA_URL, { method: "POST", signal: AbortSignal.timeout(110000),
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: M.id, max_tokens: maxTokens, system: SISTEMA_IA, messages: [{ role: "user", content: prompt }] }) });
    j = await r.json().catch(() => ({}));
    if (!r.ok) { log("Anthropic respondió", r.status, JSON.stringify(j).slice(0, 300)); await devolver(reservados); await ajustarGasto(-presupuesto); await q("update ia_gasto set llamadas=greatest(0,llamadas-1) where mes=$1", [mes]).catch(() => {}); if (r.status === 401 || r.status === 403 || r.status === 400 && /credit/i.test(JSON.stringify(j))) avisarSA("La llave o el saldo de la API de Anthropic de Patent-IA tiene un problema (" + r.status + ")."); return err(res, r.status === 429 || r.status === 529 ? 429 : 502, "La IA no respondió. Intente de nuevo en un momento; no se descontaron créditos.", { code: r.status === 429 || r.status === 529 ? "rate_limited" : "ia" }); }
  } catch (e) { // tiempo agotado o corte: Anthropic puede cobrar igual, así que se cobra lo reservado (nunca se pierde dinero)
    log("IA", e.message); await cambiarInfo(req.u.org_id, info => { info.ia.usados = (info.ia.usados || 0) + reservados; }).catch(() => {});
    return err(res, 504, `La IA tardó demasiado y se cortó (se descontaron ${reservados} crédito(s)). Pida algo más corto o intente de nuevo.`, { code: "ia" }); }
  const uso = j.usage || {}; const costo = (uso.input_tokens || tokIn) * pin + (uso.output_tokens || maxTokens) * pout;
  const cobrados = Math.min(reservados, Math.max(1, Math.ceil(costo / IA_USD_CREDITO - 1e-9)));
  await devolver(reservados - cobrados);
  await cambiarInfo(req.u.org_id, info => { info.ia.usados = (info.ia.usados || 0) + cobrados; });
  await ajustarGasto(costo - presupuesto);
  const text = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  res.json({ text, truncated: j.stop_reason === "max_tokens", cobrados, creditos: iaVigentes(req.org.info, hoyCO()) });
}));

/* ---------- superadministrador ---------- */
app.get("/api/super/empresas", sesion, soloSuper, envolver(async (req, res) => {
  const { rows } = await q("select id, info, creado from orgs where id<>'plataforma' order by creado");
  const us = await q("select org_id, count(*) filter (where activo)::int n, max(a.ultimo) ultimo, array_agg(email) filter (where rol='admin') admins from usuarios u left join accesos a on a.usuario_id=u.id group by org_id");
  const pr = await q("select org_id, count(*)::int n from docs where col='proyectos' group by org_id");
  const U = new Map(us.rows.map(r => [r.org_id, r])), P = new Map(pr.rows.map(r => [r.org_id, r.n])); const hoy = hoyCO();
  const g = await q("select usd, llamadas from ia_gasto where mes=$1", [mesCO()]);
  res.json({ ia: { servicio: !!ANTHROPIC_KEY, gastoMesUSD: g.rows.length ? +(+g.rows[0].usd).toFixed(2) : 0, llamadas: g.rows.length ? g.rows[0].llamadas : 0, topeUSD: IA_TOPE_USD_MES }, empresas: rows.map(r => ({ id: r.id, nombre: r.info.nombre, creado: r.creado, pago: estadoPago(r.info, hoy), pagadoHasta: r.info.pagadoHasta, valor: r.info.valor || VALOR_MENSUAL, interna: !!r.info.interna, modulos: r.info.modulos || {}, suspendida: r.info.suspendida || null, ia: { creditos: iaVigentes(r.info, hoy), vence: lotesIA(r.info, hoy).map(l => l.vence).pop() || null, usados: (r.info.ia || {}).usados || 0 },
    usuarios: (U.get(r.id) || {}).n || 0, admins: (U.get(r.id) || {}).admins || [], ultimo: (U.get(r.id) || {}).ultimo || null, proyectos: P.get(r.id) || 0, pagos: (r.info.pagos || []).slice(-10).reverse() })) });
}));
app.get("/api/super/empresa/:id", sesion, soloSuper, envolver(async (req, res) => {
  if (req.params.id === "plataforma") return err(res, 404, "No encontrado.");
  const e = await cargar(req.params.id); if (!e) return err(res, 404, "Empresa no encontrada.");
  const us = await q("select u.nombre,u.email,u.rol,u.activo,(u.clave_hash is not null) tiene_clave,a.ultimo from usuarios u left join accesos a on a.usuario_id=u.id where u.org_id=$1 order by u.creado", [req.params.id]);
  const pr = [...e.cols.proyectos.values()].map(p => ({ codigo: p.codigo, titulo: p.titulo, etapa: p.etapa, modalidad: p.modalidad }));
  res.json({ id: req.params.id, nombre: e.info.nombre, info: { pagadoHasta: e.info.pagadoHasta, prueba: e.info.prueba || null, ia: { creditos: iaVigentes(e.info, hoyCO()), vence: iaVigentes(e.info, hoyCO()) ? e.info.ia.vence : null, usados: (e.info.ia || {}).usados || 0 }, modulos: e.info.modulos || {}, suspendida: e.info.suspendida || null, interna: !!e.info.interna, pagos: (e.info.pagos || []).slice(-30).reverse(), compras: (e.info.compras || []).slice(-30).reverse() }, pago: estadoPago(e.info, hoyCO()), usuarios: us.rows, proyectos: pr,
    totales: Object.fromEntries([...COLECCIONES].map(c => [c, e.cols[c].size])) });
}));
app.post("/api/super/empresa/:id", sesion, soloSuper, envolver(async (req, res) => {
  if (req.params.id === "plataforma") return err(res, 400, "No aplica.");
  const d = req.body || {};
  if (["pagadoHasta", "modulo", "creditosIA", "activo"].some(k => d[k] !== undefined)) return err(res, 400, "El Superadministrador no cambia fechas de pago, módulos ni créditos: eso solo lo hace Bold. Para un pago aprobado que no llegó use «Corregir un pago de Bold».");
  // "No regalamos nuestro trabajo": el Superadministrador no cambia fechas de pago, módulos ni créditos (eso solo lo hace Bold).
  // Solo marca empresas internas de SkyNet Genesis, suspende y aplica pagos que Bold aprobó y no llegaron (ruta /aplicar-pago).
  await cambiarInfo(req.params.id, async info => {
    if (d.interna !== undefined) { info.interna = !!d.interna; avisarSA(`Empresa ${info.nombre} marcada como ${info.interna ? "interna de SkyNet Genesis (sin cobro)" : "cliente (con cobro)"}.`); }
    if (d.suspender !== undefined) info.suspendida = d.suspender ? { motivo: String(d.motivo || "").slice(0, 200), fecha: new Date().toISOString() } : null;
  });
  res.json({ ok: true });
}));
/* ---------- manuales del usuario (PDF genéricos): cada usuario solo lee el suyo ---------- */
const MANUALES = { general: "00-Manual-general", admin: "01-Manual-Administrador", investigador: "02-Manual-Investigador", consulta: "03-Manual-Solo-consulta" };
app.get("/api/manual", sesion, envolver(async (req, res) => {
  const p = String(req.query.p || "general");
  if (!MANUALES[p]) return err(res, 400, "Manual no válido.");
  const permitidos = req.super ? Object.keys(MANUALES) : ["general", req.u.rol];
  if (!permitidos.includes(p)) return err(res, 403, "Ese manual no es de su perfil.");
  const { rows } = await q("select pdf from manuales where clave=$1", [p]);
  if (!rows.length) return err(res, 404, "El manual aún no está disponible. Escríbanos a contacto@skynetgenesis.com.");
  res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `inline; filename="${MANUALES[p]}-Patent-IA.pdf"`); res.send(rows[0].pdf);
}));
app.get("/api/super/manuales", sesion, soloSuper, envolver(async (req, res) => { const { rows } = await q("select clave, actualizado, length(pdf) bytes from manuales"); res.json({ manuales: rows, claves: MANUALES }); }));
app.post("/api/super/manuales/:p", sesion, soloSuper, envolver(async (req, res) => {
  const p = req.params.p; if (!MANUALES[p]) return err(res, 400, "Manual no válido.");
  const b = Buffer.from(String(req.body.pdf || "").replace(/^data:application\/pdf;base64,/, ""), "base64");
  if (b.length < 1000 || b.subarray(0, 5).toString() !== "%PDF-") return err(res, 400, "El archivo no es un PDF.");
  await q("insert into manuales(clave,pdf,actualizado) values($1,$2,now()) on conflict(clave) do update set pdf=excluded.pdf, actualizado=now()", [p, b]);
  res.json({ ok: true, bytes: b.length });
}));
// Corrección: aplicar un pago que Bold aprobó pero no se aplicó (solo lo que confirma el verificador central)
app.post("/api/super/aplicar-pago", sesion, soloSuper, envolver(async (req, res) => {
  const ref = String(req.body.ref || "").trim().slice(0, 100), pago = String(req.body.pago || "").trim().slice(0, 80);
  if (!ref && !pago) return err(res, 400, "Escriba la referencia del pedido o el número del pago de Bold.");
  const v = await verificarCentral(ref ? { ref } : { pago }).catch(() => null);
  if (!v) return err(res, 404, "Bold no confirma ese pago (o aún no está aprobado). No se aplicó nada.");
  if (!String(v.plan || "").startsWith(APP_ID + ":")) return err(res, 400, "Ese pago no es de Patent-IA.");
  const r = await aplicarPago(v);
  if (r.ok && !r.repetido) avisarSA(`Superadministrador aplicó a mano el pago ${v.pago_id || v.referencia} (${v.plan}) confirmado por Bold.`);
  res.json(r);
}));
// Entrar a una empresa como su administrador (por calidad y soporte). No paga, no invita, no gasta IA; queda en la bitácora de la plataforma
// Un pago real de Bold que quedó "para revisar" (valor menor al esperado) se entrega con motivo; queda en la bitácora de la plataforma
app.post("/api/super/revisar-pago", sesion, soloSuper, envolver(async (req, res) => {
  const orgId = String(req.body.empresa || ""), pagoId = String(req.body.pagoId || ""), motivo = String(req.body.motivo || "").trim();
  if (motivo.length < 10) return err(res, 400, "Escriba el motivo (mínimo 10 letras).");
  const e = await cargar(orgId); if (!e) return err(res, 404, "Empresa no encontrada.");
  const reg = (e.info.pagos || []).find(x => x.pagoId === pagoId && x.paraRevisar && !x.revisado);
  if (!reg) return err(res, 404, "No hay un pago para revisar con ese número.");
  const r = await aplicarPago({ plan: reg.plan, empresa: orgId, valor: reg.valor, pago_id: "rev-" + pagoId, referencia: "" }, true);
  if (r.ok) { await cambiarInfo(orgId, info => { const x = (info.pagos || []).find(y => y.pagoId === pagoId && y.paraRevisar); if (x) { x.revisado = { motivo: motivo.slice(0, 300), fecha: new Date().toISOString() }; } }); avisarSA(`Superadministrador entregó el pago para revisar ${pagoId} de ${e.info.nombre}: ${motivo}`); }
  res.json(r);
}));
app.post("/api/super/entrar/:id", sesion, soloSuper, envolver(async (req, res) => {
  const id = req.params.id; if (id === "plataforma") return err(res, 400, "No aplica.");
  const e = await cargar(id); if (!e) return err(res, 404, "Empresa no encontrada.");
  const tk = nuevoToken(); await q("insert into sesiones(token_hash,usuario_id,expira,control) values($1,$2,now()+interval '4 hours',$3)", [sha(tk), req.u.id, id]);
  avisarSA(`Superadministrador entró como administrador a ${e.info.nombre}.`);
  res.json({ token: tk });
}));
app.get("/api/super/avisos", sesion, soloSuper, envolver(async (req, res) => {
  const { rows } = await q("select id,texto,creado,leido from avisos_sa order by id desc limit 100");
  if (req.query.marcar) await q("update avisos_sa set leido=true where not leido");
  res.json({ avisos: rows });
}));
app.get("/api/super/respaldo", sesion, soloSuper, envolver(async (req, res) => {
  const orgs = (await q("select id, info from orgs where id<>'plataforma'")).rows;
  const docs = (await q("select org_id,col,id,data from docs")).rows;
  const usuarios = (await q("select id,org_id,email,nombre,rol,activo from usuarios")).rows;
  res.setHeader("Content-Disposition", `attachment; filename="respaldo-patent-ia-${hoyCO()}.json"`);
  res.json({ fecha: new Date().toISOString(), app: "Patent-IA · SkyNet Genesis", orgs, usuarios, docs });
}));

/* Correo diario a las empresas en prueba: cuántos días faltan para que se cierre (y uno final el día del cierre) */
async function correosPrueba() {
  const hoy = hoyCO(); let n = 0;
  const { rows } = await q("select id from orgs where info ? 'prueba' and coalesce((info->'prueba'->>'terminada')::boolean,false)=false and not coalesce((info->>'interna')::boolean,false) and not (info->'prueba' ? 'correoCierre') and info->'prueba'->>'hasta' >= $1", [sumarDias(hoy, -3)]);
  for (const { id } of rows) {
    try {
      const e = await cargar(id); if (!e || e.info.suspendida) continue;
      const pr = e.info.prueba; if (!pr || pr.terminada || pr.correoCierre) continue;
      const p = estadoPago(e.info, hoy); const cierre = p.estado === "bloqueada";
      if (!cierre && pr.ultimoCorreo === hoy) continue;
      if (cierre && diasEntre(pr.hasta, hoy) > 3) continue; // solo se avisa del cierre en los primeros días
      const ad = await q("select email,nombre from usuarios where org_id=$1 and rol='admin' and activo", [id]);
      const titulo = cierre ? "Su prueba gratis de Patent-IA terminó" : p.dias === 1 ? "Hoy es el último día de su prueba gratis" : `Le quedan ${p.dias} días de prueba gratis`;
      const cuerpo = cierre ? `<p style="margin:0 0 10px">Los 15 días de prueba de <b>${escH(e.info.nombre)}</b> terminaron y el acceso quedó cerrado. Sus proyectos y datos siguen guardados.</p><p style="margin:0">Pague la mensualidad (${"$" + VALOR_MENSUAL.toLocaleString("es-CO")} al mes por empresa, usuarios ilimitados) y vuelve a entrar de inmediato. La prueba gratis no se renueva.</p>`
        : `<p style="margin:0 0 10px">A <b>${escH(e.info.nombre)}</b> le ${p.dias === 1 ? "queda <b>1 día</b>" : `quedan <b>${p.dias} días</b>`} de prueba gratis de Patent-IA. La prueba cierra el ${escH(fechaLarga(pr.hasta))} al final del día y no se renueva.</p><p style="margin:0">Para no perder el acceso, entre y pague la mensualidad (${"$" + VALOR_MENSUAL.toLocaleString("es-CO")} al mes por empresa, usuarios ilimitados): su mensualidad empieza cuando termine la prueba (no pierde días de prueba) y, si ese día cae después del 5, el resto de ese mes le sale gratis.</p>`;
      let enviados = 0;
      for (const a of ad.rows) { if (await cuposUsados() >= LIMITE_CORREOS_DIA - 20) break; // se guardan 20 correos al día para registros y claves
        if (await enviarCorreo(a.email, a.nombre, titulo, plantillaCorreo(titulo, cuerpo, { url: APP_URL, texto: cierre ? "Pagar y volver a entrar" : "Entrar y pagar" }))) { enviados++; n++; } }
      if (enviados || (!BREVO_KEY && MODO_PRUEBA)) await cambiarInfo(id, info => { if (!info.prueba) return; info.prueba.ultimoCorreo = hoy; if (cierre) info.prueba.correoCierre = hoy; });
    } catch (er) { log("correo prueba", id, er.message); }
  }
  return n;
}

/* ---------- tareas diarias (las llama cron-job.org) ---------- */
async function tareasDiarias() {
  await q("delete from sesiones where expira<now()"); await q("delete from enlaces where expira<now() - interval '1 day'");
  await q("delete from contador_correos where dia < $1", [new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)]);
  await q("delete from avisos_sa where leido and creado < now() - interval '60 days'");
  // la clave de Brevo caduca tras 30 días sin uso: una consulta diaria (sin enviar correo) la mantiene viva; sirve con claves de solo "Emails transaccionales"
  if (BREVO_KEY) fetch("https://api.brevo.com/v3/smtp/statistics/aggregatedReport?days=1", { headers: { "api-key": BREVO_KEY, accept: "application/json" } }).then(r => { if (r.status === 401) avisarSA("La clave de Brevo de Patent-IA no es válida (401): revísela en Render."); }).catch(() => {});
  for (const [id, o] of cache) if (Date.now() - (o.usado || 0) > 2 * 36e5) cache.delete(id);
  return await correosPrueba();
}
app.post("/api/cron/diario", envolver(async (req, res) => {
  if (!CLAVE_CRON || req.query.clave !== CLAVE_CRON) return err(res, 403, "No autorizado.");
  res.json({ ok: true, correosPrueba: await tareasDiarias() });
}));
/* Tareas diarias automáticas: el despertador de GitHub Actions mantiene el servidor despierto de 5 a. m. a 11 p. m.;
   cada 20 minutos se revisa si ya se hicieron hoy (desde las 7 a. m. de Bogotá). La marca queda en la base, así no se repiten tras un reinicio. */
async function revisarDiarias() {
  try {
    const hora = new Date(Date.now() - 5 * 3600e3).getUTCHours(); if (hora < 7) return;
    const r = await q("insert into contador_correos(dia,n) values($1,0) on conflict(dia) do nothing returning dia", ["cron:" + hoyCO()]);
    if (!r.rows.length) return;
    const n = await tareasDiarias(); log("Tareas diarias hechas; correos de prueba:", n);
  } catch (e) { log("tareas diarias", e.message); }
}

app.use((req, res) => err(res, 404, "No encontrado."));
if (require.main === module) preparar().then(() => { app.listen(PUERTO, () => log(`Patent-IA servidor en el puerto ${PUERTO}`)); setTimeout(revisarDiarias, 60e3); setInterval(revisarDiarias, 20 * 60e3).unref(); }).catch(e => { console.error("No se pudo iniciar:", e); process.exit(1); });
module.exports = { estadoPago, interpretarPlan, sumarMesFin, finMes, normEmpresa, IA_PAQUETES, phTrasPago, iaVigentes, temaPatentes, tomarIA, devolverIA, lotesIA };
