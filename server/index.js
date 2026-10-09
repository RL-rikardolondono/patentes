// Servidor de PatentIA — SkyNet Genesis
// Guarda los documentos de la app en Neon (PostgreSQL) y los sirve desde memoria
// para que la base pueda dormir entre cambios. Un solo usuario administrador.
"use strict";
const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const PUERTO = process.env.PORT || 3000;
const ORIGENES = (process.env.ORIGEN || "https://patentes.skynetgenesis.com").split(",").map(s => s.trim());
const SECRETO = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const CLAVE_RECUP = process.env.CLAVE_RECUPERACION || "";
const COLECCIONES = new Set(["proyectos", "tramites", "licencias", "movimientos", "bitacora", "archivos", "documentos", "config", "dibujos"]);
const MAXDOC = 250000;
const ID_OK = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1|host=\/tmp/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 3, idleTimeoutMillis: 10000
});

// ---------- Memoria ----------
const memoria = {};          // col -> Map(id -> data)
let version = 0;             // cambia con cada escritura
let usuario = null;          // {email, hash, actualizado}
for (const c of COLECCIONES) memoria[c] = new Map();

async function iniciarBase() {
  await pool.query(`create table if not exists docs(
    col text not null, id text not null, data jsonb not null,
    actualizado timestamptz not null default now(), primary key(col,id))`);
  await pool.query(`create table if not exists usuario(
    unico boolean primary key default true check (unico), email text not null,
    hash text not null, actualizado timestamptz not null default now())`);
  const r = await pool.query("select col,id,data from docs");
  for (const f of r.rows) if (memoria[f.col]) memoria[f.col].set(f.id, f.data);
  const u = await pool.query("select email,hash from usuario limit 1");
  usuario = u.rows[0] || null;
  version = Date.now();
  console.log(`Base lista: ${r.rowCount} documentos, administrador ${usuario ? "creado" : "pendiente"}`);
}

