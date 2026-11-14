// =====================================================================
// ADN Soccer · marca: el logo (SVG) y la animación de inicio.
//
// La animación recrea en SVG + CSS la secuencia de 9 cuadros que hizo Fredy:
//  1. partículas verdes que se juntan · 2. forman la hélice de ADN · 3-4. aparecen los escalones
//  5. llega el balón desde el fondo con rayos · 6. choca y estalla en el centro
//  7-8. la hélice se vuelve dos cintas que abrazan el balón · 9. "ADN Soccer"
// Pesa unos pocos KB (un video o GIF pesaría megas), se ve nítida en cualquier pantalla, se salta con
// un toque y, si el celular tiene "reducir movimiento", muestra directo el último cuadro.
// =====================================================================

// Balón: hexágono-pentágono simplificado (blanco con parches negros), recortado al círculo.
function balonSVG(cx, cy, r, id) {
  const p = (x, y, s, rot = 0) => {
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const a = (rot - 90 + i * 72) * Math.PI / 180;
      pts.push(`${(x + s * Math.cos(a)).toFixed(1)},${(y + s * Math.sin(a)).toFixed(1)}`);
    }
    return `<polygon points="${pts.join(" ")}"/>`;
  };
  const anillo = [0, 1, 2, 3, 4].map((i) => {
    const a = (-90 + i * 72) * Math.PI / 180;
    return p(cx + r * 0.95 * Math.cos(a), cy + r * 0.95 * Math.sin(a), r * 0.36, 36);
  }).join("");
  return `<defs><clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>
      <radialGradient id="${id}g" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#e4ebe6"/><stop offset="1" stop-color="#9fb0a6"/></radialGradient></defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}g)"/>
    <g clip-path="url(#${id})" fill="#101614" stroke="#101614" stroke-width="${(r * 0.05).toFixed(2)}" stroke-linejoin="round">
      ${p(cx, cy, r * 0.36)}${anillo}
      ${[0, 1, 2, 3, 4].map((i) => {
        const a = (-90 + i * 72) * Math.PI / 180, b = r * 0.36, c = r * 0.62;
        return `<line x1="${(cx + b * Math.cos(a)).toFixed(1)}" y1="${(cy + b * Math.sin(a)).toFixed(1)}" x2="${(cx + c * Math.cos(a)).toFixed(1)}" y2="${(cy + c * Math.sin(a)).toFixed(1)}"/>`;
      }).join("")}
    </g>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="${(r * 0.04).toFixed(2)}"/>`;
}

// Las dos cintas del logo final (cuadro 9), en un lienzo de 200 × 300 con el balón en (100, 150).
const CINTA_A = "M140,36 C160,86 62,96 60,150 C58,188 90,194 110,176";
const CINTA_B = "M60,264 C40,214 138,204 140,150 C142,112 110,106 90,124";

// Logo para el encabezado y la pantalla de entrada (cintas + balón). `tam` en px.
function logoSVG(tam = 32, titulo = "ADN Soccer") {
  const id = "lg" + Math.random().toString(36).slice(2, 7);
  return `<svg class="logo" width="${tam}" height="${tam * 1.2}" viewBox="40 30 120 240" role="img" aria-label="${titulo}">
    <g fill="none" stroke-linecap="round">
      <path d="${CINTA_A}" stroke="#3ddc84" stroke-width="15"/>
      <path d="${CINTA_B}" stroke="#2fbf6f" stroke-width="15"/>
    </g>
    ${balonSVG(100, 150, 27, id)}
  </svg>`;
}

// ---------- Animación de inicio ----------
function helice(fase, A = 34, y0 = 34, y1 = 266, periodo = 150) {
  const pts = [];
  for (let y = y0; y <= y1; y += 4) pts.push([100 + A * Math.sin(2 * Math.PI * (y - y0) / periodo + fase), y]);
  return pts;
}
const ruta = (pts) => "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y}`).join(" L");

