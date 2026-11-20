#!/usr/bin/env python3
# =====================================================================
# Cuotas de córners de BetPlay y Rushbet → base de ADN Soccer (DECISIONES 53).
#
# Por qué corre en tu PC: BetPlay y Rushbet usan la plataforma Kambi. Su feed público de cuotas
# responde "No access" (429) a los servidores como Supabase, pero sí se ve desde una IP colombiana
# normal. Este script lo lee desde tu PC y sube SOLO los mercados de córners a la API de la app.
#
# Qué hace en cada vuelta (cada --cada minutos, 3 por defecto):
#   1. Lista de partidos en vivo de cada casa (1 pedido por casa).
#   2. Para los partidos donde importa (1T desde el 10', 2T desde el 60'), pide sus cuotas
#      (1 pedido por partido, máximo --max por casa) y se queda con los mercados que dicen "corner".
#   3. Lo sube con tu PIN a POST /admin/corners-casa. El servidor lo empareja con Flashscore y
#      guarda cuántos córners llevaba el partido en ese momento.
#
# Solo usa la biblioteca estándar de Python (no hay que instalar nada más). Uso:
#   python kambi_corners.py --probar      # una vuelta, muestra lo que encuentra y NO sube nada
#   python kambi_corners.py               # corre hasta que lo cierres (Ctrl+C)
# El PIN se pide al arrancar (o variable de entorno ADN_PIN). No se guarda en ningún archivo.
# =====================================================================
import argparse
import getpass
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

