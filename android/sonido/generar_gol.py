"""Genera el sonido de las alertas de ADN Soccer: un "¡GOOOOL!" sobre el rugido de un estadio.

Todo sale de matemática, sin grabaciones de terceros: por eso el sonido es nuestro y se publica
como CC0 (dominio público). Si quieres cambiarlo por tu propia voz, reemplaza
android/app/src/main/res/raw/gol.ogg por otro .ogg (mono, 2 a 3 s) y sube el número del canal
en AlertasGol.java (ver README).

Cómo se arma, pieza por pieza (síntesis por formantes, la misma idea de los primeros sintetizadores de voz):
  1. Fuente glotal: un tren de pulsos a la frecuencia de la voz (f0). Gritar = f0 alta (~260-340 Hz).
  2. Tracto vocal: filtros resonantes (formantes F1..F4). Las frecuencias de los formantes deciden la vocal:
     "o" ≈ 550/850/2600 Hz, "l" ≈ 380/1150/2700 Hz. Moverlas en el tiempo hace la palabra.
  3. "G": un golpe corto de ruido grave antes de la vocal.
  4. Coro: varias voces con f0 y arranque distintos, para que suene a hinchada y no a robot.
  5. Estadio: ruido rosa filtrado que sube como una ola.

Uso:  python3 generar_gol.py salida.wav   (luego ffmpeg lo pasa a .ogg, ver README)
"""
import sys
import numpy as np
from scipy.signal import lfilter, butter

SR = 44100
DUR = 2.8
rng = np.random.default_rng(2026)  # semilla fija: el mismo archivo cada vez
t = np.arange(int(SR * DUR)) / SR


def resonador(x, f, bw):
    """Filtro resonante de 2.º orden con frecuencia f (Hz, puede variar en el tiempo) y ancho bw."""
    f = np.broadcast_to(f, x.shape)
    y = np.zeros_like(x)
    y1 = y2 = 0.0
    r = np.exp(-np.pi * bw / SR)
    for i in range(len(x)):
        c = 2 * r * np.cos(2 * np.pi * f[i] / SR)
        y0 = (1 - r) * x[i] + c * y1 - r * r * y2
        y[i] = y0
        y2, y1 = y1, y0
    return y


def curva(puntos):
    """Interpola una curva (tiempo, valor) sobre todo el eje de tiempo."""
    ts, vs = zip(*puntos)
    return np.interp(t, ts, vs)


def voz(f0_base, inicio, fin, gan, vibrato=5.5):
    # f0 del grito: arranca, sube con la emoción y cae al final
    f0 = f0_base * curva([(0, 0.9), (inicio, 0.9), (inicio + 0.25, 1.15), (fin - 0.5, 1.22), (fin, 1.0), (DUR, 1.0)])
    f0 = f0 * (1 + 0.025 * np.sin(2 * np.pi * vibrato * t + rng.uniform(0, 6)))
    f0 = f0 * (1 + 0.01 * lfilter([1], [1, -0.999], rng.normal(0, 0.02, len(t))))  # temblor natural
    fase = np.cumsum(f0 / SR)
    # pulso glotal: diente de sierra suavizado (rico en armónicos, como las cuerdas vocales)
    src = 2 * (fase % 1) - 1
    src = lfilter([1, -0.97], [1], src)  # pre-énfasis: más brillo, voz gritada
    src += 0.04 * rng.normal(0, 1, len(t))  # aire del grito

    # formantes: "o" larga y cierre en "l"
    cierre = fin - 0.3
    F1 = curva([(0, 300), (inicio, 300), (inicio + 0.06, 570), (cierre, 570), (fin, 380), (DUR, 380)])
    F2 = curva([(0, 800), (inicio, 800), (inicio + 0.06, 860), (cierre, 860), (fin, 1150), (DUR, 1150)])
    F3 = curva([(0, 2400), (cierre, 2600), (fin, 2700), (DUR, 2700)])
    y = (resonador(src, F1, 90) * 1.0 + resonador(src, F2, 110) * 0.7
         + resonador(src, F3, 160) * 0.25 + resonador(src, 3500, 250) * 0.12)

    env = curva([(0, 0), (inicio, 0), (inicio + 0.04, 1), (fin - 0.35, 1), (fin, 0), (DUR, 0)])
    out = y * env

    # "G": golpe de ruido grave justo antes de la vocal
    g = np.zeros_like(t)
    a, b = int((inicio - 0.03) * SR), int((inicio + 0.01) * SR)
    g[a:b] = rng.normal(0, 1, b - a) * np.hanning(b - a)
    bb, aa = butter(2, [400 / (SR / 2), 1800 / (SR / 2)], "band")
    out += lfilter(bb, aa, g) * 0.6 * np.max(np.abs(y))
    return gan * out / (np.max(np.abs(out)) + 1e-9)


# Voz principal + coro de hinchada
mezcla = voz(270, 0.10, 2.45, 1.0)
for _ in range(6):
    mezcla += voz(rng.uniform(190, 360), 0.10 + rng.uniform(0.0, 0.12), 2.45 + rng.uniform(-0.2, 0.15),
                  rng.uniform(0.25, 0.4), vibrato=rng.uniform(4.5, 6.5))

# Estadio: ruido rosa (1/f) en banda de voces, subiendo como una ola
blanco = rng.normal(0, 1, len(t))
rosa = lfilter([0.049922, -0.095993, 0.050613, -0.004408], [1, -2.494956, 2.017265, -0.522189], blanco)
bb, aa = butter(2, [250 / (SR / 2), 3500 / (SR / 2)], "band")
estadio = lfilter(bb, aa, rosa)
estadio /= np.max(np.abs(estadio))
estadio *= curva([(0, 0.15), (0.15, 0.55), (1.2, 0.7), (2.3, 0.6), (DUR, 0)])
mezcla = mezcla / np.max(np.abs(mezcla)) + 0.3 * estadio

# Final suave y normalizado a -1 dBFS
mezcla *= curva([(0, 0), (0.01, 1), (DUR - 0.25, 1), (DUR, 0)])
mezcla = np.tanh(1.6 * mezcla)  # saturación leve: suena más fuerte sin recortar
mezcla *= 0.89 / np.max(np.abs(mezcla))

pcm = (mezcla * 32767).astype("<i2")
import wave
with wave.open(sys.argv[1] if len(sys.argv) > 1 else "gol.wav", "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("listo")