// ---------- Utilidades ----------
const b64 = b => Buffer.from(b).toString("base64url");
function firmar(datos) {
  const cuerpo = b64(JSON.stringify(datos));
  const firma = crypto.createHmac("sha256", SECRETO).update(cuerpo).digest("base64url");
  return `${cuerpo}.${firma}`;
}
function verificar(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [cuerpo, firma] = token.split(".");
  const esperada = crypto.createHmac("sha256", SECRETO).update(cuerpo).digest("base64url");
  if (firma.length !== esperada.length || !crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
  try { const d = JSON.parse(Buffer.from(cuerpo, "base64url").toString()); return d.exp > Date.now() ? d : null; } catch { return null; }
}
function fusionar(a, b) {
  const o = { ...a };
  for (const k in b) {
    const v = b[k];
    o[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" && !Array.isArray(a[k]) ? fusionar(a[k], v) : v;
  }
  return o;
}
const intentos = new Map();
function limitar(ip) {
  const ahora = Date.now(); const lista = (intentos.get(ip) || []).filter(t => ahora - t < 15 * 60000);
  lista.push(ahora); intentos.set(ip, lista); return lista.length > 10;
}

// ---------- App ----------
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "6mb" }));
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o && (ORIGENES.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o))) {
    res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
const auth = (req, res, next) => {
  const d = verificar((req.headers.authorization || "").replace(/^Bearer /, ""));
  if (!d || !usuario || d.email !== usuario.email || d.h !== usuario.hash.slice(-12)) return res.status(401).json({ error: "Sesión vencida. Vuelva a entrar." });
  next();
};
const err = (res, n, m) => res.status(n).json({ error: m });

app.get("/api/ping", (req, res) => res.json({ ok: true, hora: new Date().toISOString() }));
app.get("/api/estado", (req, res) => res.json({ administrador: !!usuario }));

app.post("/api/crear-administrador", async (req, res) => {
  if (usuario) return err(res, 409, "El administrador ya existe.");
  const { email, clave, codigo } = req.body || {};
  if (!CLAVE_RECUP) return err(res, 400, "Falta configurar la clave de recuperación en Render.");
  const ca = Buffer.from(String(codigo || "")), cb = Buffer.from(CLAVE_RECUP);
  if (ca.length !== cb.length || !crypto.timingSafeEqual(ca, cb)) return err(res, 401, "La clave de recuperación no coincide con la de Render.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || "") || (clave || "").length < 10) return err(res, 400, "Escriba un correo válido y una contraseña de al menos 10 caracteres.");
  const hash = await bcrypt.hash(clave, 11);
  await pool.query("insert into usuario(email,hash) values($1,$2) on conflict do nothing", [email.toLowerCase(), hash]);
  usuario = { email: email.toLowerCase(), hash };
  res.json({ token: firmar({ email: usuario.email, h: hash.slice(-12), exp: Date.now() + 30 * 864e5 }) });
});

app.post("/api/entrar", async (req, res) => {
  if (limitar(req.ip)) return err(res, 429, "Demasiados intentos. Espere 15 minutos.");
  const { email, clave } = req.body || {};
  if (!usuario || (email || "").toLowerCase() !== usuario.email || !(await bcrypt.compare(clave || "", usuario.hash)))
    return err(res, 401, "Correo o contraseña incorrectos.");
  res.json({ token: firmar({ email: usuario.email, h: usuario.hash.slice(-12), exp: Date.now() + 30 * 864e5 }) });
});

// Recuperación: usa la clave de recuperación que usted guardó en Render
app.post("/api/recuperar", async (req, res) => {
  if (limitar(req.ip)) return err(res, 429, "Demasiados intentos. Espere 15 minutos.");
  const { codigo, clave } = req.body || {};
  if (!CLAVE_RECUP || !usuario) return err(res, 400, "La recuperación no está configurada.");
  const a = Buffer.from(String(codigo || "")), b = Buffer.from(CLAVE_RECUP);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return err(res, 401, "Clave de recuperación incorrecta.");
  if ((clave || "").length < 10) return err(res, 400, "La nueva contraseña debe tener al menos 10 caracteres.");
  const hash = await bcrypt.hash(clave, 11);
  await pool.query("update usuario set hash=$1, actualizado=now()", [hash]);
  usuario.hash = hash;
  res.json({ token: firmar({ email: usuario.email, h: hash.slice(-12), exp: Date.now() + 30 * 864e5 }) });
});

// Todos los datos (desde memoria). Si la versión no cambió, responde corto.
app.get("/api/datos", auth, (req, res) => {
  if (String(req.query.v) === String(version)) return res.json({ version, sinCambios: true });
  const datos = {};
  for (const c of COLECCIONES) datos[c] = [...memoria[c]].map(([id, d]) => ({ id, ...d }));
  res.json({ version, datos });
});

function validar(req, res) {
  const { col, id } = req.params;
  if (!COLECCIONES.has(col) || !ID_OK.test(id)) { err(res, 400, "Ruta no válida."); return false; }
  return true;
}
async function escribir(col, id, data) {
  if (Buffer.byteLength(JSON.stringify(data)) > MAXDOC) throw Object.assign(new Error("grande"), { codigo: 413 });
  await pool.query("insert into docs(col,id,data,actualizado) values($1,$2,$3,now()) on conflict(col,id) do update set data=excluded.data, actualizado=now()", [col, id, data]);
  memoria[col].set(id, data); version = Date.now();
}
app.put("/api/doc/:col/:id", auth, async (req, res) => {
  if (!validar(req, res)) return;
  const data = req.body; if (!data || typeof data !== "object" || Array.isArray(data)) return err(res, 400, "Documento no válido.");
  delete data.id;
  try { await escribir(req.params.col, req.params.id, data); res.json({ ok: true, version }); }
  catch (e) { e.codigo === 413 ? err(res, 413, "El registro pasa del tamaño máximo (250 KB).") : (console.error(e), err(res, 500, "No se pudo guardar.")); }
});
app.patch("/api/doc/:col/:id", auth, async (req, res) => {
  if (!validar(req, res)) return;
  const prev = memoria[req.params.col].get(req.params.id);
  if (!prev) return err(res, 404, "El registro ya no existe.");
  const data = req.body; if (!data || typeof data !== "object" || Array.isArray(data)) return err(res, 400, "Cambio no válido.");
  delete data.id;
  try { await escribir(req.params.col, req.params.id, fusionar(prev, data)); res.json({ ok: true, version }); }
  catch (e) { e.codigo === 413 ? err(res, 413, "El registro pasa del tamaño máximo (250 KB).") : (console.error(e), err(res, 500, "No se pudo guardar.")); }
});
app.delete("/api/doc/:col/:id", auth, async (req, res) => {
  if (!validar(req, res)) return;
  try { await pool.query("delete from docs where col=$1 and id=$2", [req.params.col, req.params.id]); memoria[req.params.col].delete(req.params.id); version = Date.now(); res.json({ ok: true, version }); }
  catch (e) { console.error(e); err(res, 500, "No se pudo borrar."); }
});

// Restaurar un respaldo completo (reemplaza todo)
app.post("/api/importar", auth, async (req, res) => {
  const b = req.body || {};
  const filas = [];
  for (const c of COLECCIONES) for (const d of Array.isArray(b[c]) ? b[c] : []) {
    if (!d || typeof d !== "object" || !ID_OK.test(String(d.id || ""))) continue;
    const { id, ...data } = d;
    if (c === "archivos" && data.assetId && !data.url) continue; // archivos guardados dentro de Claude no se pueden traer
    if (Buffer.byteLength(JSON.stringify(data)) > MAXDOC) return err(res, 413, `El registro ${c}/${id} pasa de 250 KB.`);
    filas.push([c, String(id), data]);
  }
  const cli = await pool.connect();
  try {
    await cli.query("begin"); await cli.query("delete from docs");
    for (const [c, id, data] of filas) await cli.query("insert into docs(col,id,data) values($1,$2,$3)", [c, id, data]);
    await cli.query("commit");
    for (const c of COLECCIONES) memoria[c].clear();
    for (const [c, id, data] of filas) memoria[c].set(id, data);
    version = Date.now(); res.json({ ok: true, importados: filas.length });
  } catch (e) { await cli.query("rollback").catch(() => {}); console.error(e); err(res, 500, "No se pudo restaurar el respaldo."); }
  finally { cli.release(); }
});

app.use((req, res) => err(res, 404, "No encontrado."));
iniciarBase().then(() => app.listen(PUERTO, () => console.log(`PatentIA API en el puerto ${PUERTO}`)))
  .catch(e => { console.error("No se pudo iniciar la base:", e.message); process.exit(1); });
