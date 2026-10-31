/* Motor legal de PatentIA — plazos de la Decisión 486 (CAN) aplicados por la SIC (Colombia).
   Funciones puras: no tocan la pantalla ni los datos. */
(function(g){
"use strict";
const pad=n=>String(n).padStart(2,"0");
const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fecha=s=>{const[y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const valida=s=>typeof s==="string"&&/^(19[9]\d|20\d\d|2100)-\d{2}-\d{2}$/.test(s)&&!isNaN(fecha(s));

/* Festivos de Colombia (Ley 51 de 1983 y calendario religioso) */
const cacheF={};
function pascua(y){const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),gg=Math.floor((b-f+1)/3),h=(19*a+b-d-gg+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mes=Math.floor((h+l-7*m+114)/31),dia=((h+l-7*m+114)%31)+1;return new Date(y,mes-1,dia)}
function lunes(d){const r=new Date(d);const w=r.getDay();if(w!==1)r.setDate(r.getDate()+((8-w)%7));return r}
function festivos(y){if(cacheF[y])return cacheF[y];const s=new Set();const add=d=>s.add(iso(d));
 [[0,1],[4,1],[6,20],[7,7],[11,8],[11,25]].forEach(([m,d])=>add(new Date(y,m,d)));
 [[0,6],[2,19],[5,29],[7,15],[9,12],[10,1],[10,11]].forEach(([m,d])=>add(lunes(new Date(y,m,d))));
 const p=pascua(y);const off=n=>{const d=new Date(p);d.setDate(d.getDate()+n);return d};
 add(off(-3));add(off(-2));add(lunes(off(39)));add(lunes(off(60)));add(lunes(off(68)));
 return cacheF[y]=s}
function esHabil(s){const d=fecha(s);const w=d.getDay();return w!==0&&w!==6&&!festivos(d.getFullYear()).has(s)}
function siguienteHabil(s){let d=fecha(s);while(!esHabil(iso(d)))d.setDate(d.getDate()+1);return iso(d)}
function sumarHabiles(s,n){let d=fecha(s),c=0;while(c<n){d.setDate(d.getDate()+1);if(esHabil(iso(d)))c++}return iso(d)}
function sumarMeses(s,m){const[y,mo,d]=s.split("-").map(Number);const t=new Date(y,mo-1+m,1);const ult=new Date(t.getFullYear(),t.getMonth()+1,0).getDate();t.setDate(Math.min(d,ult));return iso(t)}
const sumarAnios=(s,a)=>sumarMeses(s,a*12);
function finMes(s){const[y,mo]=s.split("-").map(Number);return iso(new Date(y,mo,0))}
const venceHabil=s=>siguienteHabil(s); // si el plazo termina en día no hábil, se corre al siguiente hábil
function dias(s,hoy){return Math.round((fecha(s)-fecha(hoy))/864e5)}

const TIPO={pi:"Patente de invención",mu:"Modelo de utilidad",di:"Diseño industrial",ma:"Marca",da:"Derecho de autor (software)",si:"Secreto industrial",ob:"Derecho de autor (obra escrita)"};
function clase(mod){for(const k in TIPO)if(TIPO[k]===mod)return k;return"mu"}

/* Eventos legales derivados de las fechas del expediente */
function eventos(p){
 const ev=[];const k=clase(p.modalidad);const hechos=p.hechos||{};
 const R=valida(p.fechaRadicacion)?p.fechaRadicacion:null;
 const add=(o)=>{const auto=!!o.hecho;o.auto=auto;o.hecho=!!hechos[o.clave]||auto;ev.push(o)};
 const neg=valida(p.fechaNegacion)?p.fechaNegacion:null;
 const conc=valida(p.fechaConcesion)?p.fechaConcesion:null;

 if(k==="pi"||k==="mu"){
  const mitad=k==="mu";const h=n=>mitad?Math.ceil(n/2):n;
  const anios=mitad?10:20;
  if(valida(p.fechaDivulgacion)){const lim=venceHabil(sumarMeses(p.fechaDivulgacion,12));const ref=valida(p.fechaPrioridad)&&(!R||p.fechaPrioridad<R)?p.fechaPrioridad:R;
   add({clave:"divulgacion",tipo:"Radicar antes de perder la novedad",vence:lim,critico:true,norma:"Art. 17 D. 486",nota:"La divulgación hecha por el inventor no destruye la novedad si se radica (o se invoca prioridad) dentro del año siguiente.",hecho:!!ref&&ref<=lim})}
  if(!R)return ev;
  const base=valida(p.fechaPrioridad)&&p.fechaPrioridad<R?p.fechaPrioridad:R;
  add({clave:"forma-sic",tipo:"Examen de forma (lo hace la SIC)",vence:sumarHabiles(R,h(30)),info:true,norma:"Arts. 38 y 85 D. 486",nota:"Si hay defectos, la SIC le notifica un requerimiento."});
  if(base===R)add({clave:"prioridad",opcional:true,tipo:"Último día para pedir protección en otros países con esta fecha",vence:venceHabil(sumarMeses(R,12)),norma:"Art. 9 D. 486 / Convenio de París / PCT",nota:"Puede presentar una solicitud internacional PCT (un solo trámite que sirve para más de 150 países, se radica en la SIC) o pedir directamente en cada país. Después de esta fecha ya no conserva la fecha colombiana.",hecho:valida(p.fechaPCT)});
  if(valida(p.fechaPCT)){add({clave:"pct-nacional",tipo:"Entrar a la fase nacional en los países elegidos (PCT)",vence:sumarMeses(base,30),critico:true,norma:"Arts. 22 y 39 PCT (30 meses; algunos países 31)",nota:"Hasta esta fecha debe radicar en cada país donde quiera protección, con traducción y tasas de cada oficina. Si no lo hace, la solicitud internacional deja de valer en ese país."+(p.paisesPCT?" Países de interés: "+p.paisesPCT+".":"")});
   add({clave:"pct-busqueda",tipo:"Recibir el informe de búsqueda internacional (lo envía la oficina)",vence:sumarMeses(base,16),info:true,estimado:true,norma:"Regla 42 PCT",nota:"Con el informe sabrá qué antecedentes encontró la oficina y podrá decidir en qué países seguir."})}
  else add({clave:"copia-prioridad",tipo:"Entregar copia certificada de la solicitud de prioridad",vence:venceHabil(sumarMeses(R,3)),critico:true,norma:"Art. 10 D. 486",nota:"Si no se entrega, se pierde el derecho de prioridad."});
  if(valida(p.fechaReqForma)){const v=sumarMeses(p.fechaReqForma,mitad?1:2);const vf=p.prorrogaForma?sumarMeses(v,mitad?1:2):v;
   add({clave:"forma-resp-"+p.fechaReqForma,tipo:"Responder requerimiento de forma",vence:venceHabil(vf),critico:true,norma:"Arts. 39 y 85 D. 486",nota:(p.prorrogaForma?"Incluye la prórroga. ":"Prorrogable una vez por el mismo plazo. ")+"Si no responde, la solicitud se considera abandonada."})}
  if(neg){add({clave:"recurso-"+neg,tipo:"Recurso de reposición contra la negación",vence:sumarHabiles(neg,10),critico:true,norma:"Art. 76 CPACA",nota:"10 días hábiles desde la notificación. Después de este plazo la negación queda en firme."});return ev}
  const pub=valida(p.fechaPublicacion)?p.fechaPublicacion:null;
  const pubEst=sumarMeses(base,mitad?12:18);
  if(!pub)add({clave:"publicacion",tipo:"Publicación en la Gaceta (estimada)",vence:pubEst,info:true,estimado:true,norma:mitad?"Art. 85 D. 486 (12 meses)":"Art. 40 D. 486 (18 meses)",nota:"Puede pedir que se publique antes. Al publicarse, escriba la fecha real en el expediente."});
  const P=pub||pubEst;
  if(pub)add({clave:"oposicion",tipo:"Vigilar oposiciones de terceros",vence:sumarHabiles(pub,h(60)),info:true,norma:"Arts. 42 y 85 D. 486",nota:"Si alguien se opone, la SIC le dará traslado para responder."});
  add({clave:"pedir-fondo",tipo:"Pedir el examen de patentabilidad y pagar la tasa",vence:venceHabil(sumarMeses(P,mitad?3:6)),critico:true,estimado:!pub,hecho:valida(p.fechaPeticionFondo),norma:"Arts. 44 y 85 D. 486",nota:"Si no se pide a tiempo, la solicitud cae en abandono. Puede pedirse desde la radicación."});
  if(valida(p.fechaReqFondo)){const v=sumarHabiles(p.fechaReqFondo,h(60));const vf=p.prorrogaFondo?sumarHabiles(v,h(30)):v;
   add({clave:"fondo-resp-"+p.fechaReqFondo,tipo:"Responder requerimiento del examen de fondo",vence:vf,critico:true,norma:"Arts. 45 y 85 D. 486",nota:(p.prorrogaFondo?"Incluye la prórroga. ":`Prorrogable una vez por ${h(30)} días hábiles. `)+"Si no responde, la SIC decide con lo que tenga."})}
  for(let a=1;a<anios;a++){const v=finMes(sumarAnios(R,a));
   add({clave:"anualidad-"+(a+1),tipo:`Anualidad del año ${a+1} de vigencia`,vence:venceHabil(v),gracia:venceHabil(sumarMeses(v,6)),norma:"Arts. 80 y 85 D. 486",nota:"Se paga por año adelantado; vence el último día del mes aniversario de la radicación y hay 6 meses de gracia con recargo. Si no se paga, la patente o la solicitud caduca. Confirme el valor en la tabla de tasas vigente de la SIC."})}
  if(conc)add({clave:"explotacion",tipo:"Explotar o licenciar la invención",vence:[sumarAnios(conc,3),sumarAnios(R,4)].sort().pop(),norma:"Art. 61 D. 486",nota:"Si no se explota ni se licencia, un tercero puede pedir licencia obligatoria."});
  add({clave:"fin",tipo:conc?"Fin de la vigencia: pasa a dominio público":"Fin de la vigencia (si se concede)",vence:sumarAnios(R,anios),info:true,estimado:!conc,norma:mitad?"Art. 84 D. 486 (10 años)":"Art. 50 D. 486 (20 años)",nota:"No se puede renovar."});
 }
 else if(k==="di"){
  if(!R)return ev;
  const base=valida(p.fechaPrioridad)&&p.fechaPrioridad<R?p.fechaPrioridad:R;
  add({clave:"forma-sic",tipo:"Examen de forma (lo hace la SIC)",vence:sumarHabiles(R,15),info:true,norma:"Art. 120 D. 486"});
  if(base===R)add({clave:"prioridad",opcional:true,tipo:"Último día para pedir protección en otros países con esta fecha",vence:venceHabil(sumarMeses(R,6)),norma:"Art. 9 D. 486 (6 meses)"});
  else add({clave:"copia-prioridad",tipo:"Entregar copia certificada de la solicitud de prioridad",vence:venceHabil(sumarMeses(R,3)),critico:true,norma:"Art. 10 D. 486"});
  if(valida(p.fechaReqForma)){const v=sumarHabiles(p.fechaReqForma,30);const vf=p.prorrogaForma?sumarHabiles(v,30):v;
   add({clave:"forma-resp-"+p.fechaReqForma,tipo:"Responder requerimiento de forma",vence:vf,critico:true,norma:"Art. 120 D. 486",nota:p.prorrogaForma?"Incluye la prórroga.":"Prorrogable una vez por 30 días hábiles."})}
  if(neg){add({clave:"recurso-"+neg,tipo:"Recurso de reposición contra la negación",vence:sumarHabiles(neg,10),critico:true,norma:"Art. 76 CPACA"});return ev}
  if(valida(p.fechaPublicacion))add({clave:"oposicion",tipo:"Vigilar oposiciones de terceros",vence:sumarHabiles(p.fechaPublicacion,30),info:true,norma:"Art. 122 D. 486"});
  add({clave:"fin",tipo:conc?"Fin de la vigencia: pasa a dominio público":"Fin de la vigencia (si se concede)",vence:sumarAnios(R,10),info:true,estimado:!conc,norma:"Art. 128 D. 486 (10 años)",nota:"No se puede renovar."});
 }
 else if(k==="ma"){
  if(!R)return ev;
  if(!(valida(p.fechaPrioridad)&&p.fechaPrioridad<R))add({clave:"prioridad",opcional:true,tipo:"Último día para pedir la marca en otros países con esta fecha",vence:venceHabil(sumarMeses(R,6)),norma:"Art. 9 D. 486 (6 meses)"});
  if(valida(p.fechaReqForma))add({clave:"forma-resp-"+p.fechaReqForma,tipo:"Responder requerimiento de forma",vence:sumarHabiles(p.fechaReqForma,60),critico:true,norma:"Art. 144 D. 486"});
  if(neg){add({clave:"recurso-"+neg,tipo:"Recurso de reposición contra la negación",vence:sumarHabiles(neg,10),critico:true,norma:"Art. 76 CPACA"});return ev}
  if(valida(p.fechaPublicacion))add({clave:"oposicion",tipo:"Vigilar oposiciones de terceros",vence:sumarHabiles(p.fechaPublicacion,30),info:true,norma:"Art. 146 D. 486"});
  if(conc){let ini=conc;for(let c=1;c<=3;c++){const fin=sumarAnios(conc,10*c);
    add({clave:"renovacion-"+c,tipo:`Renovar la marca (renovación ${c})`,vence:fin,gracia:sumarMeses(fin,6),norma:"Arts. 152 y 153 D. 486",nota:"Se puede renovar desde 6 meses antes del vencimiento; hay 6 meses de gracia."});ini=fin}
   add({clave:"uso",tipo:"Usar la marca en el mercado",vence:sumarAnios(conc,3),norma:"Art. 165 D. 486",nota:"Sin uso durante 3 años seguidos, un tercero puede pedir la cancelación."})}
 }
 return ev.sort((a,b)=>a.vence.localeCompare(b.vence));
}

/* Estado de un evento en una fecha dada */
function estado(e,hoy){
 if(e.hecho)return{cls:"v",txt:"Hecho",nivel:0};
 if(!e.vence)return{cls:"g",txt:"Sin fecha",nivel:1};
 const d=dias(e.vence,hoy);
 if(e.opcional&&d<0)return{cls:"g",txt:"Ya pasó",nivel:0};
 if(e.info)return d<0?{cls:"g",txt:"Ya pasó",nivel:0}:{cls:"g",txt:(e.estimado?"Estimado · ":"")+`faltan ${d} d`,nivel:1};
 if(d<0){if(e.gracia&&dias(e.gracia,hoy)>=0)return{cls:"a",txt:`En gracia con recargo: faltan ${dias(e.gracia,hoy)} d`,nivel:3};return{cls:"r",txt:`Vencido hace ${-d} d`,nivel:4}}
 if(d===0)return{cls:"r",txt:"Vence hoy",nivel:4};
 if(d<=15)return{cls:"a",txt:`Faltan ${d} d`,nivel:3};
 return{cls:"",txt:(e.estimado?"Estimado · ":"")+`faltan ${d} d`,nivel:2};
}

/* Etapa que corresponde según el expediente */
function etapaSugerida(p,hoy){const k=clase(p.modalidad);if(!["pi","mu","di","ma"].includes(k))return null;
 const fin=eventos(p).find(e=>e.clave==="fin");
 if(valida(p.fechaNegacion))return"negada";
 if(valida(p.fechaConcesion)){if(fin&&dias(fin.vence,hoy)<0)return"vencida";return p.etapa==="licenciada"?"licenciada":"concedida"}
 if(valida(p.fechaPeticionFondo)||valida(p.fechaReqFondo))return"examen";
 if(valida(p.fechaRadicacion))return"radicada";
 return null}

/* Requisitos para radicar */
function requisitos(p){const k=clase(p.modalidad);const L=[];
 if(k==="pi"||k==="mu"){L.push(["petitorio","Petitorio (formulario de la SIC) diligenciado","Art. 26 D. 486"],["descripcion","Descripción clara y completa","Arts. 26 y 28"],["reivindicaciones","Reivindicaciones","Arts. 26 y 30"],["dibujos","Dibujos","Art. 26"],["resumen","Resumen","Art. 26"],["tasa","Comprobante de pago de la tasa de solicitud","Art. 26"])}
 else if(k==="di"){L.push(["petitorio","Petitorio (formulario de la SIC)","Art. 117"],["vistas","Representación gráfica con todas las vistas (líneas continuas)","Art. 117"],["tasa","Comprobante de pago de la tasa","Art. 117"])}
 else if(k==="ma"){L.push(["petitorio","Petitorio con el signo y la clase de Niza","Art. 138"],["tasa","Comprobante de pago de la tasa","Art. 138"])}
 else return L;
 const inv=(p.inventores||"").trim().toLowerCase(),sol=(p.solicitante||"").trim().toLowerCase();
 if(k!=="ma"&&sol&&inv&&!sol.includes(inv)&&!inv.includes(sol))L.push(["cesion","Documento de cesión del inventor al solicitante","Art. 26 lit. h"]);
 if(p.agente)L.push(["poder","Poder al agente o abogado","Art. 26"]);
 if(valida(p.fechaPrioridad))L.push(["prioridadDoc","Datos de la solicitud de prioridad","Art. 9-10"]);
 if(k==="pi"||k==="mu")L.push(["busqueda","Búsqueda de antecedentes hecha (recomendado)","Buena práctica"]);
 return L}

/* Alertas legales del proyecto */
function alertas(p,hoy,licencias){const A=[];const k=clase(p.modalidad);const R=valida(p.fechaRadicacion)?p.fechaRadicacion:null;
 if(valida(p.fechaPrioridad)&&R){const lim=sumarMeses(p.fechaPrioridad,k==="pi"||k==="mu"?12:6);if(R>venceHabil(lim))A.push("La radicación es posterior al plazo de prioridad: la prioridad extranjera no es válida (art. 9).")}
 const refDiv=valida(p.fechaPrioridad)&&R&&p.fechaPrioridad<R?p.fechaPrioridad:R;
 if((k==="pi"||k==="mu")&&valida(p.fechaDivulgacion)&&refDiv&&refDiv>venceHabil(sumarMeses(p.fechaDivulgacion,12)))A.push("Se radicó más de un año después de divulgar el invento: la novedad puede estar destruida (art. 17).");
 if(valida(p.fechaConcesion)&&R&&p.fechaConcesion<R)A.push("La fecha de concesión es anterior a la de radicación. Revise las fechas.");
 if(valida(p.fechaPublicacion)&&R&&p.fechaPublicacion<R)A.push("La fecha de publicación es anterior a la de radicación. Revise las fechas.");
 for(const e of eventos(p))if(e.critico&&!e.hecho&&estado(e,hoy).nivel===4&&!(e.gracia&&dias(e.gracia,hoy)>=0))A.push(`Plazo vencido: “${e.tipo}” (${e.norma}). La solicitud puede estar en abandono o caducada; consulte a su agente.`);
 for(const e of eventos(p))if(e.clave.startsWith("anualidad-")&&!e.hecho&&e.gracia&&dias(e.gracia,hoy)<0){A.push(`No se pagó la “${e.tipo}” ni en el período de gracia: la protección pudo caducar (art. 80). Si ya la pagó, márquela como hecha.`);break}
 const L=(licencias||[]).filter(l=>l.proyectoId===p.id&&l.etapa==="firmado");
 if(L.filter(l=>l.tipo==="Licencia exclusiva").length>1)A.push("Hay más de una licencia exclusiva firmada para este proyecto. Una licencia exclusiva no permite otra igual en el mismo territorio.");
 if(L.some(l=>l.tipo==="Licencia exclusiva")&&L.length>1)A.push("Hay una licencia exclusiva y otros acuerdos firmados: revise que no se crucen territorios ni usos.");
 if(L.length&&!R&&["pi","mu","di","ma"].includes(k))A.push("Hay acuerdos firmados antes de radicar: asegúrese de que tengan cláusula de confidencialidad.");
 return A}

g.MotorPI={finMes,festivos,esHabil,sumarHabiles,sumarMeses,sumarAnios,siguienteHabil,eventos,estado,etapaSugerida,requisitos,alertas,dias,clase,valida};
})(typeof window!=="undefined"?window:globalThis);
