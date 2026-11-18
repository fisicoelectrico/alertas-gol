// =====================================================================
// ADN Soccer · acceso de amigos y pantallas para gente común (especificación 1.6)
//
//  - Entrar con el enlace personal de WhatsApp (#entrar/<token>): un toque y ese celular queda
//    registrado. El token de sesión se guarda en localStorage (para la app) y en IndexedDB (para que
//    el service worker pueda marcar Entré / No entro desde la notificación).
//  - Tutorial de 5 pasos, una sola vez.
//  - Pestañas: Ahora, Historial, Mi banca (+ Control para el administrador, con lo técnico de siempre).
//  - Vocabulario: nunca "apuesta". Se dice entrada, entrada sugerida, invertido.
// =====================================================================
let YO = null;            // { id, nombre, rol, banca_inicial } o null
let MODO = "abierto";     // abierto = la app funciona sin sesión (transición); cerrado = exige enlace

// Sin sesión y en modo abierto, la app se comporta como antes (Fredy con su PIN).
const esAdmin = () => YO ? YO.rol === "admin" : MODO === "abierto";
const esAdminSesion = () => YO?.rol === "admin";

// ---------- formato colombiano ----------
const pesos = (v) => (v < 0 ? "−" : "") + "$" + Math.round(Math.abs(Number(v) || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const masPesos = (v) => (v > 0 ? "+" : "") + pesos(v);
const coma = (v, d = 2) => (v == null || isNaN(Number(v)) ? "–" : Number(v).toFixed(d).replace(".", ","));
const pct = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${coma(Math.abs(v), 1)} %`);

// ---------- token en IndexedDB (lo lee el service worker) ----------
function idb(accion, valor) {
  return new Promise((ok) => {
    try {
      const req = indexedDB.open("adn", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => {
        const tx = req.result.transaction("kv", "readwrite");
        if (accion === "poner") tx.objectStore("kv").put(valor, "sesion");
        else tx.objectStore("kv").delete("sesion");
        tx.oncomplete = () => ok(true); tx.onerror = () => ok(false);
      };
      req.onerror = () => ok(false);
    } catch (_) { ok(false); }
  });
}
function guardarSesion(t) { try { localStorage.setItem("sesion", t); } catch (_) {} return idb("poner", t); }
function borrarSesion() { try { localStorage.removeItem("sesion"); } catch (_) {} return idb("borrar"); }

let avisoInvalida = false;
async function sesionInvalida() {
  if (avisoInvalida) return; avisoInvalida = true;
  await borrarSesion();
  YO = null;
  toast("Tu acceso ya no es válido. Pídele a Fredy un enlace nuevo.");
  setTimeout(arrancar, 300);
}

// ---------- encabezado y pestañas según el rol ----------
const ICONOS = {
  ahora: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>`,
  historial: `<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
  banca: `<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M16 15h2"/></svg>`,
  control: `<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>`,
};
function pintarMarco() {
  const tabs = [["ahora", "Ahora"], ["historial", "Historial"], ["banca", "Mi banca"]];
  if (esAdmin()) tabs.push(["control", "Control"]);
  const nav = $("nav.tabs");
  nav.style.gridTemplateColumns = `repeat(${tabs.length}, 1fr)`;
  nav.innerHTML = tabs.map(([k, t]) => `<a href="#${k}" data-tab="${k}">${ICONOS[k]}<span>${t}</span></a>`).join("");
  nav.hidden = false;
  $(".marca").innerHTML = `${logoSVG(26)}<div><h1>ADN Soccer</h1><p class="lema">Esto no es apostar, es trading basado en estadísticas.</p></div>
    <span class="punto" id="punto-estado" title="Estado del escáner" ${esAdmin() ? "" : "hidden"}></span>`;
  $(".barra-der").hidden = !esAdmin();
}

// ---------- Entrar con el enlace ----------
function pantallaEntrar(token, error) {
  $("nav.tabs").hidden = true; $(".barra").hidden = true;
  vista.innerHTML = `<section class="entrar">
      ${logoSVG(84)}
      <h1>ADN <b>Soccer</b></h1>
      <p class="lema">Esto no es apostar, es trading basado en estadísticas.</p>
      ${token ? `<div class="tarjeta entrar-caja">
          <h2>¡Hola!</h2>
          <p>Fredy te invitó. Toca el botón y este celular queda como tuyo. No necesitas contraseña.</p>
          <button class="btn grande" id="btn-entrar">Entrar y activar avisos</button>
          <p class="nota">Te pediremos permiso para enviarte notificaciones. Sin eso no te llegan las alertas.</p>
          ${error ? `<p class="error">${esc(error)}</p>` : ""}
        </div>`
      : `<div class="tarjeta entrar-caja">
          <h2>Necesitas tu enlace</h2>
          <p>ADN Soccer es solo con invitación. Pídele a Fredy tu enlace personal por WhatsApp y ábrelo en este celular.</p>
          ${error ? `<p class="error">${esc(error)}</p>` : ""}
        </div>`}
    </section>`;
  $("#btn-entrar")?.addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Entrando…";
    try {
      const r = await post("/acceso/canjear", { token });
      await guardarSesion(r.sesion);
      history.replaceState(null, "", location.pathname + "#ahora");
      // Permiso de notificaciones dentro del mismo toque del usuario (Android lo exige así)
      if ("Notification" in window && Notification.permission === "default") await activarPush().catch(() => {});
      else if ("Notification" in window && Notification.permission === "granted") await resuscribir();
      avisoInvalida = false;
      $(".barra").hidden = false;
      await arrancar(true);
    } catch (err) {
      pantallaEntrar(token, err.message);
    }
  });
}

async function usarSesion(r) {
  await guardarSesion(r.sesion);
  YO = r.usuario; avisoInvalida = false;
  if ("Notification" in window && Notification.permission === "granted") resuscribir();
}

// Si ya había permiso de notificaciones, la suscripción se vuelve a ligar a la persona
async function resuscribir() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    if (sub) await post("/suscribir", sub.toJSON());
    else if (Notification.permission === "granted") await activarPush();
  } catch (_) {}
}

// ---------- Tutorial (5 pasos, para explicarlo a cualquiera) ----------
const PASOS = [
  { t: "¿Qué hace ADN Soccer?", h: `<div class="tut-partido"><div><b>Fuerte</b><small>debería ganar</small></div><span class="num">0 – 1</span><div><b>Débil</b><small>va ganando</small></div></div>
      <p class="tut-ataca">¡Ataca y ataca!</p>`,
    p: "Miramos muchos partidos a la vez. Buscamos un equipo fuerte que va perdiendo y que <b>ataca muchísimo</b>. Cuando lo encontramos, <b>te avisamos</b>." },
  { t: "Te llega un aviso", h: `<div class="tut-notif"><small>ADN Soccer</small><b>Nueva alerta · EN VIVO</b><span><b>CRB 0–1 Ceará</b>, minuto 66. CRB es favorito, va perdiendo y ataca mucho. Otro gol paga <b>1,33</b>.</span></div>
      <ol class="tut-lista"><li>Qué partido es y cómo va</li><li>En qué minuto va</li><li>Cuánto paga si hay otro gol</li></ol>`,
    p: "Si no lo ves enseguida, te lo recordamos cada 5 minutos, hasta 4 veces." },
  { t: "¿Qué quiere decir \"paga 1,33\"?", h: `<div class="tut-cuentas"><div class="tarjeta">Entras con <b>$10.000</b></div>
      <div class="tarjeta pos">Si hay otro gol<br><b>$13.300</b><small>ganaste $3.300</small></div>
      <div class="tarjeta neg">Si no hay gol<br><b>$0</b><small>perdiste $10.000</small></div></div>`,
    p: "El número te dice cuánto se multiplica lo que pones si hay otro gol antes de que termine el partido." },
  { t: "Tú decides", h: `<div class="tut-decide"><span class="btn">Sí, entré</span><p>Tócalo si entraste. Si quieres, escribe con cuánto y así llevamos tu cuenta.</p>
      <span class="btn sec">No entro</span><p>Tócalo si no quieres. Dejamos de avisarte de ese partido.</p></div>`,
    p: "La app <b>no entra por ti</b>. Tú entras en tu plataforma y aquí solo lo marcas." },
  { t: "Mira cómo vas", h: `<ul class="tut-lista sin"><li><b class="pos">✓ Verde:</b> hubo otro gol. Ganaste.</li><li><b class="neg">✕ Rojo:</b> no hubo gol. Perdiste.</li><li><b>Mi banca:</b> cuánta plata llevas.</li></ul>
      <div class="tarjeta tut-importante"><b>Muy importante</b><p>Ningún aviso es seguro. Algunas veces se pierde. Entra solo con plata que no te haga falta.</p></div>`,
    p: "" },
];
function mostrarTutorial() {
  return new Promise((listo) => {
    let i = 0;
    const capa = document.createElement("div");
    capa.className = "tutorial"; capa.setAttribute("role", "dialog"); capa.setAttribute("aria-modal", "true");
    document.body.appendChild(capa);
    const fin = () => { try { localStorage.setItem("tutorialVisto", "1"); } catch (_) {} capa.remove(); listo(); };
    const pintar = () => {
      const s = PASOS[i], ult = i === PASOS.length - 1;
      capa.innerHTML = `<div class="tut-caja">
          <div class="fila"><span class="tut-paso">PASO ${i + 1} DE ${PASOS.length}</span>${ult ? "" : `<button type="button" class="tut-saltar">Saltar</button>`}</div>
          <div class="tut-puntos">${PASOS.map((_, k) => `<i class="${k <= i ? "on" : ""}"></i>`).join("")}</div>
          <h2>${s.t}</h2>${s.h}${s.p ? `<p class="tut-texto">${s.p}</p>` : ""}
          <button type="button" class="btn grande tut-sig">${ult ? "¡Listo, empecemos!" : "Siguiente"}</button>
        </div>`;
      capa.querySelector(".tut-saltar")?.addEventListener("click", fin);
      capa.querySelector(".tut-sig").addEventListener("click", () => { if (ult) fin(); else { i++; pintar(); } });
      capa.querySelector(".tut-sig").focus();
    };
    pintar();
  });
}