API_APP = "https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/api/admin/corners-casa"
KAMBI = "https://eu-offering-api.kambicdn.com/offering/v2018/{codigo}"
PARAMS = "lang=en_GB&market=CO&client_id=2&channel_id=1"
# Código de cada casa en Kambi. Si --probar dice que no responde, se puede cambiar con --betplay / --rushbet
# (ver LEEME.md: cómo encontrar el código en el navegador).
CODIGOS = {"betplay": "betplay", "rushbet": "rsico"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def pedir(url, cuerpo=None, timeout=20):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(url, data=datos, method="POST" if datos else "GET",
                                 headers={"User-Agent": UA, "Accept": "application/json",
                                          **({"Content-Type": "application/json"} if datos else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def en_vivo(codigo):
    """Partidos de fútbol en vivo de una casa: [{evento, liveData}]."""
    url = f"{KAMBI.format(codigo=codigo)}/listView/football/all/all/all/in-play.json?{PARAMS}&useCombined=true"
    return pedir(url).get("events", [])


def minuto_y_periodo(live):
    reloj = (live or {}).get("matchClock") or {}
    return reloj.get("minute"), str(reloj.get("period") or "")


def importa(minuto, periodo):
    if minuto is None:
        return False
    p = periodo.lower()
    if "1st" in p or "first" in p:
        return minuto >= 10
    if "2nd" in p or "second" in p:
        return minuto >= 60
    return False


def mercados_corners(codigo, evento_id):
    """Mercados de córners de un partido: [{nombre, lineas: [{lado, linea, cuota}]}]."""
    url = f"{KAMBI.format(codigo=codigo)}/betoffer/event/{evento_id}.json?{PARAMS}&includeParticipants=true"
    out = []
    for bo in pedir(url).get("betOffers", []):
        crit = bo.get("criterion") or {}
        nombre = crit.get("englishLabel") or crit.get("label") or ""
        if "corner" not in nombre.lower():
            continue
        lineas = []
        for o in bo.get("outcomes", []):
            if o.get("status") not in (None, "OPEN") or o.get("odds") is None:
                continue
            lineas.append({
                "lado": o.get("englishLabel") or o.get("label"),
                "linea": o["line"] / 1000 if o.get("line") is not None else None,   # Kambi da la línea × 1000
                "cuota": o["odds"] / 1000,                                          # y la cuota × 1000
            })
        if lineas:
            out.append({"nombre": nombre, "lineas": lineas})
    return out


def vuelta(casa, codigo, maximo):
    eventos = en_vivo(codigo)
    filas = []
    for e in eventos:
        ev, live = e.get("event") or {}, e.get("liveData") or {}
        minuto, periodo = minuto_y_periodo(live)
        if not importa(minuto, periodo):
            continue
        if len(filas) >= maximo:
            break
        try:
            mercados = mercados_corners(codigo, ev.get("id"))
        except Exception as ex:   # un partido que falla no tumba la vuelta
            log(f"{casa}: cuotas de {ev.get('name')}: {ex}")
            continue
        if not mercados:
            continue
        marcador = live.get("score") or {}
        filas.append({
            "evento_id": str(ev.get("id")),
            "local": ev.get("homeName"), "visitante": ev.get("awayName"),
            "liga": " / ".join(p.get("englishName", "") for p in ev.get("path", [])) or ev.get("group"),
            "inicio": ev.get("start"), "periodo": periodo, "minuto": minuto,
            "goles_local": marcador.get("home"), "goles_visitante": marcador.get("away"),
            "mercados": mercados,
        })
        time.sleep(0.4)   # sin afán: un pedido a la vez
    return len(eventos), filas


def main():
    ap = argparse.ArgumentParser(description="Cuotas de córners de BetPlay y Rushbet → ADN Soccer")
    ap.add_argument("--probar", action="store_true", help="una vuelta, muestra lo encontrado y no sube nada")
    ap.add_argument("--cada", type=float, default=3, help="minutos entre vueltas (mínimo 2)")
    ap.add_argument("--max", type=int, default=25, help="máximo de partidos por casa en cada vuelta")
    ap.add_argument("--betplay", default=CODIGOS["betplay"], help="código de BetPlay en Kambi ('' para no leerla)")
    ap.add_argument("--rushbet", default=CODIGOS["rushbet"], help="código de Rushbet en Kambi ('' para no leerla)")
    a = ap.parse_args()
    casas = {k: v for k, v in {"betplay": a.betplay, "rushbet": a.rushbet}.items() if v}

    pin = None
    if not a.probar:
        pin = os.environ.get("ADN_PIN") or getpass.getpass("PIN de administrador de ADN Soccer: ")

    while True:
        for casa, codigo in casas.items():
            try:
                total, filas = vuelta(casa, codigo, a.max)
            except urllib.error.HTTPError as ex:
                log(f"{casa} ({codigo}): Kambi respondió {ex.code}. ¿Código correcto? Ver LEEME.md")
                continue
            except Exception as ex:
                log(f"{casa} ({codigo}): {ex}")
                continue
            con1t = sum(1 for f in filas if any("1st half" in m["nombre"].lower() for m in f["mercados"]))
            log(f"{casa}: {total} en vivo, {len(filas)} con córners en la franja útil, {con1t} con córners del 1T")
            if a.probar:
                for f in filas[:5]:
                    print(f"   {f['local']} {f['goles_local']}-{f['goles_visitante']} {f['visitante']} · {f['minuto']}' {f['periodo']}")
                    for m in f["mercados"][:6]:
                        lin = ", ".join(f"{l['lado']} {l['linea']}={l['cuota']}" for l in m["lineas"][:6])
                        print(f"      {m['nombre']}: {lin}")
                continue
            if not filas:
                continue
            try:
                r = pedir(API_APP, {"pin": pin, "casa": casa, "filas": filas}, timeout=60)
                log(f"{casa}: subidas {r.get('guardadas')} (emparejadas {r.get('emparejadas')}, con 1T {r.get('con_1t')})")
            except urllib.error.HTTPError as ex:
                cuerpo = ex.read().decode("utf-8", "replace")[:200]
                log(f"{casa}: la app respondió {ex.code}: {cuerpo}")
                if ex.code == 401:
                    sys.exit("PIN incorrecto o bloqueado. Revisa el PIN y vuelve a abrir el script.")
            except Exception as ex:
                log(f"{casa}: no se pudo subir: {ex}")
        if a.probar:
            return
        time.sleep(max(2.0, a.cada) * 60)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nListo, cerrado.")
