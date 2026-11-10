// =====================================================================
// Alertas de Gol · frontend
// Sin frameworks: cada pantalla es una función que pide JSON a la Edge Function
// `api` y devuelve HTML. El enrutado es por hash (#vivo, #alertas…), así funciona
// igual en GitHub Pages, en un subdominio o abierta desde el ícono de la PWA.
// =====================================================================
const { API, REFRESCO_MS } = window.CONFIG;
const $ = (s, r = document) => r.querySelector(s);
const vista = $("#vista");

// ---------- utilidades ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const n = (v, d = 2) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? "–" : Number(v).toFixed(d));
const hora = (ts) => new Date(ts).toLocaleString("es-CO", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const hace = (ts) => {
  const m = Math.round((Date.now() - new Date(ts)) / 60000);
  return m < 1 ? "hace instantes" : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`;
};
// El radar guarda sus horas en UTC (la cuota de API-Football se reinicia a las 00:00 UTC).
// La pantalla las muestra en la hora local del dispositivo (Colombia = UTC−5).
const OFFSET_H = -new Date().getTimezoneOffset() / 60;             // Colombia: −5
const utcALocal = (h) => ((h + OFFSET_H) % 24 + 24) % 24;
const localAUtc = (h) => ((h - OFFSET_H) % 24 + 24) % 24;
const etiquetaHora = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
function resumirHoras(utc) {
  // Convierte [12,13,…,2] UTC en tramos legibles en hora local: "7 a. m. – 10 p. m."
  const loc = new Set((utc || []).map(utcALocal));
  if (!loc.size) return "Apagado todo el día";
  if (loc.size === 24) return "Las 24 horas";
  const fmt = (h) => { const x = h % 24; return x === 0 ? "12 a. m." : x < 12 ? `${x} a. m.` : x === 12 ? "12 p. m." : `${x - 12} p. m.`; };
  const tramos = [];
  for (let h = 0; h < 24; h++) {
    if (loc.has(h) && !loc.has((h + 23) % 24)) { let f = h; while (loc.has((f + 1) % 24) && (f + 1) % 24 !== h) f++; tramos.push(`${fmt(h)} – ${fmt(f + 1)}`); }
  }
  return tramos.join(", ");
}
let toastT;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("ver");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("ver"), 3500);
}
async function get(ruta) {
  const r = await fetch(API + ruta, { cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Error ${r.status}`);
  return r.json();
}
async function post(ruta, cuerpo) {
  const r = await fetch(API + ruta, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

// ---------- PIN de administrador ----------
// Se guarda solo en este dispositivo (localStorage) y viaja en cada escritura; el servidor
// compara contra un hash bcrypt y bloquea 15 min tras 5 intentos fallidos.
const pinGuardado = () => localStorage.getItem("pin") || "";
async function conPin(accion) {
  let pin = pinGuardado();
  if (!pin) {
    pin = prompt("PIN de administrador:") || "";
    if (!pin) return null;
  }
  try {
    const r = await accion(pin);
    localStorage.setItem("pin", pin);
    return r;
  } catch (e) {
    if (/PIN|Bloqueado/i.test(e.message)) localStorage.removeItem("pin");
    toast(e.message);
    return null;
  }
}

// ---------- encabezado ----------
function pintarEncabezado(r) {
  $("#chip-regla").textContent = r.regla_version ?? "v–";
  const p = r.presupuesto;
  if (p) $("#chip-api").textContent = `API ${p.usadas_hoy}/${r.presupuesto_diario ?? 100}`;
  const punto = $("#punto-estado");
  const ult = r.ultimo_escaneo;
  const minutos = ult ? (Date.now() - new Date(ult.ts)) / 60000 : Infinity;
  punto.className = "punto " + (!r.escaneo_activo ? "pausa" : ult?.motivo === "error" ? "mal" : minutos < 90 ? "ok" : "pausa");
  punto.title = !r.escaneo_activo ? "Escáner apagado" : ult ? `Último radar ${hace(ult.ts)} (${ult.motivo})` : "Sin radares aún";
}

// ---------- componentes ----------
function balanza(ipL, ipV, local, visitante) {
  const a = Math.max(Number(ipL) || 0, 0), b = Math.max(Number(ipV) || 0, 0);
  const total = a + b || 1;
  return `<div class="balanza" role="img" aria-label="Índice de presión: ${esc(local)} ${n(ipL, 1)}, ${esc(visitante)} ${n(ipV, 1)}">
    <div class="balanza-barra"><i class="l" style="width:${(a / total * 100).toFixed(1)}%"></i><i class="v" style="width:${(b / total * 100).toFixed(1)}%"></i></div>
    <div class="balanza-leyenda"><span>IP ${n(ipL, 1)}</span><span>IP ${n(ipV, 1)}</span></div>
  </div>`;
}

// Mini-gráfica de la dominancia a lo largo de los snapshots, con la línea del umbral.
function spark(serie, umbral) {
  const pts = (serie || []).filter((s) => s.dominancia !== null);
  if (pts.length < 2) return `<div class="spark-pie"><span>La gráfica aparece con el segundo snapshot</span></div>`;
  const W = 300, H = 44, P = 4;
  const xs = pts.map((p) => p.minuto), ys = pts.map((p) => Number(p.dominancia));
  const x0 = Math.min(...xs), x1 = Math.max(...xs) || x0 + 1;
  const yMax = Math.max(...ys, umbral * 1.5), yMin = 0;
  const X = (x) => P + (x - x0) / Math.max(x1 - x0, 1) * (W - 2 * P);
  const Y = (y) => H - P - (Math.min(y, yMax) - yMin) / (yMax - yMin) * (H - 2 * P);
  const linea = pts.map((p, i) => `${i ? "L" : "M"}${X(p.minuto).toFixed(1)},${Y(Number(p.dominancia)).toFixed(1)}`).join(" ");
  const ult = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evolución de la dominancia">
      <line x1="0" x2="${W}" y1="${Y(umbral)}" y2="${Y(umbral)}" stroke="#ffc247" stroke-width="1" stroke-dasharray="4 4" opacity=".7"/>
      <path d="${linea}" fill="none" stroke="#3ddc84" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <circle cx="${X(ult.minuto)}" cy="${Y(Number(ult.dominancia))}" r="3" fill="#3ddc84"/>
    </svg>
    <div class="spark-pie"><span>${x0}'</span><span>Dominancia · umbral ${n(umbral)}</span><span>${x1}'</span></div>`;
}

function tarjetaPartido(p, cfg) {
  const s = (p.serie || [])[p.serie ? p.serie.length - 1 : 0] || {};
  const ev = s.evaluacion || {};
  const cls = (ok) => (ok === true ? "ok" : "no");
  const fav = (lado) => (p.favorito === lado ? `<span class="fav">FAV</span>` : "");
  return `<article class="tarjeta ${p.alerta ? "alerta" : ""}">
    <div class="liga"><span>${esc(p.liga)}${p.pais ? " · " + esc(p.pais) : ""}</span><span class="minuto">${esc(p.estado)} ${p.minuto ?? ""}'</span></div>
    <div class="marcador">
      <div class="equipo">${esc(p.local)}${fav("home")}</div>
      <div class="goles">${p.goles_local}–${p.goles_visitante}</div>
      <div class="equipo der">${fav("away")}${esc(p.visitante)}</div>
    </div>
    ${s.ip_local !== undefined ? balanza(s.ip_local, s.ip_visitante, p.local, p.visitante) : `<p class="nota">Esperando el primer snapshot de estadísticas.</p>`}
    <div class="metricas">
      <div class="metrica ${cls(ev.dominancia)}"><span>Dominancia</span><b>${n(s.dominancia)}</b></div>
      <div class="metrica ${cls(ev.momentum)}"><span>Momentum</span><b>${n(s.momentum)}</b></div>
      <div class="metrica ${cls(ev.cuota)}"><span>Over ${s.linea_over ?? "–"}</span><b>${n(s.cuota_over)}</b></div>
    </div>
    ${spark(p.serie, Number(cfg.dominancia_min) || 1.3)}
    ${p.alerta ? `<p class="aviso">Alerta enviada al ${p.alerta.minuto}' con cuota ${n(p.alerta.cuota)} · ${esc(p.alerta.resultado)}</p>` : ""}
  </article>`;
}

// ---------- radar: motivos de descarte ----------
// Cada partido en vivo cae en un solo motivo (el primer filtro que no pasa, ver motivoRadar en
// algoritmo.ts). Aquí se agrupan en 4 familias para leerlos de un vistazo.
const GRUPOS = {
  seguimiento: { corto: "Seguimiento", titulo: "En seguimiento", ayuda: "Pasaron el filtro: el escáner les pide estadísticas y evalúa la regla." },
  cobertura: { corto: "Sin datos API", titulo: "Por fuera: la API no trae el dato", ayuda: "Huecos de API-Football en esa liga. Ningún ajuste de la regla los recupera." },
  aislada: { corto: "Aisladas", titulo: "Por fuera: liga aislada por ti", ayuda: "Las apagaste en la pestaña Ligas." },
  regla: { corto: "Regla", titulo: "Descartados por la regla", ayuda: "Partidos normales que todavía no cumplen (o ya no cumplen) el patrón." },
};
function motivoInfo(mo, r) {
  const M = {
    evaluado: ["seguimiento", "Evaluado en este radar"],
    sin_cupo: ["seguimiento", "Candidato sin cupo de detalle en este radar"],
    ya_alertado: ["seguimiento", "Ya alertado (esperando resultado)"],
    sin_cuota_pre: ["cobertura", "Sin cuotas prepartido en la API"],
    sin_estadisticas: ["cobertura", "Sin estadísticas en vivo en la API"],
    sin_cuota_vivo: ["cobertura", "Sin cuota en vivo en la API"],
    aislada: ["aislada", "Liga aislada"],
    aun_no_2T: ["regla", "Aún no es el 2.º tiempo"],
    otro_estado: ["regla", "Prórroga, penales o pausa"],
    fuera_ventana: ["regla", `Fuera de la ventana ${r.minuto_min ?? 46}'–${r.minuto_max ?? 85}'`],
    empatado: ["regla", "Empatado"],
    favorito_no_pierde: ["regla", Number(r.diferencia_min) > 1 ? `El favorito no pierde por ${r.diferencia_min} o más` : "El favorito no va perdiendo"],
    sin_favorito_claro: ["regla", `Sin favorito claro (cuota > ${n(r.cuota_fav_max)})`],
    sin_consultar: ["regla", "Favorito aún sin consultar (cupo de API)"],
  };
  const [grupo, texto] = M[mo] || ["regla", mo || "–"];
  return { grupo, texto };
}
const ESTADOS = { "1H": "1T", HT: "Descanso", "2H": "2T", ET: "Prórroga", BT: "Pausa", P: "Penales", SUSP: "Susp.", INT: "Interr.", LIVE: "Vivo" };

// Barras de partidos en vivo por radar en las últimas 24 h
function barrasVivos(hist) {
  const pts = (hist || []).map((h) => ({ t: new Date(h.ts).getTime(), v: Number(h.vivos) || 0 }));
  if (pts.length < 2) return "";
  const W = 300, H = 48, t1 = Date.now(), t0 = t1 - 24 * 3600e3, vMax = Math.max(...pts.map((p) => p.v), 1);
  const X = (t) => ((t - t0) / (t1 - t0)) * W;
  const barras = pts.map((p) => {
    const h = Math.max(1.5, (p.v / vMax) * (H - 4));
    return `<rect x="${X(p.t).toFixed(1)}" y="${(H - h).toFixed(1)}" width="2.2" height="${h.toFixed(1)}" rx="1"/>`;
  }).join("");
  return `<svg class="barras" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Partidos en vivo por radar, últimas 24 horas (máximo ${vMax})">${barras}</svg>
    <div class="spark-pie"><span>hace 24 h</span><span>máx. ${vMax} en un radar</span><span>ahora</span></div>`;
}

let filtroRadar = localStorage.getItem("filtroRadar") || "todos";

// ---------- pantallas ----------
const pantallas = {
  async vivo() {
    const r = await get("/resumen");
    pintarEncabezado(r);
    const u = r.ultimo_escaneo;
    const estado = u
      ? `Último radar ${hace(u.ts)}: ${u.partidos_vivos ?? 0} partidos en vivo, ${u.candidatos ?? 0} candidatos`
      : "Aún no se ha hecho ningún radar";
    const horas = r.horas_activas_utc || [];
    const enHorario = horas.includes(new Date().getUTCHours());
    const lista = r.en_vivo.length
      ? r.en_vivo.map((p) => tarjetaPartido(p, r)).join("")
      : `<div class="tarjeta vacio"><strong>Sin candidatos ahora</strong>
           Un candidato es un favorito que va perdiendo en el segundo tiempo.
           ${enHorario ? "El radar sigue buscando." : `El radar está fuera de su horario activo (${esc(resumirHoras(horas))}); se reanuda solo.`}</div>`;
    return `<div class="titulo-seccion"><h2>Candidatos en seguimiento</h2><small>${r.en_vivo.length}</small></div>
      ${lista}
      <p class="nota">${esc(estado)}. Con el plan gratuito el radar pasa cada 15 a 20 minutos, no minuto a minuto.</p>`;
  },

  async radar() {
    const r = await get("/radar");
    const u = r.ultimo;
    if (!u) return `<div class="tarjeta vacio"><strong>Sin foto del radar todavía</strong>
      La lista aparece después del próximo barrido del escáner (${esc(resumirHoras(r.horas_activas_utc))}).</div>`;
    const items = (u.radar || []).map((p) => ({ ...p, ...motivoInfo(p.mo, r) }));
    const cuenta = (g) => items.filter((p) => p.grupo === g).length;
    const porEstado = {};
    items.forEach((p) => { const k = ESTADOS[p.e] || p.e; porEstado[k] = (porEstado[k] || 0) + 1; });

    setTimeout(() => document.querySelectorAll(".filtro").forEach((b) => b.addEventListener("click", () => {
      filtroRadar = b.dataset.g;
      try { localStorage.setItem("filtroRadar", filtroRadar); } catch (_) {}
      navegar(true);
    })));

    const visibles = items.filter((p) => filtroRadar === "todos" || p.grupo === filtroRadar);
    // Agrupar por liga, conservando el orden: ligas con más partidos primero
    const ligas = new Map();
    for (const p of visibles) {
      if (!ligas.has(p.lg)) ligas.set(p.lg, { liga: p.liga, pais: p.pais, ps: [] });
      ligas.get(p.lg).ps.push(p);
    }
    const ordenLigas = [...ligas.values()].sort((a, b) => b.ps.length - a.ps.length || a.liga.localeCompare(b.liga));
    const evTexto = (ev) => !ev ? "" : ` · D ${n(ev.d)} · M ${n(ev.mo)}${ev.c ? ` · Over @ ${n(ev.c)}` : ""}`;
    const fila = (p) => `<div class="rfila">
        <span class="rmin num">${esc(ESTADOS[p.e] || p.e)}${p.e === "1H" || p.e === "2H" ? ` ${p.m ?? ""}'` : ""}</span>
        <span class="requipos">${esc(p.l)}${p.fav === "home" ? '<span class="fav">FAV</span>' : ""} <b class="num">${p.gl}–${p.gv}</b> ${p.fav === "away" ? '<span class="fav">FAV</span>' : ""}${esc(p.v)}
          <small class="motivo ${p.grupo}">${esc(p.texto)}${p.cf ? ` · fav @ ${n(p.cf)}` : ""}${evTexto(p.ev)}</small></span>
      </div>`;
    const filtros = [["todos", "Todos", items.length], ...Object.keys(GRUPOS).map((g) => [g, GRUPOS[g].corto, cuenta(g)])];

    const conHuecos = r.ligas.filter((l) => l.sin_cuota_pre + l.sin_estadisticas + l.sin_cuota_vivo > 0);
    return `<div class="tarjeta contador">
        <div class="fila"><div><b class="num grande">${u.partidos_vivos ?? items.length}</b><span> partidos en vivo</span></div>
          <span class="chip">${hora(u.ts)}</span></div>
        <p class="nota" style="margin-top:2px">Según API-Football en el radar de ${hace(u.ts)}${u.motivo !== "ok" ? ` (terminó con ${esc(u.motivo)})` : ""}. Para comparar con otra página, mira el conteo a esa misma hora.</p>
        <div class="estados">${Object.entries(porEstado).map(([k, v]) => `<span class="chip">${esc(k)} ${v}</span>`).join("")}</div>
        ${barrasVivos(r.historial)}
      </div>

      <div class="embudo">
        ${Object.entries(GRUPOS).map(([g, x]) => `<div class="paso ${g}"><b class="num">${cuenta(g)}</b><span>${esc(x.titulo)}</span></div>`).join("")}
      </div>

      <div class="filtros" role="group" aria-label="Filtrar partidos">
        ${filtros.map(([g, t, c]) => `<button type="button" class="filtro ${filtroRadar === g ? "on" : ""}" data-g="${g}" aria-pressed="${filtroRadar === g}">${esc(t)} <span class="num">${c}</span></button>`).join("")}
      </div>
      ${filtroRadar !== "todos" ? `<p class="nota" style="margin:0 0 10px">${esc(GRUPOS[filtroRadar].ayuda)}</p>` : ""}
      ${ordenLigas.map((l) => `<div class="tarjeta rliga">
          <div class="liga"><span><b>${esc(l.liga)}</b> · ${esc(l.pais || "")}</span><span>${l.ps.length}</span></div>
          ${l.ps.map(fila).join("")}
        </div>`).join("") || `<div class="tarjeta vacio">Ningún partido en este grupo.</div>`}

      <div class="titulo-seccion"><h2>Ligas en las últimas 24 h</h2><small>${r.ligas.length} ligas · ${conHuecos.length} con huecos</small></div>
      <div class="tarjeta tabla-wrap"><table><thead><tr><th>Liga</th><th title="Partidos distintos vistos">Part.</th><th title="Llegaron a candidato">Cand.</th><th title="Sin cuotas prepartido / sin estadísticas / sin cuota en vivo">Huecos API</th></tr></thead><tbody>
        ${r.ligas.map((l) => {
          const h = [l.sin_cuota_pre && `${l.sin_cuota_pre} sin cuota pre`, l.sin_estadisticas && `${l.sin_estadisticas} sin stats`, l.sin_cuota_vivo && `${l.sin_cuota_vivo} sin cuota vivo`].filter(Boolean).join(", ");
          return `<tr><td>${esc(l.liga)}<small class="sub">${esc(l.pais || "")}${l.aislada ? " · aislada" : ""}</small></td><td>${l.partidos}</td><td>${l.candidatos}</td><td class="${h ? "neg" : ""}">${esc(h || "–")}</td></tr>`;
        }).join("") || `<tr><td colspan="4">Sin datos aún</td></tr>`}
      </tbody></table></div>
      <p class="nota">Este conteo no gasta consultas: es la misma respuesta que el escáner ya pide en cada barrido. La cobertura de una liga solo se descubre cuando uno de sus partidos se vuelve precandidato (alguien pierde en el entretiempo o el 2.º tiempo), porque averiguarla para todos costaría una consulta por partido.</p>`;
  },

  async alertas() {
    const a = await get("/alertas");
    if (!a.length) return `<div class="tarjeta vacio"><strong>Todavía no hay alertas</strong>Cuando un favorito pierda, presione y la cuota llegue al umbral, aparecerá aquí y te llegará la notificación.</div>`;
    const tarjeta = (x) => `<article class="tarjeta ${esc(x.resultado)}">
        <div class="fila"><span class="liga">${esc(x.liga)} · ${hora(x.ts)}</span><span class="estado ${esc(x.resultado)}">${esc(x.resultado)}</span></div>
        <div class="fila" style="margin-top:6px"><b>${esc(x.local)} vs ${esc(x.visitante)}</b><span class="num">${esc(x.marcador)} al ${x.minuto}'</span></div>
        <p class="detalle">Over ${x.linea_over} a cuota <b>${n(x.cuota)}</b> (implícita ${n(100 / x.cuota, 1)}%) · D <b>${n(x.dominancia)}</b> · M <b>${n(x.momentum)}</b> · ${esc(x.regla_version)}</p>
        ${x.resultado === "acierto" ? `<p class="detalle">Gol al ${x.minuto_gol ?? "?"}' del ${esc(x.lado_gol ?? "?")} · final 90' ${x.goles_local_90}–${x.goles_visitante_90}</p>` : ""}
        ${x.resultado === "fallo" ? `<p class="detalle">Sin más goles · final 90' ${x.goles_local_90}–${x.goles_visitante_90}</p>` : ""}
      </article>`;
    const pend = a.filter((x) => x.resultado === "pendiente"), res = a.filter((x) => x.resultado !== "pendiente");
    return `${pend.length ? `<div class="titulo-seccion"><h2>Pendientes</h2><small>${pend.length}</small></div>${pend.map(tarjeta).join("")}` : ""}
      ${res.length ? `<div class="titulo-seccion"><h2>Resueltas</h2><small>${res.length}</small></div>${res.map(tarjeta).join("")}` : ""}`;
  },

  async rendimiento() {
    const r = await get("/rendimiento");
    const globales = r.filas.filter((f) => f.liga === "(todas)" && f.franja_minuto === "(todas)");
    if (!globales.length) {
      return `<div class="tarjeta vacio"><strong>Sin alertas resueltas todavía</strong>
        Aquí se compara el acierto real contra la probabilidad implícita de la cuota.
        A cuota 1,40 hay que acertar más del 71,4% para ganar dinero.</div>
        <p class="nota">Datos acumulados: ${r.datos.snapshots} snapshots de ${r.datos.partidos_seguidos} partidos · ${r.conteo.pendientes} alertas pendientes.</p>`;
    }
    const bloque = (g) => {
      const ventaja = Number(g.acierto_pct) - Number(g.prob_implicita_pct);
      const muestra = Number(g.alertas);
      // Error estándar de una proporción: con pocas alertas la ventaja puede ser puro azar.
      const p = Number(g.acierto_pct) / 100;
      const ee = Math.sqrt(p * (1 - p) / muestra) * 100;
      const veredicto = muestra < 30 ? "Muestra muy pequeña: todavía no se puede concluir nada"
        : ventaja - 2 * ee > 0 ? "La estrategia supera a la cuota con margen estadístico"
        : ventaja > 0 ? "Va por encima de la cuota, pero dentro del margen de error"
        : "No supera la probabilidad implícita: así pierde dinero";
      return `<article class="tarjeta veredicto">
        <div class="fila"><h3>Regla ${esc(g.regla_version)}</h3><span class="chip">${muestra} alertas</span></div>
        <p>${veredicto}.</p>
        <div class="duelo">
          <div><span>Acierto real</span><b class="${ventaja > 0 ? "pos" : "neg"}">${n(g.acierto_pct, 1)}%</b></div>
          <div><span>Implícita de la cuota</span><b>${n(g.prob_implicita_pct, 1)}%</b></div>
          <div><span>ROI (stake fijo)</span><b class="${Number(g.roi_pct) > 0 ? "pos" : "neg"}">${n(g.roi_pct, 1)}%</b></div>
          <div><span>Ganancia</span><b class="${Number(g.ganancia_u) > 0 ? "pos" : "neg"}">${n(g.ganancia_u)} u</b></div>
        </div>
        <p class="nota">Cuota media ${n(g.cuota_media)} · margen de error ±${n(2 * ee, 1)} puntos (95%).</p>
      </article>`;
    };
    const tabla = (titulo, filas, col) => !filas.length ? "" : `<div class="titulo-seccion"><h2>${titulo}</h2></div>
      <div class="tarjeta tabla-wrap"><table><thead><tr><th>${col}</th><th>Regla</th><th>N</th><th>Acierto</th><th>Implícita</th><th>ROI</th></tr></thead><tbody>
      ${filas.map((f) => `<tr><td>${esc(f[col === "Liga" ? "liga" : "franja_minuto"])}</td><td>${esc(f.regla_version)}</td><td>${f.alertas}</td><td>${n(f.acierto_pct, 1)}%</td><td>${n(f.prob_implicita_pct, 1)}%</td><td class="${Number(f.roi_pct) > 0 ? "pos" : "neg"}">${n(f.roi_pct, 1)}%</td></tr>`).join("")}
      </tbody></table></div>`;
    return `${globales.map(bloque).join("")}
      ${tabla("Por franja de minuto", r.filas.filter((f) => f.franja_minuto !== "(todas)"), "Franja")}
      ${tabla("Por liga", r.filas.filter((f) => f.liga !== "(todas)"), "Liga")}
      <p class="nota">Pendientes: ${r.conteo.pendientes} · anuladas: ${r.conteo.anuladas} · snapshots guardados: ${r.datos.snapshots}.</p>`;
  },

  async ligas() {
    const l = await get("/ligas");
    if (!l.length) return `<div class="tarjeta vacio"><strong>Aún no hay ligas</strong>Se van agregando solas a medida que el radar ve partidos en vivo.</div>`;
    setTimeout(() => {
      $("#buscar-liga")?.addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase();
        document.querySelectorAll(".liga-fila").forEach((f) => { f.hidden = !f.dataset.t.includes(q); });
      });
      document.querySelectorAll(".liga-fila input").forEach((i) => i.addEventListener("change", async () => {
        const ok = await conPin((pin) => post("/admin/liga", { pin, id: Number(i.dataset.id), habilitada: i.checked }));
        if (!ok) i.checked = !i.checked; else toast(i.checked ? "Liga activada" : "Liga aislada");
      }));
    });
    return `<div class="titulo-seccion"><h2>Ligas</h2><small>${l.filter((x) => x.habilitada).length} de ${l.length} activas</small></div>
      <input id="buscar-liga" class="buscar" type="text" placeholder="Buscar liga o país" aria-label="Buscar liga">
      <div class="tarjeta">${l.map((x) => `<div class="liga-fila" data-t="${esc((x.nombre + " " + (x.pais || "")).toLowerCase())}">
        <div><b>${esc(x.nombre)}</b><small>${esc(x.pais || "")} · ${x.partidos} partidos vistos${x.alertas_resueltas ? ` · ${x.aciertos}/${x.alertas_resueltas} aciertos · ${n(x.ganancia_u)} u` : ""}</small></div>
        <label class="sw"><input type="checkbox" data-id="${x.id}" ${x.habilitada ? "checked" : ""} aria-label="Activar ${esc(x.nombre)}"><span></span></label>
      </div>`).join("")}</div>
      <p class="nota">Una liga aislada se sigue viendo en el radar, pero no gasta consultas ni genera alertas.</p>`;
  },

  async ajustes() {
    const c = await get("/config");
    const P = Object.fromEntries(c.params.map((p) => [p.clave, p]));
    const campoNum = (k, paso = "any") => !P[k] ? "" : `<div class="campo"><label for="p-${k}">${esc(k)}<small>${esc(P[k].descripcion || "")}</small></label>
      <input id="p-${k}" type="number" step="${paso}" inputmode="decimal" data-k="${k}" data-tipo="num" value="${esc(P[k].valor)}"></div>`;
    const pesos = P.pesos_ip?.valor || {};
    const usadas = c.presupuesto.usadas_hoy, tope = Number(P.presupuesto_diario?.valor ?? 100);
    const hoy = new Date().toISOString().slice(0, 10);
    const push = await estadoPush();

    setTimeout(() => {
      $("#btn-push")?.addEventListener("click", activarPush);
      $("#btn-push-off")?.addEventListener("click", desactivarPush);
      $("#btn-prueba")?.addEventListener("click", async () => {
        const r = await conPin((pin) => post("/admin/push-prueba", { pin }));
        if (r) toast(r.enviados ? `Enviada a ${r.enviados} dispositivo(s)` : "No hay dispositivos suscritos");
      });
      $("#btn-guardar")?.addEventListener("click", () => guardar(P));
      document.querySelectorAll(".hora").forEach((b) => b.addEventListener("click", () => {
        const on = !b.classList.contains("on");
        b.classList.toggle("on", on); b.setAttribute("aria-pressed", on);
        const utc = [...document.querySelectorAll(".hora.on")].map((x) => localAUtc(Number(x.dataset.hora)));
        $("#horas-resumen").innerHTML = `<b>${esc(resumirHoras(utc))}</b> · sin guardar`;
      }));
      $("#btn-pin")?.addEventListener("click", async () => {
        const nuevo = prompt("PIN nuevo (6 a 12 dígitos):"); if (!nuevo) return;
        const r = await conPin((pin) => post("/admin/pin", { pin, nuevo }));
        if (r) { localStorage.setItem("pin", nuevo); toast("PIN actualizado"); }
      });
      $("#btn-olvidar")?.addEventListener("click", () => { localStorage.removeItem("pin"); toast("PIN borrado de este dispositivo"); });
    });

    return `<div class="titulo-seccion"><h2>Notificaciones</h2></div>
      <div class="tarjeta">
        <p>${esc(push.texto)}</p>
        <div class="botones">
          ${push.puede ? `<button class="btn" id="btn-push">Activar notificaciones</button>` : ""}
          ${push.activa ? `<button class="btn sec" id="btn-prueba">Enviar prueba</button><button class="btn sec" id="btn-push-off">Desactivar</button>` : ""}
        </div>
        <p class="nota">${c.suscripciones} dispositivo(s) suscrito(s).</p>
      </div>

      <div class="titulo-seccion"><h2>Consumo de API hoy</h2><small>día UTC ${hoy}</small></div>
      <div class="tarjeta">
        <div class="fila"><b class="num">${usadas} / ${tope}</b><span class="nota" style="margin:0">disponibles ${c.presupuesto.disponibles} (reserva ${esc(P.reserva_api?.valor ?? 0)})</span></div>
        <div class="medidor"><i class="${usadas / tope > .8 ? "alto" : ""}" style="width:${Math.min(100, usadas / tope * 100)}%"></i></div>
        ${c.uso.filter((u) => u.fecha.slice(0, 10) === hoy).map((u) => `<div class="fila detalle"><span>${esc(u.endpoint)}</span><b>${u.llamadas}</b></div>`).join("") || `<p class="nota">Sin consultas hoy.</p>`}
      </div>

      <div class="titulo-seccion"><h2>Regla ${esc(P.regla_version?.valor)}</h2><small>cambiar algo crea una versión nueva</small></div>
      <div class="tarjeta">
        ${["minuto_min", "minuto_max", "cuota_fav_max", "diferencia_min", "dominancia_min", "cuota_objetivo", "momentum_ventana_min", "momentum_gap_min"].map((k) => campoNum(k)).join("")}
        ${Object.keys(pesos).sort().map((k) => `<div class="campo"><label for="w-${k}">peso · ${esc(k)}<small>Peso en el Índice de Presión</small></label>
          <input id="w-${k}" type="number" step="any" inputmode="decimal" data-peso="${k}" value="${esc(pesos[k])}"></div>`).join("")}
      </div>

      <div class="titulo-seccion"><h2>Horario del radar</h2><small>hora de este dispositivo</small></div>
      <div class="tarjeta">
        <p id="horas-resumen"><b>${esc(resumirHoras(P.horas_activas_utc?.valor))}</b></p>
        <div class="horas" role="group" aria-label="Horas activas del radar">
          ${Array.from({ length: 24 }, (_, h) => {
            const on = (P.horas_activas_utc?.valor || []).includes(localAUtc(h));
            return `<button type="button" class="hora ${on ? "on" : ""}" data-hora="${h}" aria-pressed="${on}">${etiquetaHora(h)}</button>`;
          }).join("")}
        </div>
        <p class="nota">Toca una hora para activarla o apagarla y pulsa "Guardar cambios" abajo. Fuera de estas horas el radar solo corre si hay un partido en seguimiento. Más horas no significa más consultas: el presupuesto diario se reparte entre las horas activas, así que con más horas cada radar queda más espaciado.</p>
      </div>

      <div class="titulo-seccion"><h2>Operación</h2><small>no cambia la versión</small></div>
      <div class="tarjeta">
        <div class="campo"><label for="p-escaneo_activo">Escáner activo<small>Interruptor general</small></label>
          <label class="sw"><input id="p-escaneo_activo" type="checkbox" data-k="escaneo_activo" data-tipo="bool" ${P.escaneo_activo?.valor ? "checked" : ""}><span></span></label></div>
        <div class="campo"><label for="p-cuotas_siempre">Modo calibración<small>${esc(P.cuotas_siempre?.descripcion || "")}</small></label>
          <label class="sw"><input id="p-cuotas_siempre" type="checkbox" data-k="cuotas_siempre" data-tipo="bool" ${P.cuotas_siempre?.valor ? "checked" : ""}><span></span></label></div>
        ${["presupuesto_diario", "reserva_api", "intervalo_radar_min", "intervalo_seguimiento_min", "fraccion_radar", "max_detalle_escaneo", "stake"].map((k) => campoNum(k)).join("")}
        <div class="botones"><button class="btn" id="btn-guardar">Guardar cambios</button></div>
      </div>

      <div class="titulo-seccion"><h2>Últimos escaneos</h2></div>
      <div class="tarjeta tabla-wrap"><table><thead><tr><th>Hora</th><th>Estado</th><th>Vivos</th><th>Cand.</th><th>API</th><th>Alertas</th></tr></thead><tbody>
        ${c.escaneos.map((e) => `<tr><td>${hora(e.ts)}</td><td>${esc(e.motivo)}</td><td>${e.partidos_vivos ?? "–"}</td><td>${e.candidatos ?? "–"}</td><td>${e.llamadas}</td><td>${e.alertas}</td></tr>`).join("") || `<tr><td colspan="6">Sin escaneos</td></tr>`}
      </tbody></table></div>

      <div class="titulo-seccion"><h2>Versiones de la regla</h2></div>
      <div class="tarjeta">${c.reglas.map((r) => `<div class="fila detalle"><span><b>${esc(r.version)}</b> · ${hora(r.creada)}</span><span>${esc(r.notas || "")}</span></div>`).join("")}</div>

      <div class="titulo-seccion"><h2>Administrador</h2></div>
      <div class="tarjeta"><p class="nota" style="margin:0">Los cambios piden un PIN. Se recuerda solo en este dispositivo.</p>
        <div class="botones"><button class="btn sec" id="btn-pin">Cambiar PIN</button><button class="btn sec" id="btn-olvidar">Olvidar PIN aquí</button></div></div>`;
  },
};

async function guardar(P) {
  const cambios = {};
  document.querySelectorAll("[data-k]").forEach((i) => {
    const k = i.dataset.k;
    let v;
    if (i.dataset.tipo === "bool") v = i.checked;
    else if (i.dataset.tipo === "horas") v = i.value.split(/[,\s]+/).filter(Boolean).map(Number);
    else v = Number(i.value);
    if (JSON.stringify(v) !== JSON.stringify(P[k]?.valor)) cambios[k] = v;
  });
  const horasGrid = document.querySelectorAll(".hora");
  if (horasGrid.length) {
    const utc = [...horasGrid].filter((b) => b.classList.contains("on")).map((b) => localAUtc(Number(b.dataset.hora)));
    const ordenar = (a) => [...a].sort((x, y) => x - y);
    if (JSON.stringify(ordenar(utc)) !== JSON.stringify(ordenar(P.horas_activas_utc?.valor || []))) cambios.horas_activas_utc = utc;
  }
  const pesos = {};
  document.querySelectorAll("[data-peso]").forEach((i) => { pesos[i.dataset.peso] = Number(i.value); });
  if (Object.keys(pesos).length && JSON.stringify(pesos) !== JSON.stringify(Object.fromEntries(Object.keys(pesos).map((k) => [k, P.pesos_ip.valor[k]])))) cambios.pesos_ip = pesos;
  if (!Object.keys(cambios).length) return toast("No hay cambios");
  const tocaRegla = Object.keys(cambios).some((k) => P[k]?.es_regla);
  let nota;
  if (tocaRegla) {
    nota = prompt("Esto crea una nueva versión de la regla. Describe el cambio (queda en el historial):", Object.keys(cambios).join(", "));
    if (nota === null) return;
  }
  const r = await conPin((pin) => post("/admin/config", { pin, cambios, nota }));
  if (r) { toast(r.nueva_version ? `Guardado como ${r.nueva_version}` : "Guardado"); navegar(); }
}

// ---------- notificaciones push ----------
const b64aBytes = (s) => {
  const b = atob((s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
async function estadoPush() {
  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const instalada = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { puede: false, activa: false, texto: iOS && !instalada
      ? "En iPhone primero instala la app: botón Compartir → Agregar a inicio. Luego ábrela desde el ícono y vuelve aquí."
      : "Este navegador no soporta notificaciones push." };
  }
  if (Notification.permission === "denied") return { puede: false, activa: false, texto: "Las notificaciones están bloqueadas para este sitio. Actívalas en los permisos del navegador." };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return sub
    ? { puede: false, activa: true, texto: "Notificaciones activas en este dispositivo." }
    : { puede: true, activa: false, texto: "Activa las notificaciones para recibir las alertas aunque la app esté cerrada." };
}
async function activarPush() {
  try {
    const permiso = await Notification.requestPermission();
    if (permiso !== "granted") return toast("Permiso no concedido");
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await get("/vapid");
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aBytes(publicKey) });
    await post("/suscribir", sub.toJSON());
    toast("Notificaciones activadas");
    navegar();
  } catch (e) { toast("No se pudo activar: " + e.message); }
}
async function desactivarPush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) { await post("/desuscribir", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
  toast("Notificaciones desactivadas");
  navegar();
}

// ---------- enrutado ----------
let turno = 0;
async function navegar(silencioso = false) {
  const tab = (location.hash.replace("#", "") || "vivo");
  const nombre = pantallas[tab] ? tab : "vivo";
  document.querySelectorAll(".tabs a").forEach((a) => {
    const activo = a.dataset.tab === nombre;
    a.classList.toggle("activo", activo);
    if (activo) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const mio = ++turno;
  if (!silencioso) vista.innerHTML = `<p class="vacio">Cargando…</p>`;
  try {
    const html = await pantallas[nombre]();
    if (mio === turno) vista.innerHTML = html;
    if (nombre !== "vivo") get("/resumen").then(pintarEncabezado).catch(() => {});
  } catch (e) {
    if (mio === turno && !silencioso) vista.innerHTML = `<div class="tarjeta vacio"><strong>No se pudo cargar</strong>${esc(e.message)}. Revisa tu conexión y vuelve a intentar.</div>`;
  }
}
addEventListener("hashchange", () => navegar());
// Refresco automático solo en pantallas de lectura y con la app visible (no gasta batería en segundo plano)
setInterval(() => {
  const tab = location.hash.replace("#", "") || "vivo";
  if (!document.hidden && (tab === "vivo" || tab === "radar" || tab === "alertas")) navegar(true);
}, REFRESCO_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) navegar(true); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
navegar();