// ---------- Registrar entrada (hoja con monto opcional) ----------
function hojaEntrada(x) {
  const cerrada = x.resultado !== "pendiente";
  // Abierta: la cuota de ahora. Cerrada: la de la alerta (la que se sugirió en su momento).
  const cuotaBase = Number(cerrada ? x.cuota : (x.cuota_actual ?? x.cuota));
  const capa = document.createElement("div");
  capa.className = "hoja-fondo";
  capa.innerHTML = `<div class="hoja" role="dialog" aria-modal="true" aria-labelledby="hoja-t">
      <h2 id="hoja-t">${cerrada ? "Marcar que entraste" : "¿Con cuánto entraste?"} <small>(monto opcional)</small></h2>
      ${cerrada ? `<p class="nota" style="margin:0">Este partido ya terminó (${x.resultado === "acierto" ? "hubo gol" : "no hubo gol"}). Queda registrado como marcado después.</p>` : ""}
      <p class="nota">${esc(x.local)} ${esc(x.marcador?.replace("-", "–"))} ${esc(x.visitante)} · otro gol a ${coma(cuotaBase)}</p>
      <label class="campo-vert">Monto en pesos<input id="h-monto" type="text" inputmode="numeric" placeholder="$0" value="${x.mi_monto ? Number(x.mi_monto) : ""}"></label>
      <div class="chips-monto">${[10000, 20000, 50000, 100000].map((v) => `<button type="button" class="filtro" data-v="${v}">${v / 1000} mil</button>`).join("")}</div>
      <div class="tarjeta h-calculo" id="h-calc"></div>
      <label class="campo-vert">¿Te la pagaron distinto? Cuota que tomaste<input id="h-cuota" type="text" inputmode="decimal" value="${coma(x.mi_cuota ?? cuotaBase)}"></label>
      <button class="btn grande" id="h-guardar">Guardar entrada</button>
      <button class="btn sec" id="h-sin">Marcar sin monto (solo cuenta para el yield)</button>
      ${x.mi_decision ? `<button class="btn-texto neg" id="h-quitar">Quitar mi marca</button>` : ""}
      <button class="btn-texto" id="h-cerrar">Cancelar</button>
    </div>`;
  document.body.appendChild(capa);
  const monto = () => Number(capa.querySelector("#h-monto").value.replace(/\D/g, "")) || 0;
  const cuota = () => Number(capa.querySelector("#h-cuota").value.replace(",", ".")) || cuotaBase;
  const calc = () => {
    const m = monto(), c = cuota();
    capa.querySelector("#h-calc").innerHTML = m
      ? `<div class="fila"><span>Si hay otro gol, recibes <b>${pesos(m * c)}</b></span><b class="pos">+${pesos(m * (c - 1))}</b></div>
         <div class="fila"><span>Si no hay gol, pierdes</span><b class="neg">−${pesos(m)}</b></div>`
      : `<span class="nota" style="margin:0">Escribe el monto para ver cuánto ganarías.</span>`;
    capa.querySelectorAll(".chips-monto .filtro").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === m));
  };
  const cerrar = () => capa.remove();
  capa.querySelector("#h-monto").addEventListener("input", (e) => {
    const v = e.target.value.replace(/\D/g, ""); e.target.value = v ? pesos(Number(v)) : ""; calc();
  });
  capa.querySelector("#h-cuota").addEventListener("input", calc);
  capa.querySelectorAll(".chips-monto .filtro").forEach((b) => b.addEventListener("click", () => {
    capa.querySelector("#h-monto").value = pesos(Number(b.dataset.v)); calc();
  }));
  const enviar = async (conMonto) => {
    const c = cuota();
    try {
      await post("/entradas", { alerta_id: x.id, decision: "entre", monto: conMonto && monto() ? monto() : null,
                                cuota: Math.abs(c - Number(x.cuota)) > 0.001 ? c : null });
      cerrar(); toast("Listo, quedó marcada tu entrada"); navegar(true);
    } catch (e) { toast(e.message); }
  };
  capa.querySelector("#h-guardar").addEventListener("click", () => enviar(true));
  capa.querySelector("#h-sin").addEventListener("click", () => enviar(false));
  capa.querySelector("#h-cerrar").addEventListener("click", cerrar);
  capa.querySelector("#h-quitar")?.addEventListener("click", async () => {
    try { await post("/entradas", { alerta_id: x.id, decision: "borrar" }); cerrar(); toast("Marca quitada"); navegar(true); }
    catch (e) { toast(e.message); }
  });
  capa.addEventListener("click", (e) => { if (e.target === capa) cerrar(); });
  if (x.mi_monto) capa.querySelector("#h-monto").value = pesos(Number(x.mi_monto));
  calc();
}