function htmlInicio() {
  const a = helice(0), b = helice(Math.PI);
  // Escalones: donde las dos hebras están separadas (no en los cruces)
  const escalones = a.map(([xa, y], i) => [xa, b[i][0], y])
    .filter(([xa, xb, y], i) => i % 3 === 1 && Math.abs(xa - xb) > 26)
    .map(([xa, xb, y], i) => `<line x1="${xa.toFixed(1)}" y1="${y}" x2="${xb.toFixed(1)}" y2="${y}" style="--d:${(i * 0.03).toFixed(2)}s"/>`).join("");
  // Partículas: salen de puntos al azar y llegan a su lugar en la hélice
  const destinos = [...a.filter((_, i) => i % 3 === 0), ...b.filter((_, i) => i % 3 === 0)];
  const particulas = destinos.map(([x, y], i) => {
    const dx = (Math.random() - 0.5) * 220, dy = (Math.random() - 0.5) * 260;
    return `<circle cx="${x.toFixed(1)}" cy="${y}" r="${(1.6 + Math.random() * 1.8).toFixed(1)}" style="--dx:${dx.toFixed(0)}px;--dy:${dy.toFixed(0)}px;--d:${(Math.random() * 0.35).toFixed(2)}s"/>`;
  }).join("");
  const rayos = Array.from({ length: 14 }, (_, i) => {
    const ang = i * (360 / 14) + (i % 2 ? 9 : 0), largo = 26 + (i % 3) * 16;
    return `<line x1="0" y1="34" x2="0" y2="${34 + largo}" transform="rotate(${ang})"/>`;
  }).join("");
  const astillas = Array.from({ length: 18 }, (_, i) => {
    const ang = i * 20 + Math.random() * 12, r0 = 30;
    return `<line x1="0" y1="${r0}" x2="0" y2="${r0 + 10 + Math.random() * 12}" transform="rotate(${ang.toFixed(0)})" style="--d:${(Math.random() * 0.12).toFixed(2)}s"/>`;
  }).join("");
  return `<div id="inicio" class="inicio" role="img" aria-label="ADN Soccer">
    <svg class="inicio-svg" viewBox="0 0 200 300" aria-hidden="true">
      <defs>
        <filter id="brillo" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        <radialGradient id="piso"><stop offset="0" stop-color="#3ddc84" stop-opacity=".55"/><stop offset="1" stop-color="#3ddc84" stop-opacity="0"/></radialGradient>
      </defs>
      <ellipse class="i-piso" cx="100" cy="292" rx="60" ry="5" fill="url(#piso)"/>
      <g class="i-todo">
        <g transform="rotate(14 100 150)" filter="url(#brillo)">
          <g class="i-particulas" fill="#7dff9e">${particulas}</g>
          <g class="i-helice">
            <g class="i-escalones" stroke="#3ddc84" stroke-width="2.4" stroke-linecap="round" opacity=".85">${escalones}</g>
            <path class="i-hebra" d="${ruta(a)}" stroke="#3ddc84" stroke-width="5.5"/>
            <path class="i-hebra" d="${ruta(b)}" stroke="#2fbf6f" stroke-width="5.5"/>
            <path class="i-cuentas" d="${ruta(a)}"/><path class="i-cuentas" d="${ruta(b)}"/>
          </g>
        </g>
        <g transform="translate(100 150)">
          <g class="i-rayos" stroke="#9dffb9" stroke-opacity=".75" stroke-width="4" stroke-linecap="round">${rayos}</g>
          <circle class="i-onda" r="30" fill="none" stroke="#b6ffc9" stroke-width="3"/>
          <g class="i-astillas" stroke="#b6ffc9" stroke-width="2.6" stroke-linecap="round">${astillas}</g>
        </g>
        <g class="i-cintas" fill="none" stroke-linecap="round" filter="url(#brillo)">
          <path d="${CINTA_A}" stroke="#3ddc84" stroke-width="13" pathLength="1"/>
          <path d="${CINTA_B}" stroke="#2fbf6f" stroke-width="13" pathLength="1"/>
        </g>
        <g class="i-balon">${balonSVG(100, 150, 27, "ib")}</g>
      </g>
    </svg>
    <div class="i-nombre"><span>ADN</span> <b>Soccer</b></div>
    <p class="i-lema">Esto no es apostar, es trading basado en estadísticas.</p>
    <button type="button" class="i-saltar">Saltar</button>
  </div>`;
}

// Se muestra una vez por apertura de la app (no en cada cambio de pestaña). Devuelve una promesa
// que se resuelve al terminar o al tocar la pantalla.
function mostrarInicio() {
  try { if (sessionStorage.getItem("inicioVisto")) return Promise.resolve(); sessionStorage.setItem("inicioVisto", "1"); } catch (_) {}
  const quieto = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.body.insertAdjacentHTML("beforeend", htmlInicio());
  const el = document.getElementById("inicio");
  if (quieto) el.classList.add("quieto");
  return new Promise((listo) => {
    let hecho = false;
    const cerrar = () => {
      if (hecho) return; hecho = true;
      el.classList.add("salir");
      setTimeout(() => { el.remove(); listo(); }, 380);
    };
    el.addEventListener("click", cerrar);
    setTimeout(cerrar, quieto ? 1400 : 4300);
  });
}
