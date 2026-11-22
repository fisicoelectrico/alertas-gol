"""
Baja los respaldos diarios del detalle de mercados de BetPlay/Rushbet (DECISIONES 77) y los carga en pandas.

Los archivos viven en Supabase Storage (espacio privado futbol-respaldo):
    cuotas_casa/AAAA/MM/AAAA-MM-DD.jsonl.gz     una fila de futbol.cuotas_casa por línea, todas las columnas

Uso (en el PC):
    set ADN_TOKEN=...            (el token_forzar de futbol.config; en Linux/Mac: export ADN_TOKEN=...)
    python respaldo_mercados.py              -> baja los que falten a ./respaldos/ y muestra un resumen
    python respaldo_mercados.py 2026-11-21   -> solo ese día

Luego, para analizar:
    import pandas as pd
    df = pd.read_json("respaldos/2026-11-21.jsonl.gz", lines=True, compression="gzip")
    # df.mercados es una lista de {nombre, lineas: [{lado, linea, cuota}]} por lectura
"""
import os, sys, json, urllib.request, pathlib

FUNCION = "https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/respaldo"

def main():
    token = os.environ.get("ADN_TOKEN")
    if not token:
        sys.exit("Falta la variable ADN_TOKEN (token_forzar de futbol.config).")
    req = urllib.request.Request(FUNCION + "?lista=1", headers={"x-token": token})
    lista = json.load(urllib.request.urlopen(req, timeout=60))
    solo = sys.argv[1] if len(sys.argv) > 1 else None
    carpeta = pathlib.Path("respaldos"); carpeta.mkdir(exist_ok=True)
    for r in lista:
        if solo and r["dia"] != solo:
            continue
        destino = carpeta / f"{r['dia']}.jsonl.gz"
        if destino.exists() and destino.stat().st_size == r["bytes"]:
            print(f"{r['dia']}: ya está ({r['filas']} filas)"); continue
        if not r.get("url"):
            print(f"{r['dia']}: sin enlace de descarga"); continue
        urllib.request.urlretrieve(r["url"], destino)
        print(f"{r['dia']}: {r['filas']} filas, {r['bytes'] / 1e6:.1f} MB -> {destino}")

if __name__ == "__main__":
    main()