// ---------- tarjeta de una alerta abierta ----------
function tarjetaAbierta(x) {
  const favNom = x.favorito === "away" ? x.visitante : x.local;
  const gol = !!x.gol_avisado;
  const enJuego = x.estado === "1H" || x.estado === "2H";
  const cuota = x.cuota_actual ?? x.cuota;
  const mia = !YO ? `<p class="nota">Entra con tu enlace personal para marcar tus entradas.</p>`
    : gol ? (x.mi_decision === "entre" ? `<p class="marcada pos">Entraste${x.mi_monto ? ` con ${pesos(x.mi_monto)}` : ""}. ¡Salió el gol!</p>` : "")
    : x.mi_decision === "entre" ? `<div class="marcada"><span>✓ Entraste${x.mi_monto ? ` con <b>${pesos(x.mi_monto)}</b>` : ""} a ${coma(x.mi_cuota ?? x.cuota)}</span>
        <button class="btn-texto" data-cambiar="${x.id}">Cambiar</button></div>`
    : x.mi_decision === "no_entro" ? `<div class="marcada"><span>No entraste en este</span><button class="btn-texto" data-cambiar="${x.id}">Cambiar</button></div>`
    : `<p class="pregunta">¿Entraste?</p><div class="dos"><button class="btn grande" data-entre="${x.id}">Sí, entré</button><button class="btn sec grande" data-no="${x.id}">No</button></div>`;
  // Franja técnica (solo admin). Etiquetas completas, nunca letras sueltas (poka-yoke: "D" se confundía con cuota).
  //  · Dominancia = IP favorito ÷ IP rival con las estadísticas acumuladas del partido.
  //  · Momentum   = la misma razón, pero solo con lo ocurrido en los últimos ~15 min (delta entre snapshots).
  //  Ambas son razones (veces), no cuotas: 1,30 significa que el favorito presiona un 30 % más que el rival.
  const dato = (nombre, valor, ayuda) => `<span title="${ayuda}"><small>${nombre}</small> <b>${valor}</b></span>`;
  const tecnico = esAdmin() ? `<div class="tecnico">
      ${dato("Dominancia", `${coma(x.dominancia)}×`, "Presión del favorito ÷ presión del rival en todo el partido")}
      ${dato("Momentum 15′", `${coma(x.momentum)}×`, "Presión del favorito ÷ presión del rival solo en los últimos ~15 minutos")}
      ${dato("Línea", `Over ${esc(x.linea_over)}`, "Mercado de la entrada sugerida: goles actuales + 0,5")}
      ${dato("Entraron", x.entraron, "Personas que marcaron Sí, entré")}
      ${dato("Push enviados", x.push_enviados ?? 0, "Notificaciones push entregadas")}
      <p class="tecnico-ayuda">Dominancia y momentum son razones de presión favorito ÷ rival (no son cuotas). 1,30× = el favorito ataca 30 % más.</p>
    </div>` : "";
  return `<article class="tarjeta abierta ${gol ? "con-gol" : ""}">
      <div class="liga-top">${esc(ligaTxt(x.pais, x.liga))}</div>
      <div class="fila"><span class="vivo">${gol ? "¡GOL! · esperando el final" : enJuego ? `EN VIVO · ${x.minuto_actual ?? x.minuto}'` : esc(ESTADOS[x.estado] || x.estado || "")}</span></div>
      <div class="marcador grande-m"><div class="equipo">${esc(x.local)}</div><div class="goles num">${x.goles_local ?? "–"} – ${x.goles_visitante ?? "–"}</div><div class="equipo der">${esc(x.visitante)}</div></div>
      ${gol ? "" : `<p class="porque">${esc(favNom)} es el favorito, va perdiendo y está atacando mucho.</p>
      <div class="sugerida"><div><small>Entrada sugerida</small><b>Habrá otro gol</b></div><div class="paga"><small>Paga</small><b class="num">${coma(cuota)}</b></div></div>`}
      <button type="button" class="ver-ficha" data-ficha="${x.fixture_id}">Ver estadísticas del partido <span aria-hidden="true">›</span></button>
      ${mia}${tecnico}
    </article>`;
}

function enlazarBotones(alertas) {
  const porId = new Map(alertas.map((a) => [String(a.id), a]));
  document.querySelectorAll("[data-entre]").forEach((b) => b.addEventListener("click", () => hojaEntrada(porId.get(b.dataset.entre))));
  document.querySelectorAll("[data-no]").forEach((b) => b.addEventListener("click", async () => {
    try { await post("/entradas", { alerta_id: Number(b.dataset.no), decision: "no_entro" }); toast("Listo. No te avisamos más de este partido."); navegar(true); }
    catch (e) { toast(e.message); }
  }));
  document.querySelectorAll("[data-cambiar]").forEach((b) => b.addEventListener("click", async () => {
    try { await post("/entradas", { alerta_id: Number(b.dataset.cambiar), decision: "borrar" }); navegar(true); }
    catch (e) { toast(e.message); }
  }));
}

// Métricas del radar "entrando en todas" (stake 1) sobre las alertas cerradas dentro de la ventana
function metricas(lista) {
  const c = lista.filter((a) => (a.resultado === "acierto" || a.resultado === "fallo") && a.en_ventana);
  const g = c.reduce((t, a) => t + (a.resultado === "acierto" ? Number(a.cuota) - 1 : -1), 0);
  return { cerradas: c.length, salieron: c.filter((a) => a.resultado === "acierto").length, yield: c.length ? 100 * g / c.length : null };
}

// Partidos en vivo, sin jerga: marcador, minuto y si es "candidato" (favorito que pierde y está en
// seguimiento). Poka-yoke (Fredy, 15 nov): sello neutro, nunca "cumpliendo": solo la alerta es llamativa. Sale de la última foto del radar (/widget), no gasta consultas de API-Football.
function listaEnVivo(w, abiertas) {
  if (!w?.partidos) return "";
  const conAlerta = new Set(abiertas.map((a) => `${a.local}|${a.visitante}`));
  const vivos = w.partidos.filter((p) => ["1H", "HT", "2H", "ET", "BT", "P", "LIVE"].includes(p.e) && !conAlerta.has(`${p.l}|${p.v}`));
  if (!vivos.length) return `<div class="titulo-seccion"><h2>En vivo</h2><small>${w.ts ? hace(w.ts) : ""}</small></div>
    <div class="tarjeta vacio" style="padding:16px">No hay partidos en vivo en este momento.</div>`;
  const cumplen = vivos.filter((p) => p.c).length;
  const fila = (p) => `<button type="button" class="vfila ${p.c ? "cumple" : ""}" ${p.id != null ? `data-ficha="${esc(p.id)}"` : "disabled"} aria-label="Ver estadísticas de ${esc(p.l)} contra ${esc(p.v)}">
      <span class="vmin num">${p.e === "HT" ? "Desc." : p.m != null ? `${p.m}'` : esc(ESTADOS[p.e] || p.e)}</span>
      <span class="vequipos"><span>${esc(p.l)}${p.fav === "home" ? " <i class=\"vfav\">★</i>" : ""}</span><span>${esc(p.v)}${p.fav === "away" ? " <i class=\"vfav\">★</i>" : ""}</span></span>
      <b class="vgoles num">${p.gl}<br>${p.gv}</b>
      ${p.c ? `<span class="vcumple">Candidato</span>` : ""}
      <span class="vflecha" aria-hidden="true">›</span>
    </button>`;
  return `<div class="titulo-seccion"><h2>En vivo</h2><small>${vivos.length} partidos${cumplen ? ` · ${cumplen} candidato${cumplen === 1 ? "" : "s"}` : ""} · ${w.ts ? hace(w.ts) : ""}</small></div>
    <div class="tarjeta lista-vivo">${vivos.map(fila).join("")}</div>
    <p class="nota explica">Toca un partido para ver goles, tarjetas y estadísticas. ★ = favorito. "Candidato" = el favorito va perdiendo y lo estamos midiendo, pero todavía no cumple todo. No es señal para entrar: solo cuenta cuando llega la alerta.</p>`;
}

// ---------- Ficha del partido: tocar una alerta o una fila en vivo (15 nov) ----------
// Para todos (admin y amigos): goles, tarjetas y estadísticas en palabras simples. Sin índices internos.
// Sale de Flashscore a pedido (GET /partido): no gasta consultas de API-Football. Mientras la hoja está
// abierta se refresca sola cada minuto.
const ICONO_INC = { gol: "⚽", penal: "⚽", autogol: "⚽", penal_fallado: "✕", amarilla: "🟨", segunda_amarilla: "🟨🟥", roja: "🟥" };
const NOMBRE_INC = { gol: "Gol", penal: "Gol de penal", autogol: "Autogol", penal_fallado: "Penal fallado", amarilla: "Amarilla", segunda_amarilla: "Doble amarilla", roja: "Roja" };

function cuerpoFicha(d, previo) {
  const local = d?.local ?? previo.local, visitante = d?.visitante ?? previo.visitante;
  const gl = d?.goles_local ?? previo.gl, gv = d?.goles_visitante ?? previo.gv;
  const est = d?.estado ?? previo.estado, min = d?.minuto ?? previo.minuto;
  const fav = d?.favorito ?? previo.fav;
  const enJuego = est === "1H" || est === "2H";
  const estado = enJuego && min != null ? `EN VIVO · ${min}'` : est === "FT" ? "Terminado" : esc(ESTADOS[est] || est || "");
  const cab = `<div class="liga-top">${esc(ligaTxt(d?.pais ?? previo.pais, d?.liga ?? previo.liga))}</div>
    <div class="fila"><span class="vivo">${estado}</span></div>
    <div class="marcador grande-m"><div class="equipo">${esc(local)}${fav === "home" ? ' <i class="vfav">★</i>' : ""}</div>
      <div class="goles num">${gl ?? "–"} – ${gv ?? "–"}</div>
      <div class="equipo der">${esc(visitante)}${fav === "away" ? ' <i class="vfav">★</i>' : ""}</div></div>`;
  if (!d) return `${cab}<p class="vacio">Cargando estadísticas…</p>`;
  if (d.error) return `${cab}<div class="tarjeta vacio">${esc(d.error)}</div>`;

  const inc = (d.incidencias || []).slice().sort((a, b) => (parseInt(a.minuto) || 0) - (parseInt(b.minuto) || 0));
  const filaInc = (i) => {
    const quien = `<span class="inc-txt"><b>${esc(i.jugador || NOMBRE_INC[i.tipo] || "")}</b>${i.jugador ? `<small>${NOMBRE_INC[i.tipo] || ""}${i.detalle && i.tipo !== "amarilla" && i.tipo !== "roja" ? ` · asistencia ${esc(i.detalle)}` : ""}</small>` : ""}</span>`;
    const ico = `<span class="inc-ico" aria-hidden="true">${ICONO_INC[i.tipo] || "•"}</span>`;
    return `<div class="inc ${i.lado === "visitante" ? "der" : ""}"><span class="inc-min num">${esc(i.minuto)}</span>
      ${i.lado === "visitante" ? `<span></span>${quien}${ico}` : `${ico}${quien}<span></span>`}</div>`;
  };
  const bloqueInc = inc.length ? `<div class="tarjeta inc-lista">${inc.map(filaInc).join("")}</div>`
    : `<p class="nota">${(gl || 0) + (gv || 0) > 0 ? "No tenemos el detalle de los goles de este partido." : "Sin goles ni tarjetas todavía."}</p>`;

  const st = d.estadisticas || [];
  const barra = (x) => {
    const a = Math.max(0, x.nl ?? 0), b = Math.max(0, x.nv ?? 0), t = a + b;
    const pa = t ? Math.round(100 * a / t) : 50;
    const gana = t && a !== b ? (a > b ? "l" : "v") : "";
    return `<div class="st"><div class="st-fila"><b class="num ${gana === "l" ? "mas" : ""}">${esc(x.local)}</b><span>${esc(x.nombre)}</span><b class="num ${gana === "v" ? "mas" : ""}">${esc(x.visitante)}</b></div>
      <div class="st-barra" aria-hidden="true"><i style="width:${pa}%"></i><i style="width:${100 - pa}%"></i></div></div>`;
  };
  const bloqueSt = st.length ? `<div class="tarjeta st-lista">${st.map(barra).join("")}</div>`
    : `<div class="tarjeta vacio" style="padding:14px">Este partido no tiene estadísticas disponibles.</div>`;
  return `${cab}
    <h3 class="ficha-t">Goles y tarjetas</h3>${bloqueInc}
    <h3 class="ficha-t">Estadísticas</h3>
    ${st.length ? `<div class="st-equipos"><span>${esc(local)}</span><span>${esc(visitante)}</span></div>` : ""}${bloqueSt}`;
}

function hojaFicha(id, previo) {
  const capa = document.createElement("div");
  capa.className = "hoja-fondo";
  capa.innerHTML = `<div class="hoja ficha" role="dialog" aria-modal="true" aria-label="Estadísticas del partido">
      <div id="ficha-c">${cuerpoFicha(null, previo)}</div>
      <button class="btn sec" id="ficha-cerrar">Cerrar</button>
    </div>`;
  document.body.appendChild(capa);
  let vivo = true;
  const cargar = async () => {
    try {
      const d = await get(`/partido?id=${encodeURIComponent(id)}`);
      if (vivo) capa.querySelector("#ficha-c").innerHTML = cuerpoFicha(d, previo);
    } catch (e) {
      if (vivo && !capa.querySelector(".st-lista, .inc-lista")) capa.querySelector("#ficha-c").innerHTML = cuerpoFicha({ error: `No se pudo cargar: ${e.message}` }, previo);
    }
  };
  const reloj = setInterval(() => { if (document.visibilityState === "visible") cargar(); }, 60000);
  const cerrar = () => { vivo = false; clearInterval(reloj); capa.remove(); document.removeEventListener("keydown", tecla); };
  const tecla = (e) => { if (e.key === "Escape") cerrar(); };
  document.addEventListener("keydown", tecla);
  capa.querySelector("#ficha-cerrar").addEventListener("click", cerrar);
  capa.addEventListener("click", (e) => { if (e.target === capa) cerrar(); });
  capa.querySelector("#ficha-cerrar").focus();
  cargar();
}

function enlazarFichas(abiertas, w) {
  const alertas = new Map(abiertas.map((a) => [String(a.fixture_id), a]));
  const vivos = new Map((w?.partidos || []).filter((p) => p.id != null).map((p) => [String(p.id), p]));
  const abrir = (id) => {
    const a = alertas.get(id), p = vivos.get(id);
    const previo = a ? { local: a.local, visitante: a.visitante, gl: a.goles_local, gv: a.goles_visitante, estado: a.estado,
                         minuto: a.minuto_actual ?? a.minuto, fav: a.favorito, liga: a.liga, pais: a.pais }
      : { local: p?.l, visitante: p?.v, gl: p?.gl, gv: p?.gv, estado: p?.e, minuto: p?.m, fav: p?.fav, liga: p?.liga, pais: null };
    hojaFicha(id, previo);
  };
  document.querySelectorAll("[data-ficha]").forEach((b) => b.addEventListener("click", () => abrir(b.dataset.ficha)));
  // Tocar el marcador de una alerta también abre la ficha (sin robar los botones Sí/No)
  document.querySelectorAll(".tarjeta.abierta").forEach((t) => t.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, .tecnico")) return;
    const b = t.querySelector("[data-ficha]");
    if (b) abrir(b.dataset.ficha);
  }));
}

