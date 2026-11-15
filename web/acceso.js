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
  const fila = (p) => `<div class="vfila ${p.c ? "cumple" : ""}">
      <span class="vmin num">${p.e === "HT" ? "Desc." : p.m != null ? `${p.m}'` : esc(ESTADOS[p.e] || p.e)}</span>
      <span class="vequipos"><span>${esc(p.l)}${p.fav === "home" ? " <i class=\"vfav\">★</i>" : ""}</span><span>${esc(p.v)}${p.fav === "away" ? " <i class=\"vfav\">★</i>" : ""}</span></span>
      <b class="vgoles num">${p.gl}<br>${p.gv}</b>
      ${p.c ? `<span class="vcumple">Candidato</span>` : ""}
    </div>`;
  return `<div class="titulo-seccion"><h2>En vivo</h2><small>${vivos.length} partidos${cumplen ? ` · ${cumplen} candidato${cumplen === 1 ? "" : "s"}` : ""} · ${w.ts ? hace(w.ts) : ""}</small></div>
    <div class="tarjeta lista-vivo">${vivos.map(fila).join("")}</div>
    <p class="nota explica">★ = favorito. "Candidato" = el favorito va perdiendo y lo estamos midiendo, pero todavía no cumple todo. No es señal para entrar: solo cuenta cuando llega la alerta.</p>`;
}

// ---------- pantallas nuevas ----------
Object.assign(pantallas, {
  async ahora() {
    const [lista, push, w] = await Promise.all([get("/alertas"), estadoPush(), get("/widget").catch(() => null)]);
    const abiertas = lista.filter((a) => a.resultado === "pendiente");
    const hoyStr = new Date().toDateString();
    const m = metricas(lista.filter((a) => new Date(a.ts).toDateString() === hoyStr));
    setTimeout(() => { enlazarBotones(abiertas); $("#btn-push")?.addEventListener("click", activarPush); });
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
      $("#btn-tutorial")?.addEventListener("click", () => mostrarTutorial());
      $("#btn-push")?.addEventListener("click", activarPush);
    });
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
      ${item("candidatos", "Candidatos", "Los que no llegaron a alerta y su desenlace")}
      ${item("alertas", "Alertas técnicas", "Cada alerta con sus números")}
      ${item("rendimiento", "Rendimiento técnico", "Acierto vs implícita, por regla y por liga")}
      ${item("ligas", "Ligas", "Encender y apagar ligas")}
      ${item("ajustes", "Ajustes del algoritmo", "Umbrales, horario, presupuesto de API, notificaciones")}
      ${item("corners", "Córners (laboratorio)", "Avisos de córners solo para ti y su acierto vs cuota")}`;
  },

  // ---------- Córners (lab, DECISIONES 37): solo administrador ----------
  async corners() {
    const r = await conPin((pin) => post("/admin/corners", { pin }));
    if (!r) return `<div class="tarjeta vacio"><strong>Necesitas ser administrador</strong>Abre tu enlace de administrador o escribe el PIN.</div>`;
    const P = r.params || {};
    const NOMBRE = { c1t_cero20: "1T · 0 córners al 20'", c2t_fav77: "2T · favorito perdiendo al 77'" };
    const RES = { acierto: "✅ Salió", fallo: "❌ No salió", pendiente: "⏳ En juego", anulada: "Anulada" };
    const SIN = { sin_pareja_api: "sin pareja en API", tope_diario: "tope diario de consultas", sin_presupuesto_api: "sin cupo de API",
      sin_mercado: "la API no ofrecía córners", sin_mercado_de_ese_tiempo: "solo córners de otro tiempo", sin_esa_linea: "no estaba esa línea", error_api: "error de la API" };
    const pct = (a, b) => b ? `${Math.round(a / b * 100)}%` : "–";
    setTimeout(() => {
      $("#btn-corners")?.addEventListener("click", async () => {
        const cambios = {};
        document.querySelectorAll("[data-ck]").forEach((i) => {
          const v = i.type === "checkbox" ? i.checked : Number(i.value);
          if (JSON.stringify(v) !== JSON.stringify(P[i.dataset.ck])) cambios[i.dataset.ck] = v;
        });
        if (!Object.keys(cambios).length) return toast("No hay cambios");
        const g = await conPin((pin) => post("/admin/config", { pin, cambios }));
        if (g) { toast(g.version_corners ? `Guardado: ahora es la versión ${g.version_corners}` : "Guardado"); navegar(); }
      });
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
    return `<div class="tarjeta">
        <div class="campo"><label for="ck-corners_activo"><b>Córners (laboratorio)</b><small>Versión ${esc(P.corners_version || "c1")} · solo tú recibes estos avisos · consultas de API hoy ${r.consultas_hoy}/${esc(P.corners_api_max_dia)}</small></label>
          <label class="sw"><input id="ck-corners_activo" type="checkbox" data-ck="corners_activo" ${P.corners_activo ? "checked" : ""}><span></span></label></div>
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
        <p class="nota">Cambiar minutos u objetivo abre una versión nueva (c1 → c2) para no mezclar resultados. El tope de consultas y el interruptor no cambian la versión.</p>
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