// ---------- pantallas nuevas ----------
Object.assign(pantallas, {
  async ahora() {
    const [lista, push, w] = await Promise.all([get("/alertas"), estadoPush(), get("/widget").catch(() => null)]);
    const abiertas = lista.filter((a) => a.resultado === "pendiente");
    const hoyStr = new Date().toDateString();
    const m = metricas(lista.filter((a) => new Date(a.ts).toDateString() === hoyStr));
    setTimeout(() => { enlazarBotones(abiertas); enlazarFichas(abiertas, w); $("#btn-push")?.addEventListener("click", activarPush); });
    const avisoPush = push.puede ? `<div class="tarjeta aviso-push"><p><b>Activa los avisos</b> para que te lleguen las alertas aunque tengas la app cerrada.</p><button class="btn" id="btn-push">Activar avisos</button></div>`
      : !push.activa ? `<div class="tarjeta aviso-push"><p>${esc(push.texto)}</p></div>` : "";
    return `${YO ? `<p class="saludo">Hola, ${esc(YO.nombre.split(" ")[0])}</p>` : ""}
      ${avisoPush}
      ${abiertas.length ? abiertas.map(tarjetaAbierta).join("")
        : `<div class="tarjeta vacio"><strong>No hay alertas abiertas ahora</strong>El radar sigue mirando partidos. Te avisamos apenas aparezca una.</div>`}
      ${listaEnVivo(w, abiertas)}
      <div class="tarjeta hoy"><span>Hoy</span><b>${m.cerradas ? `${m.cerradas} cerrada${m.cerradas === 1 ? "" : "s"} · ${m.salieron} ${m.salieron === 1 ? "salió" : "salieron"}` : "Sin alertas cerradas todavía"}</b></div>
      ${esAdmin() ? `<p class="nota"><a href="#vivo">Ver candidatos y datos técnicos ›</a></p>` : ""}`;
  },

  async historial() {
    const lista = await get("/alertas");
    const m = metricas(lista);
    let filtro = (() => { try { return localStorage.getItem("filtroHist") || "todas"; } catch (_) { return "todas"; } })();
    if (!YO) filtro = "todas";
    // Solo las alertas dentro de la ventana de minutos de la regla vigente (las demás no cuentan en el yield)
    const todasCerradas = lista.filter((a) => a.resultado === "acierto" || a.resultado === "fallo");
    const cerradas = todasCerradas.filter((a) => a.en_ventana);
    const fuera = todasCerradas.length - cerradas.length;
    const vis = filtro === "mias" ? cerradas.filter((a) => a.mi_decision === "entre") : cerradas;
    setTimeout(() => {
      document.querySelectorAll(".filtro[data-h]").forEach((b) => b.addEventListener("click", () => {
        try { localStorage.setItem("filtroHist", b.dataset.h); } catch (_) {}
        navegar(true);
      }));
      // Tocar un partido del historial: marcar (o corregir) que sí entré
      const porId = new Map(cerradas.map((a) => [String(a.id), a]));
      document.querySelectorAll("[data-hist]").forEach((b) => b.addEventListener("click", () => hojaEntrada(porId.get(b.dataset.hist))));
    });
    const fila = (a) => {
      const ok = a.resultado === "acierto";
      const tag = YO ? `button type="button" class="hfila tocable" data-hist="${a.id}" aria-label="Marcar entrada en ${esc(a.local)} contra ${esc(a.visitante)}"` : `div class="hfila"`;
      return `<${tag}><span class="marca-res ${ok ? "pos" : "neg"}">${ok ? "✓" : "✕"}</span>
        <div class="hcuerpo"><small class="liga-top">${esc(ligaTxt(a.pais, a.liga))}</small><b>${esc(a.local)} ${a.goles_local_90 ?? a.goles_local}–${a.goles_visitante_90 ?? a.goles_visitante} ${esc(a.visitante)}</b>
          <small>Alerta al ${a.minuto}' · ${coma(a.cuota)} · ${ok ? `gol al ${a.minuto_gol ?? "?"}'` : "no hubo gol"} · ${hora(a.ts)}</small></div>
        ${a.mi_decision === "entre" ? `<span class="chip entraste">ENTRASTE${a.mi_tardia ? "*" : ""}</span>` : YO ? `<span class="marcar-mas" aria-hidden="true">＋</span>` : ""}</${YO ? "button" : "div"}>`;
    };
    const signo = m.yield == null ? "" : m.yield >= 0 ? "ganando" : "perdiendo";
    return `<div class="tarjeta resumen-hist">
        <div><b class="num">${m.cerradas}</b><span>cerradas</span></div>
        <div><b class="num">${m.salieron}</b><span>salieron</span></div>
        <div><b class="num ${m.yield >= 0 ? "pos" : "neg"}">${pct(m.yield)}</b><span>yield</span></div>
      </div>
      ${m.yield != null ? `<p class="nota explica">Por cada $100 entrados en todas, el radar va ${signo} $${coma(Math.abs(m.yield), 2)}.</p>` : ""}
      ${YO ? `<div class="filtros"><button class="filtro ${filtro === "todas" ? "on" : ""}" data-h="todas">Todas</button><button class="filtro ${filtro === "mias" ? "on" : ""}" data-h="mias">Donde entré</button></div>` : ""}
      <div class="tarjeta lista-hist">${vis.map(fila).join("") || `<p class="vacio">${filtro === "mias" ? "Todavía no has marcado entradas cerradas." : "Todavía no hay alertas cerradas."}</p>`}</div>
      ${YO ? `<p class="nota">¿Entraste y no lo marcaste? Toca el partido. Las que marcas después salen con asterisco (ENTRASTE*).</p>` : ""}
      ${fuera && esAdmin() ? `<p class="nota">${fuera} alerta${fuera === 1 ? "" : "s"} fuera de la ventana de minutos no se muestra${fuera === 1 ? "" : "n"} ni cuenta${fuera === 1 ? "" : "n"}. Están en Control → Alertas técnicas.</p>` : ""}`;
  },

  async banca() {
    if (!YO) {
      setTimeout(() => $("#btn-vincular")?.addEventListener("click", async () => {
        const r = await conPin((pin) => post("/admin/vincular", { pin }));
        if (r) { await usarSesion(r); toast(`Listo, ${r.usuario.nombre}: este celular quedó como tuyo`); arrancar(); }
      }));
      return `<div class="tarjeta vacio"><strong>Tu banca es personal</strong>Entra con tu enlace personal para llevar tus entradas y tu yield.
        ${MODO === "abierto" ? `<div class="botones" style="justify-content:center"><button class="btn sec" id="btn-vincular">Soy el administrador: usar mi PIN</button></div>` : ""}</div>`;
    }
    const b = await get("/mi-banca");
    const y = b.yo, r = b.radar;
    setTimeout(() => {
      $("#btn-banca")?.addEventListener("click", async () => {
        const v = prompt("¿Con cuánta plata empezaste? (en pesos, solo números)", b.banca_inicial ?? "");
        if (v === null) return;
        try { await post("/mi-banca", { banca_inicial: v.replace(/\D/g, "") || null }); YO.banca_inicial = Number(v.replace(/\D/g, "")) || null; navegar(true); }
        catch (e) { toast(e.message); }
      });
      $("#btn-meta")?.addEventListener("click", async () => {
        const v = prompt("¿Qué % de tu banca quieres ganar en cada entrada? (ej. 1). Vacío = sin monto sugerido", b.ganancia_pct ?? "");
        if (v === null) return;
        try { await post("/mi-banca", { ganancia_pct: v.trim() || null }); navegar(true); }
        catch (e) { toast(e.message); }
      });
      $("#btn-tutorial")?.addEventListener("click", () => mostrarTutorial());
      $("#btn-push")?.addEventListener("click", activarPush);
    });
    // Monto sugerido (DECISIONES 41): monto = banca × % / (cuota − 1), tope monto_max_pct % de la banca
    const sugerido = (c) => {
      const ideal = b.banca_actual * b.ganancia_pct / 100 / (c - 1), techo = b.banca_actual * b.monto_max_pct / 100;
      return Math.max(Math.round(Math.min(ideal, techo) / 100) * 100, 100);
    };
    const meta = b.banca_inicial == null ? "" : b.ganancia_pct
      ? `<div class="tarjeta"><div class="fila"><span><b>Monto sugerido</b></span><b class="num">${String(b.ganancia_pct).replace(".", ",")} % por entrada</b></div>
          <p class="nota" style="margin-top:4px">Cada aviso te dice cuánto entrar en la casa que paga menos para ganar ${String(b.ganancia_pct).replace(".", ",")} % de tu banca (${pesos(b.banca_actual * b.ganancia_pct / 100)}).
          Con tu banca de hoy: cuota 1,30 → ${pesos(sugerido(1.3))} · 1,50 → ${pesos(sugerido(1.5))} · 2,00 → ${pesos(sugerido(2))}. Nunca más del ${b.monto_max_pct} % de la banca.</p>
          <div class="fila nota"><span></span><button class="btn-texto" id="btn-meta">Cambiar %</button></div></div>`
      : `<div class="tarjeta"><p>¿Quieres que cada aviso te diga cuánto entrar? Elige qué % de tu banca quieres ganar por entrada.</p>
          <button class="btn sec" id="btn-meta">Elegir mi %</button></div>`;
    // Curva de la banca (solo entradas con monto, en orden de tiempo)
    const conMonto = b.movimientos.filter((m) => m.decision === "entre" && m.monto && m.ganancia != null).reverse();
    let curva = "";
    if (b.banca_inicial != null && conMonto.length) {
      let acc = Number(b.banca_inicial);
      const pts = [acc, ...conMonto.map((m) => (acc += Number(m.ganancia)))];
      const min = Math.min(...pts), max = Math.max(...pts), W = 320, H = 70, P = 6;
      const X = (i) => (i / Math.max(pts.length - 1, 1)) * W, Y = (v) => H - P - ((v - min) / Math.max(max - min, 1)) * (H - 2 * P);
      curva = `<svg class="curva" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Evolución de tu banca">
        <line x1="0" x2="${W}" y1="${Y(b.banca_inicial)}" y2="${Y(b.banca_inicial)}" stroke="#3a5246" stroke-dasharray="4 4"/>
        <polyline points="${pts.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}" fill="none" stroke="#3ddc84" stroke-width="3" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
    }
    const tiene = b.banca_inicial != null ? Number(b.banca_inicial) + y.ganancia_pesos : null;
    const enJuego = b.movimientos.filter((m) => m.decision === "entre" && m.resultado === "pendiente");
    const simulada = b.banca_inicial != null && b.stake_ref && r.cerradas
      ? `<div class="tarjeta simulada"><div class="fila"><span>Banca simulada</span><b class="${r.ganancia_u >= 0 ? "pos" : "neg"}">${pesos(Number(b.banca_inicial) + r.ganancia_u * b.stake_ref)}</b></div>
          <p class="nota" style="margin-top:4px">Lo que tendrías si hubieras entrado en las ${r.cerradas} alertas cerradas desde que llegaste, con ${pesos(b.stake_ref)} cada una.</p></div>` : "";
    const mov = (m) => {
      const ok = m.resultado === "acierto", abierta = m.resultado === "pendiente";
      if (m.decision !== "entre") return "";
      return `<div class="hfila"><div class="hcuerpo"><b>${esc(m.local)}–${esc(m.visitante)} ${abierta ? "" : ok ? "✓" : "✕"}</b>
          <small>${m.monto ? `${pesos(m.monto)} a ${coma(m.cuota)}` : `sin monto · ${coma(m.cuota)}`}${abierta ? " · en juego" : ""}</small></div>
        ${abierta ? "" : m.monto ? `<b class="${ok ? "pos" : "neg"}">${masPesos(m.ganancia)}</b>` : `<b class="${ok ? "pos" : "neg"}">${ok ? "salió" : "no salió"}</b>`}</div>`;
    };
    return `${tiene != null ? `<div class="tarjeta banca-top">
          <span class="nota" style="margin:0">Tienes hoy</span><b class="cifra">${pesos(tiene)}</b>
          <div class="fila"><span class="tenue">Empezaste con ${pesos(b.banca_inicial)}</span><b class="${y.ganancia_pesos >= 0 ? "pos" : "neg"}">${masPesos(y.ganancia_pesos)}</b></div>
          ${curva}
          <div class="fila nota"><span>${y.entradas} entrada${y.entradas === 1 ? "" : "s"}</span><button class="btn-texto" id="btn-banca">Cambiar banca inicial</button></div>
        </div>`
      : `<div class="tarjeta banca-top"><p>¿Quieres llevar tu plata en pesos? Es opcional: sin eso igual calculamos tu yield.</p>
          <button class="btn sec" id="btn-banca">Escribir con cuánto empecé</button></div>`}
      ${meta}
      <div class="tarjeta yields">
        <div><small>Tu yield</small><b class="num ${y.yield_pct >= 0 ? "pos" : "neg"}">${pct(y.yield_pct)}</b><span>${y.cerradas} cerrada${y.cerradas === 1 ? "" : "s"} · ${y.aciertos} ${y.aciertos === 1 ? "salió" : "salieron"}</span></div>
        <div><small>Radar entrando en todas</small><b class="num ${r.yield_pct >= 0 ? "pos" : "neg"}">${pct(r.yield_pct)}</b><span>${r.cerradas} desde que llegaste</span></div>
      </div>
      <p class="nota explica">Yield = lo que ganas o pierdes por cada $100 que entras. Sin monto, cada entrada cuenta como 1.</p>
      ${simulada}
      ${enJuego.map((m) => `<div class="tarjeta en-juego"><span><b>En juego:</b> ${esc(m.local)}–${esc(m.visitante)}</span><b>${m.monto ? pesos(m.monto) : "sin monto"}</b></div>`).join("")}
      <div class="titulo-seccion"><h2>Movimientos</h2></div>
      <div class="tarjeta lista-hist">${b.movimientos.filter((m) => m.decision === "entre").map(mov).join("") || `<p class="vacio">Cuando marques "Sí, entré" en una alerta, aparece aquí.</p>`}</div>
      <div class="botones"><button class="btn-texto" id="btn-tutorial">Ver el tutorial otra vez</button></div>`;
  },

  async control() {
    const r = await get("/resumen");
    pintarEncabezado(r);
    let amigos = null;
    if (esAdminSesion() || pinGuardado()) amigos = await conPin((pin) => post("/admin/usuarios", { pin, accion: "listar" })).catch(() => null);
    const activos = amigos?.usuarios?.filter((u) => u.activo && u.rol !== "admin").length ?? 0;
    const pendientes = amigos?.usuarios?.filter((u) => u.enlace_vence).length ?? 0;
    const item = (h, t, d) => `<a class="tarjeta control-item" href="#${h}"><b>${t}</b><small>${d}</small><span aria-hidden="true">›</span></a>`;
    return `<div class="tarjeta control-estado"><span class="punto ${r.escaneo_activo ? "ok" : "pausa"}"></span>
        <div><b>Radar ${r.escaneo_activo ? "encendido" : "apagado"}</b><small>Regla ${esc(r.regla_version)} · ${esc(resumirHoras(r.horas_activas_utc))}</small></div></div>
      ${item("amigos", "Amigos", amigos ? `${activos} con acceso · ${pendientes} enlace${pendientes === 1 ? "" : "s"} sin usar · modo ${amigos.modo_acceso}` : "Crear enlaces y ver quién entra")}
      ${item("vivo", "En vivo técnico", "Candidatos en seguimiento con dominancia, momentum y cuota")}
      ${item("radar", "Radar", "Partidos en vivo y por qué se descartan")}
      ${item("agenda", "Favoritos de hoy y mañana", "Agenda de Flashscore con la cuota prepartido de cada favorito")}
      ${item("candidatos", "Candidatos", "Los que no llegaron a alerta y su desenlace")}
      ${item("alertas", "Alertas técnicas", "Cada alerta con sus números")}
      ${item("rendimiento", "Rendimiento técnico", "Acierto vs implícita, por regla y por liga")}
      ${item("ligas", "Ligas", "Encender y apagar ligas")}
      ${item("ajustes", "Ajustes del algoritmo", "Umbrales, horario, presupuesto de API, notificaciones")}
      ${item("laboratorio", "Laboratorio", "Umbral de entrada automático, cuotas en vivo y gráficas (goles y córners)")}
      ${item("corners", "Córners (laboratorio)", "Avisos de córners solo para ti y su acierto vs cuota")}`;
  },

  // ---------- Agenda con favoritos (DECISIONES 42): sale 100 % de Flashscore ----------
  async agenda() {
    const r = await get("/agenda");
    const hora = (t) => new Date(t).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" });
    const c2 = (v) => (v == null ? "–" : Number(v).toFixed(2).replace(".", ","));
    const bloque = (titulo, g) => {
      if (!g) return `<div class="titulo-seccion"><h2>${titulo}</h2></div><div class="tarjeta vacio">Todavía sin partidos en la agenda. La lista de mañana se lee cada 6 horas.</div>`;
      const filas = g.favoritos.map((p) => {
        const fav = p.fav === "home" ? p.local : p.visitante;
        return `<div class="fila-agenda"><span class="num">${hora(p.kickoff)}</span>
          <span><b>${esc(fav)}</b> <small>${esc(p.local)} vs ${esc(p.visitante)} · ${esc(p.pais ? `${p.pais} · ${p.liga}` : p.liga)}</small></span>
          <b class="num">${c2(p.cf)}</b></div>`;
      }).join("");
      return `<div class="titulo-seccion"><h2>${titulo}</h2><small>${g.favoritos.length} favoritos</small></div>
        <div class="tarjeta lista-hist">${filas || `<p class="vacio">Ningún favorito con cuota ≤ ${c2(r.cuota_fav_max)} todavía.</p>`}</div>
        <p class="nota">${g.total} partidos en ligas habilitadas · ${g.con_cuota} con cuota · ${g.pendientes} por consultar (el escáner pide unas 12 cuotas cada 5 minutos, empezando por los más cercanos).</p>`;
    };
    return `<p class="nota explica">Favorito = el equipo con la cuota de apertura más baja, promedio de las casas colombianas en Flashscore. Solo se listan los que cumplen el filtro del radar (cuota ≤ ${c2(r.cuota_fav_max)}). Hora de Colombia.</p>
      ${bloque("Hoy", r.hoy)}${bloque("Mañana", r.manana)}`;
  },

  // ---------- Laboratorio (DECISIONES 40): umbral automático y gráficas, solo administrador ----------
  async laboratorio() {
    const r = await conPin((pin) => post("/admin/laboratorio", { pin }));
    if (!r) return `<div class="tarjeta vacio"><strong>Necesitas ser administrador</strong>Abre tu enlace de administrador o escribe el PIN.</div>`;
    const P = r.params || {};
    const NOM = { gt_o15: "Gol temprano · Más de 1,5", gt_o25: "Gol temprano · Más de 2,5",
      c1t_cero20: "Córners 1T · 0 córners al 20'", c2t_fav77: "Córners 2T · favorito perdiendo al 77'" };
    const ORDEN = ["gt_o15", "gt_o25", "c1t_cero20", "c2t_fav77"];
    const RES = { acierto: "✅ Salió", fallo: "❌ No salió", pendiente: "⏳ En juego", anulada: "Anulada" };
    const c2 = (v) => n(v).replace(".", ",");
    const pct = (v) => (v == null ? "–" : `${Math.round(Number(v) * 100)}%`);
    setTimeout(() => {
      $("#btn-lab")?.addEventListener("click", async () => {
        const cambios = {};
        document.querySelectorAll("[data-lab]").forEach((i) => {
          const v = i.type === "checkbox" ? i.checked : Number(i.value);
          if (JSON.stringify(v) !== JSON.stringify(P[i.dataset.lab])) cambios[i.dataset.lab] = v;
        });
        if (!Object.keys(cambios).length) return toast("No hay cambios");
        const g = await conPin((pin) => post("/admin/config", { pin, cambios }));
        if (g) { toast(g.nueva_version ? `Guardado como ${g.nueva_version}` : "Guardado"); navegar(); }
      });
    });

    // Umbral de hoy y su historia por estrategia
    const porEst = {};
    for (const u of r.umbrales || []) (porEst[u.estrategia] ??= []).push(u);
    const hoy = (e) => (porEst[e] || []).slice(-1)[0];

    // Gráfica de líneas en SVG (sin librerías). series: [{pts:[{x,y,t}], cls}]
    const grafica = ({ series, umbral, xEtq, yDec = 2, alto = 120, xMin, xMax, aria }) => {
      const todos = series.flatMap((s) => s.pts).filter((p) => Number.isFinite(p.y));
      if (!todos.length) return `<p class="nota">Todavía sin datos para graficar.</p>`;
      const W = 320, H = alto, PL = 34, PR = 8, PT = 8, PB = 18;
      const x0 = xMin ?? Math.min(...todos.map((p) => p.x)), x1 = xMax ?? Math.max(...todos.map((p) => p.x));
      const ys = todos.map((p) => p.y).concat(umbral != null ? [umbral] : []);
      let y0 = Math.min(...ys), y1 = Math.max(...ys);
      if (y1 - y0 < 0.1) { y0 -= 0.05; y1 += 0.05; }
      const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
      const X = (x) => PL + (x - x0) / Math.max(x1 - x0, 1e-9) * (W - PL - PR);
      const Y = (y) => PT + (1 - (y - y0) / (y1 - y0)) * (H - PT - PB);
      const linea = (s) => s.pts.length > 1 ? `<path class="lab-l ${s.cls}" d="${s.pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ")}"/>` : "";
      const puntos = (s) => s.pts.map((p) => `<circle class="lab-p ${s.cls}" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="2.6"><title>${esc(p.t || "")}</title></circle>`).join("");
      const ticks = [y0 + pad, (y0 + y1) / 2, y1 - pad].map((v) => `<text class="lab-t" x="${PL - 4}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${n(v, yDec).replace(".", ",")}</text>
        <line class="lab-g" x1="${PL}" x2="${W - PR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`).join("");
      return `<svg class="lab-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(aria || "")}">
        ${ticks}
        ${umbral != null ? `<line class="mini-umbral" x1="${PL}" x2="${W - PR}" y1="${Y(umbral).toFixed(1)}" y2="${Y(umbral).toFixed(1)}"/>` : ""}
        ${series.map(linea).join("")}${series.map(puntos).join("")}
        <text class="lab-t" x="${PL}" y="${H - 4}">${esc(xEtq[0])}</text><text class="lab-t" x="${W - PR}" y="${H - 4}" text-anchor="end">${esc(xEtq[1])}</text>
      </svg>`;
    };
    const dia = (f) => new Date(f + "T12:00:00").toLocaleDateString("es-CO", { day: "2-digit", month: "short" });

    const tarjetaEst = (e) => {
      const u = hoy(e), h = porEst[e] || [];
      if (!u) return "";
      const t0 = new Date(h[0].fecha + "T12:00:00").getTime();
      const xs = (x) => (new Date(x.fecha + "T12:00:00").getTime() - t0) / 864e5;
      const serieU = { cls: "u", pts: h.filter((x) => x.umbral != null).map((x) => ({ x: xs(x), y: Number(x.umbral), t: `${dia(x.fecha)} · umbral ${c2(x.umbral)} (${x.aciertos}/${x.n})` })) };
      const serieJ = { cls: "j", pts: h.filter((x) => x.cuota_justa != null).map((x) => ({ x: xs(x), y: Number(x.cuota_justa), t: `${dia(x.fecha)} · cuota justa ${c2(x.cuota_justa)}` })) };
      const esGol = e.startsWith("gt_");
      // Más de 1,5: umbral según el minuto (partidos que a ese minuto seguían con un solo gol)
      const tramos = e === "gt_o15" ? [30, 45, 60, 75].map((t) => hoy(`gt_o15_m${t}`)).filter(Boolean) : [];
      const tablaTramos = tramos.length ? `<div class="tabla-wrap" style="margin-top:6px"><table><thead><tr><th>Si al minuto…</th><th>Se dio</th><th>Umbral</th></tr></thead><tbody>
          <tr><td>recién el gol</td><td>${u.aciertos}/${u.n}</td><td class="num">${c2(u.umbral)}</td></tr>
          ${tramos.map((x) => `<tr><td>${x.estrategia.slice(9)}' sigue 1 gol</td><td>${x.aciertos}/${x.n}</td><td class="num">${x.umbral ? c2(x.umbral) : "–"}</td></tr>`).join("")}
        </tbody></table></div>` : "";
      return `<div class="tarjeta">
        <div class="fila detalle"><span><b>${esc(NOM[e] || e)}</b></span><span class="num">umbral <b>${c2(u.umbral)}</b></span></div>
        <p class="nota" style="margin-top:4px">Se dio ${u.aciertos} de ${u.n} (${pct(u.p)}). Con ese tamaño de muestra lo prudente es asumir al menos ${pct(u.ic_bajo)},
          así que solo hay valor si la casa paga <b>${c2(u.umbral)}</b> o más. ${esGol ? "" : "Córners: sin cuota en vivo gratis, sirve de referencia."}
          ${u.n < Number(P.lab_n_min ?? 30) ? `<br>⚠️ Menos de ${esc(P.lab_n_min ?? 30)} casos: todavía no avisa.` : ""}</p>
        ${tablaTramos}
        ${h.length > 1 ? grafica({ series: [serieJ, serieU], xEtq: [dia(h[0].fecha), dia(h[h.length - 1].fecha)], aria: `Umbral de ${NOM[e]} por día` })
          : `<p class="nota">La gráfica del umbral por día aparece desde mañana (se guarda un punto por día).</p>`}
        ${h.length > 1 ? `<div class="mini-ley"><span><i class="lu"></i>umbral (prudente)</span><span><i class="lj"></i>cuota justa (tasa real)</span></div>` : ""}
      </div>`;
    };

    // Curvas de la mejor cuota después del gol, por oportunidad
    const curvas = (e) => {
      const ops = (r.oportunidades || []).filter((o) => o.estrategia === e && (o.serie || []).length);
      if (!ops.length) return `<div class="tarjeta vacio"><strong>${esc(NOM[e])}: aún sin curvas</strong>Aparecen cuando un partido de liga habilitada marca antes del ${esc(P.lab_gt_minuto ?? 15)}'. Desde ahí se fotografía la cuota cada ${esc(P.lab_intervalo_min ?? 2)} min los primeros 15 y luego cada ${esc(P.lab_intervalo_largo_min ?? 5)}, hasta el 2.º gol o el final.</div>`;
      const series = ops.map((o) => ({ cls: o.resultado, pts: o.serie.filter((p) => p.m != null).map((p) => ({ x: p.m - o.minuto_gatillo, y: Number(p.c), t: `${o.local}–${o.visitante} · +${p.m - o.minuto_gatillo}' · ${p.casa} ${c2(p.c)}` })) }));
      const u = hoy(e);
      return `<div class="tarjeta">
        <div class="fila detalle"><span><b>${esc(NOM[e])}</b></span><span class="tenue">${ops.length} partido${ops.length === 1 ? "" : "s"}</span></div>
        ${grafica({ series, umbral: u ? Number(u.umbral) : null, xEtq: ["gol", `+${Math.min(Number(P.lab_gt_ventana_min ?? 90), 90)} min`], xMin: 0, xMax: Math.min(Number(P.lab_gt_ventana_min ?? 90), 90), alto: 150, aria: `Mejor cuota después del gol, ${NOM[e]}` })}
        <div class="mini-ley"><span><i class="la"></i>salió</span><span><i class="lf"></i>no salió</span><span><i class="lp"></i>en juego</span><span><i class="lu"></i>umbral de hoy</span></div>
        <p class="nota">Cada línea es un partido: la mejor cuota entre las casas, minuto a minuto desde el gol. Responde tu pregunta de cuánto tarda en subir la cuota.</p>
      </div>`;
    };

    const resumen = (r.resumen || []).map((x) => `<tr><td>${esc(NOM[x.estrategia] || x.estrategia)}</td>
        <td>${x.casos}<small class="sub">${x.aciertos}✅ ${x.fallos}❌</small></td>
        <td>${x.cuota_media ? c2(x.cuota_media) : "–"}<small class="sub">mejor cuota media</small></td>
        <td>${x.alertadas}<small class="sub">${x.alertadas_acierto}✅ ${x.alertadas_fallo}❌</small></td>
        <td class="${Number(x.ganancia_u) > 0 ? "pos" : Number(x.ganancia_u) < 0 ? "neg" : ""}">${x.ganancia_u == null ? "–" : `${n(x.ganancia_u)} u`}</td></tr>`).join("");

    const fila = (o) => `<div class="tarjeta ${o.resultado === "acierto" ? "acierto" : o.resultado === "fallo" ? "fallo" : ""}">
        <div class="liga-top">${esc(o.liga || "")}</div>
        <div class="fila detalle"><span><b>${esc(NOM[o.estrategia] || o.estrategia)}</b></span><span>${esc(RES[o.resultado] || o.resultado)}</span></div>
        <p style="margin:6px 0 2px">${esc(o.local)} – ${esc(o.visitante)} · gol al ${o.minuto_gatillo}'${o.goles_final != null ? ` · final ${o.goles_final} goles` : ""}</p>
        <small class="sub">${hora(o.ts_inicio)}${o.vigilando ? " · vigilando la cuota" : ""}</small>
        <p class="nota">${o.mejor_cuota ? `Mejor cuota ${c2(o.mejor_cuota)} (${esc(o.mejor_casa)}, min ${o.minuto_mejor})` : "Ninguna casa ofreció esa línea"}
          · umbral ${c2(o.umbral)}${o.alertada ? ` · <b>superó el umbral</b> al ${o.minuto_alerta}' con ${esc(o.casa_alerta)} ${c2(o.cuota_alerta)}` : ""}</p>
      </div>`;

    const salud = (k, t) => { const s = P[k]; const mal = s && s.fallos > 0;
      return `<span><span class="punto ${!s ? "" : mal ? "mal" : "ok"}" style="display:inline-block"></span> ${t}${mal ? ` · ${s.fallos} fallo${s.fallos === 1 ? "" : "s"} seguido${s.fallos === 1 ? "" : "s"}` : ""}</span>`; };
    const sw = (k, t, d) => `<div class="campo"><label for="lb-${k}">${t}<small>${d}</small></label>
          <label class="sw"><input id="lb-${k}" type="checkbox" data-lab="${k}" ${P[k] !== false ? "checked" : ""}><span></span></label></div>`;
    const campo = (k, t, d) => `<div class="campo"><label for="lb-${k}">${t}<small>${d}</small></label>
      <input id="lb-${k}" type="number" step="1" inputmode="numeric" data-lab="${k}" value="${esc(P[k])}" style="max-width:80px"></div>`;
    const u24 = r.ultimas_24h || {};

    return `<div class="tarjeta">
        <div class="fila detalle"><span><b>Flashscore</b></span><span class="tenue">últimas 24 h: ${u24.fotos ?? 0} fotos de ${u24.partidos ?? 0} partidos</span></div>
        <div class="mini-ley" style="margin-top:6px">${salud("fs_salud_lista", "lista en vivo")}${salud("fs_salud_vivo", "cuotas en vivo")}</div>
        <p class="nota">Si falla ${esc(P.fs_fallos_aviso ?? 3)} ciclos seguidos te llega "⚠️ Flashscore no responde" al celular.</p>
      </div>
      <div class="titulo-seccion"><h2>Umbral de entrada</h2></div>
      <p class="nota">Lo calcula la base con las ligas habilitadas y se recalcula cada hora; queda un punto por día para ver cómo se mueve con los meses.</p>
      ${ORDEN.map(tarjetaEst).join("")}
      <div class="titulo-seccion"><h2>La cuota después del gol</h2></div>
      ${curvas("gt_o15")}${curvas("gt_o25")}
      <div class="titulo-seccion"><h2>¿Está funcionando?</h2></div>
      ${resumen ? `<div class="tarjeta tabla-wrap"><table><thead><tr><th>Estrategia</th><th>Casos</th><th>Cuota</th><th title="Las que superaron el umbral">Avisos</th><th>Ganancia</th></tr></thead><tbody>${resumen}</tbody></table></div>
        <p class="nota">La ganancia es por unidad, solo de las que superaron el umbral, con la cuota a la que lo superaron. Con menos de 30 avisos resueltos todavía no se puede concluir nada.</p>`
        : `<p class="nota">Sin casos todavía.</p>`}
      <p class="nota"><a href="#corners">Ver el detalle de córners ›</a></p>
      <div class="titulo-seccion"><h2>Últimos casos</h2></div>
      ${(r.oportunidades || []).slice(0, 30).map(fila).join("") || `<p class="nota">Sin casos todavía.</p>`}
      <div class="titulo-seccion"><h2>Parámetros</h2></div>
      <div class="tarjeta">
        ${sw("lab_activo", "<b>Laboratorio de goles</b>", "Detecta, vigila la cuota y resuelve (gratis, con Flashscore)")}
        ${sw("lab_push", "Avisos al celular", "Cuando una casa paga el umbral o más (por ahora: gol temprano, Más de 1,5)")}
        ${sw("fs_vivo_activo", "Cuotas en vivo", "Apagado: no se fotografía ninguna cuota (la alerta usa API-Football)")}
        ${campo("lab_gt_minuto", "Gol temprano hasta el minuto", "El primer gol debe caer hasta aquí")}
        ${campo("lab_gt_ventana_min", "Vigilar la cuota (min)", "Minutos después del gol; 90 = hasta el 2.º gol o el final")}
        ${campo("lab_intervalo_min", "Foto cada (min)", "Los primeros 15 min después del gol")}
        ${campo("lab_intervalo_largo_min", "Luego, foto cada (min)", "Hasta el 2.º gol o el final")}
        ${campo("lab_n_min", "Casos mínimos para avisar", "Con menos, solo registra")}
        ${campo("fs_vivo_intervalo_min", "Foto del resto cada (min)", "Partidos sin nada especial")}
        ${campo("fs_vivo_max_consultas", "Tope de consultas por ciclo", "Poka-yoke contra bloqueos (3 por partido)")}
        <div class="botones"><button class="btn" id="btn-lab">Guardar</button></div>
      </div>`;
  },

  // ---------- Córners (lab, DECISIONES 37): solo administrador ----------
  async corners() {
    const r = await conPin((pin) => post("/admin/corners", { pin }));
    if (!r) return `<div class="tarjeta vacio"><strong>Necesitas ser administrador</strong>Abre tu enlace de administrador o escribe el PIN.</div>`;
    const P = r.params || {};
    const NOMBRE = { c1t_cero20: "1T · 0 córners al 20'", c2t_fav77: "2T · favorito perdiendo al 77'" };
    const RES = { acierto: "✅ Salió", fallo: "❌ No salió", pendiente: "⏳ En juego", anulada: "Anulada" };
    const SIN = { sin_pareja_api: "sin pareja en API", tope_diario: "tope diario de consultas", sin_presupuesto_api: "sin cupo de API",
      sin_mercado: "la API no ofrecía córners", sin_mercado_de_ese_tiempo: "solo córners de otro tiempo", sin_esa_linea: "no estaba esa línea", error_api: "error de la API", cuota_apagada: "lectura de cuota apagada" };
    const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : "–";
    setTimeout(() => {
      const guardarCk = async () => {
        const cambios = {};
        document.querySelectorAll("[data-ck]").forEach((i) => {
          const v = i.type === "checkbox" ? i.checked : Number(i.value);
          if (JSON.stringify(v) !== JSON.stringify(P[i.dataset.ck])) cambios[i.dataset.ck] = v;
        });
        if (!Object.keys(cambios).length) return toast("No hay cambios");
        const g = await conPin((pin) => post("/admin/config", { pin, cambios }));
        if (g) { toast(g.version_corners ? `Guardado: ahora es la versión ${g.version_corners}` : "Guardado"); navegar(); }
      };
      $("#btn-corners")?.addEventListener("click", guardarCk);
      $("#btn-corners-sw")?.addEventListener("click", guardarCk);
    });
    const campo = (k, t, d) => `<div class="campo"><label for="ck-${k}">${t}<small>${d}</small></label>
      <input id="ck-${k}" type="number" step="1" inputmode="numeric" data-ck="${k}" value="${esc(P[k])}" style="max-width:80px"></div>`;
    const base = Object.fromEntries((r.base || []).map((b) => [b.mercado, b]));
    const resumen = (r.resumen || []).map((x) => {
      const res = x.aciertos + x.fallos, b = base[x.mercado];
      const ganaImpl = x.resueltas_con_cuota && x.implicita_pct != null ? (x.aciertos_con_cuota / x.resueltas_con_cuota * 100 > Number(x.implicita_pct)) : null;
      return `<tr><td>${esc(NOMBRE[x.mercado] || x.mercado)}<small class="sub">${esc(x.version)}${b ? ` · ${b.avisaron}/${b.revisados} revisados avisaron` : ""}</small></td>
        <td>${x.avisos}</td><td>${pct(x.aciertos, res)}<small class="sub">${x.aciertos}/${res}</small></td>
        <td class="${ganaImpl === null ? "" : ganaImpl ? "pos" : "neg"}">${pct(x.aciertos_con_cuota, x.resueltas_con_cuota)}<small class="sub">vs ${x.implicita_pct ?? "–"}% impl.</small></td>
        <td class="${Number(x.ganancia_u) > 0 ? "pos" : Number(x.ganancia_u) < 0 ? "neg" : ""}">${n(x.ganancia_u)} u</td></tr>`;
    }).join("");
    const fila = (a) => `<div class="tarjeta ${a.resultado === "acierto" ? "acierto" : a.resultado === "fallo" ? "fallo" : ""}">
        <div class="liga-top">${esc(ligaFS(a.liga).txt)}</div>
        <div class="fila detalle"><span><b>${esc(NOMBRE[a.mercado] || a.mercado)}</b> · ${esc(a.version)}</span><span>${esc(RES[a.resultado] || a.resultado)}</span></div>
        <p style="margin:6px 0 2px">${esc(a.local)} <b class="num">${a.goles_local}–${a.goles_visitante}</b> ${esc(a.visitante)} · min ${a.minuto}
          ${a.favorito ? `<small class="sub">favorito: ${esc(a.favorito === "home" ? a.local : a.visitante)}</small>` : ""}</p>
        <small class="sub">${esc(ligaFS(a.liga).fase || "")}${ligaFS(a.liga).fase ? " · " : ""}${hora(a.ts)}</small>
        <p class="nota">Córners al avisar ${a.corners_local + a.corners_visitante} · línea más de ${n(a.linea, 1).replace(".", ",")}
          · ${a.cuota ? `cuota <b>${n(a.cuota)}</b>` : `sin cuota: ${esc(SIN[a.motivo_sin_cuota] || a.motivo_sin_cuota || "–")}`}
          ${a.corners_final != null ? ` · ahora/final ${a.corners_final}` : ""}${a.nota ? ` · ${esc(a.nota)}` : ""}</p>
      </div>`;
    const sw = (k, t, d) => `<div class="campo"><label for="ck-${k}">${t}<small>${d}</small></label>
          <label class="sw"><input id="ck-${k}" type="checkbox" data-ck="${k}" ${P[k] !== false ? "checked" : ""}><span></span></label></div>`;
    return `<div class="tarjeta">
        ${sw("corners_activo", "<b>Córners (laboratorio)</b>", `Versión ${esc(P.corners_version || "c1")} · detecta, guarda y resuelve el acierto con Flashscore (gratis)`)}
        ${sw("corners_push", "Avisos al celular", "Apagado: sigue juntando datos en silencio")}
        ${sw("corners_cuota", "Leer la cuota", `1 consulta de API por aviso · hoy ${r.consultas_hoy}/${esc(P.corners_api_max_dia)}. Apagado: 0 consultas`)}
        <div class="botones"><button class="btn sec" id="btn-corners-sw">Guardar interruptores</button></div>
      </div>
      <div class="titulo-seccion"><h2>¿Está funcionando?</h2></div>
      ${resumen ? `<div class="tarjeta tabla-wrap"><table><thead><tr><th>Mercado</th><th>Avisos</th><th>Acierto</th><th title="Solo las que tuvieron cuota">Con cuota</th><th>Ganancia</th></tr></thead><tbody>${resumen}</tbody></table></div>
        <p class="nota">La que manda es "Con cuota": acierto de las alertas que sí tenían cuota, contra la probabilidad implícita de esas cuotas (verde si la supera). Con menos de 30 resueltas todavía no se puede concluir nada.</p>`
        : `<div class="tarjeta vacio"><strong>Aún no hay avisos de córners</strong>Llegan cuando un partido va 0 córners entre el ${esc(P.corners_1t_min_desde)}' y el ${esc(P.corners_1t_min_hasta)}', o cuando el favorito va perdiendo entre el ${esc(P.corners_2t_min_desde)}' y el ${esc(P.corners_2t_min_hasta)}'.</div>`}
      <div class="titulo-seccion"><h2>Últimos avisos</h2></div>
      ${(r.alertas || []).slice(0, 40).map(fila).join("") || `<p class="nota">Sin avisos todavía.</p>`}
      <div class="titulo-seccion"><h2>Parámetros</h2></div>
      <div class="tarjeta">
        ${campo("corners_1t_min_desde", "1T desde el minuto", "Desde cuándo se revisa si va 0 córners")}
        ${campo("corners_1t_min_hasta", "1T hasta el minuto", "Ventana amplia para que ningún ciclo se la salte")}
        ${campo("corners_2t_min_desde", "2T desde el minuto", "Desde cuándo se revisa si el favorito pierde")}
        ${campo("corners_2t_min_hasta", "2T hasta el minuto", "")}
        ${campo("corners_objetivo", "Córners más que se buscan", "La línea es córners actuales + este número − 0,5")}
        ${campo("corners_api_max_dia", "Consultas de API por día", "Una por aviso, para leer la cuota")}
        <p class="nota">Cambiar minutos u objetivo abre una versión nueva (c1 → c2) para no mezclar resultados. El tope de consultas y los interruptores no cambian la versión.</p>
        <div class="botones"><button class="btn" id="btn-corners">Guardar</button></div>
      </div>`;
  },

  async amigos() {
    const r = await conPin((pin) => post("/admin/usuarios", { pin, accion: "listar" }));
    if (!r) return `<div class="tarjeta vacio"><strong>Necesitas ser administrador</strong>Abre tu enlace de administrador o escribe el PIN.</div>`;
    const base = location.origin + location.pathname;
    const linkDe = (t) => `${base}#entrar/${t}`;
    const wa = (u, t) => {
      const msg = `Hola ${u.nombre.split(" ")[0]}, te invito a ADN Soccer. Abre este enlace en tu celular (sirve una sola vez): ${linkDe(t)}`;
      const num = (u.telefono || "").replace(/\D/g, "");
      return `https://wa.me/${num}?text=${encodeURIComponent(msg)}`;
    };
    const mostrarEnlace = (u, t, dias) => {
      $("#enlace-nuevo").innerHTML = `<div class="tarjeta enlace">
          <b>Enlace de ${esc(u.nombre)}</b><small>Sirve una vez · vence en ${dias} días</small>
          <code>${esc(linkDe(t).replace(/^https?:\/\//, ""))}</code>
          <div class="dos"><a class="btn" href="${wa(u, t)}" target="_blank" rel="noopener">Enviar por WhatsApp</a><button class="btn sec" id="btn-copiar">Copiar</button></div>
          <p class="nota">Si lo abres tú en tu celular, ese celular queda como de ${esc(u.nombre)}.</p>
        </div>`;
      $("#btn-copiar").addEventListener("click", () => navigator.clipboard?.writeText(linkDe(t)).then(() => toast("Enlace copiado")));
      $("#enlace-nuevo").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    setTimeout(() => {
      $("#form-amigo")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const nombre = $("#a-nombre").value.trim(), telefono = $("#a-tel").value.trim();
        const x = await conPin((pin) => post("/admin/usuarios", { pin, accion: "crear", nombre, telefono }));
        if (x) { $("#form-amigo").reset(); await navegar(true); mostrarEnlace(x.usuario, x.token, x.dias); }
      });
      document.querySelectorAll("[data-enlace]").forEach((b) => b.addEventListener("click", async () => {
        const u = r.usuarios.find((z) => String(z.id) === b.dataset.enlace);
        if (!confirm(`¿Crear un enlace nuevo para ${u.nombre}? Su celular actual pierde el acceso hasta que abra el nuevo.`)) return;
        const x = await conPin((pin) => post("/admin/usuarios", { pin, accion: "enlace", id: u.id }));
        if (x) { await navegar(true); mostrarEnlace(u, x.token, x.dias); }
      }));
      document.querySelectorAll("[data-activo]").forEach((b) => b.addEventListener("click", async () => {
        const x = await conPin((pin) => post("/admin/usuarios", { pin, accion: "activo", id: Number(b.dataset.activo), activo: b.dataset.v === "1" }));
        if (x) navegar(true);
      }));
      $("#btn-modo")?.addEventListener("click", async (e) => {
        const modo = e.currentTarget.dataset.modo;
        if (modo === "cerrado" && !confirm("Desde ahora solo entra quien tenga su enlace. ¿Seguro?")) return;
        const x = await conPin((pin) => post("/admin/acceso", { pin, modo }));
        if (x) { MODO = x.modo_acceso; toast(modo === "cerrado" ? "Listo: solo con enlace" : "App abierta otra vez"); navegar(true); }
      });
    });
    const estado = (u) => !u.activo ? "Acceso apagado"
      : u.sesiones ? `Entró en ${u.entradas}${u.tardias ? ` (${u.tardias} marcadas después)` : ""} · yield ${pct(u.yield_pct == null ? null : Number(u.yield_pct))} · ${u.ultimo_acceso ? hace(u.ultimo_acceso) : "sin uso"}${u.avisos ? "" : " · sin avisos"}`
      : u.enlace_vence ? "Enlace enviado, todavía no entra" : "Sin enlace";
    const fila = (u) => `<div class="amigo ${u.activo ? "" : "apagado"}">
        <span class="inicial">${esc(u.nombre[0] || "?")}</span>
        <div class="hcuerpo"><b>${esc(u.nombre)}${u.rol === "admin" ? ` <span class="chip">admin</span>` : ""}</b>
          <small>${esc(u.telefono || "sin número")} · ${esc(estado(u))}</small></div>
        <div class="amigo-acc">
          <button class="btn-texto" data-enlace="${u.id}">${u.sesiones || u.enlace_vence ? "Enlace nuevo" : "Crear enlace"}</button>
          ${String(u.id) === String(YO?.id) ? "" : `<button class="btn-texto ${u.activo ? "neg" : ""}" data-activo="${u.id}" data-v="${u.activo ? 0 : 1}">${u.activo ? "Apagar" : "Encender"}</button>`}
        </div></div>`;
    const cerrado = r.modo_acceso === "cerrado";
    return `<div class="titulo-seccion"><h2>Invitar a alguien</h2></div>
      <form class="tarjeta" id="form-amigo">
        <label class="campo-vert">Nombre<input id="a-nombre" required maxlength="60" autocomplete="off" placeholder="Camila"></label>
        <label class="campo-vert">WhatsApp<input id="a-tel" inputmode="tel" placeholder="300 123 4567"></label>
        <button class="btn grande" type="submit">Crear enlace</button>
      </form>
      <div id="enlace-nuevo"></div>
      <div class="titulo-seccion"><h2>Con acceso</h2><small>${r.usuarios.length}</small></div>
      <div class="tarjeta lista-hist">${r.usuarios.map(fila).join("")}</div>
      <p class="nota">Si alguien cambia de celular, toca "Enlace nuevo" y mándaselo. El celular anterior pierde el acceso. Apagar a alguien le corta el acceso y los avisos al instante.</p>
      <div class="titulo-seccion"><h2>Quién puede entrar</h2></div>
      <div class="tarjeta">
        <p><b>${cerrado ? "Solo con enlace" : "Abierta (transición)"}</b></p>
        <p class="nota">${cerrado ? "Solo entra quien abrió su enlace personal. El PIN sigue sirviendo para Ajustes como respaldo."
          : "Cualquiera con la dirección ve la app, como antes. Cuando tu enlace de administrador funcione en tu celular, ciérrala."}</p>
        <div class="botones"><button class="btn ${cerrado ? "sec" : ""}" id="btn-modo" data-modo="${cerrado ? "abierto" : "cerrado"}">${cerrado ? "Volver a abrir" : "Cerrar: solo con enlace"}</button></div>
      </div>`;
  },
});

// ---------- arranque ----------
let enlazado = false;
async function arrancar(despuesDeEntrar = false) {
  const m = location.hash.match(/^#entrar\/([A-Za-z0-9_-]{20,100})/);
  if (m) {
    // El enlace llega también a quien ya tenía sesión (cambio de celular, enlace nuevo): se canjea igual
    return pantallaEntrar(m[1]);
  }
  try {
    const yo = await get("/yo");
    MODO = yo.modo_acceso; YO = yo.usuario;
    if (yo.sesion_invalida) { await borrarSesion(); if (!avisoInvalida) toast("Tu acceso ya no es válido. Pídele a Fredy un enlace nuevo."); }
  } catch (_) { /* sin red: se intenta con lo que haya */ }
  // Administrador con el PIN guardado en este celular: se liga solo a su usuario, sin enlace
  if (!YO && pinGuardado()) {
    try { const r = await post("/admin/vincular", { pin: pinGuardado() }); await usarSesion(r); }
    catch (e) { if (/PIN/i.test(e.message)) try { localStorage.removeItem("pin"); } catch (_) {} }
  }
  if (!YO && MODO === "cerrado") return pantallaEntrar(null);
  $(".barra").hidden = false;
  pintarMarco();
  if (YO && sesionGuardada()) idb("poner", sesionGuardada());   // por si el service worker no lo tiene
  if (YO && (despuesDeEntrar || !(() => { try { return localStorage.getItem("tutorialVisto"); } catch (_) { return "1"; } })())) await mostrarTutorial();
  if (!enlazado) {
    enlazado = true;
    addEventListener("hashchange", () => (/^#entrar\//.test(location.hash) ? arrancar() : navegar()));
    // Refresco automático solo en pantallas de lectura y con la app visible (no gasta batería en segundo plano)
    setInterval(() => {
      const tab = location.hash.replace("#", "") || "ahora";
      if (!document.hidden && ["ahora", "historial", "vivo", "radar", "alertas"].includes(tab) && !document.querySelector(".hoja-fondo, .tutorial")) navegar(true);
    }, REFRESCO_MS);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !document.querySelector(".hoja-fondo, .tutorial, .entrar")) navegar(true); });
  }
  navegar();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
mostrarInicio().then(() => arrancar());
