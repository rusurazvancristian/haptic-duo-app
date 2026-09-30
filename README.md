# Haptic Duo — aplicație de control (Web Bluetooth)

Panou de control pentru cele două butoane haptice, direct din browser, prin Bluetooth Low Energy
(serviciu Nordic UART). Nu are pas de build: fișiere statice, `index.html` la rădăcină, căi relative,
fără secrete — se poate publica ca atare pe GitHub Pages (adresa trebuie să fie **HTTPS**).

## Cum se deschide

- **Android sau PC (Windows/macOS/Linux):** deschide adresa site-ului în **Chrome** sau **Edge**.
- **iPhone/iPad:** Safari **nu** are Web Bluetooth. Instalează browserul gratuit **Bluefy** din App Store
  și deschide adresa în el.
- Opțional: „Instalează aplicația” / „Adaugă pe ecranul principal” (PWA; shell-ul funcționează și offline,
  dar Bluetooth-ul cere dispozitivul aproape).

## Prima conectare și PIN

1. Alimentează placa și apasă **Conectează**, apoi alege **Haptic Duo**.
2. Sistemul de operare cere **PIN-ul de asociere**: cele 6 cifre din `firmware/haptic_duo/ble_passkey.h`
   (`ble_passkey.h` nu se publică în git; șablonul este `ble_passkey.example.h`). Asocierea se reține.
3. Dacă nu apare nicio cerere sau conectarea eșuează, șterge „Haptic Duo” din lista Bluetooth a
   telefonului/PC-ului și încearcă din nou.

## Ce poți face

- **Stare live:** insignă (dezarmat / aliniere / armat / eroare), două cadrane cu unghiul real
  (telemetrie `stream 20`), sănătatea senzorilor, profilul activ și bateria (tensiune și procent din `status`,
  reîmprospătate la ~15 s; avertisment sub 3,5 V, „nedetectată” când nu e montată celula). Doar raportare:
  aplicația și firmware-ul nu opresc nimic la baterie slabă, protecția la subtensiune este BMS-ul celulei.
- **DISARM** este mereu vizibil, jos. **Armează** cere confirmare (butoane libere, sursă limitată în curent,
  mâini departe). În eroare apare „disarm clear”; eroarea blocată se citește din `status`.
- **Configurare motoare** (doar dezarmat): perechi de poli (întreg 1–100, **fără valoare implicită**) și
  limită de tensiune (0,001–0,6 V). Ultimele valori introduse se rețin în browser; se trimit doar la cerere.
- **Mod per buton:** detente / arc / limitat, cu glisoare în intervalele protocolului. Când e armat,
  modificările se trimit live (~150 ms); firmware-ul recentrează originea, deci nu apar salturi.
- **Legături USB HID:** acțiune (volum, scroll, scroll orizontal, săgeți, zoom) și pas în grade.
- **Profile:** listare, încărcare, ștergere, „salvează curent” (nume 1–24 caractere `A-Za-z0-9._-`, max. 8).
  Helperul de pe PC alege profilul după numele executabilului din prim-plan (de ex. `chrome.exe`),
  iar `default` este profilul de rezervă.
- **Consolă brută** (pliabilă) pentru orice comandă din `firmware/PROTOCOL.md`.

## Siguranță

Deconectarea Bluetooth **nu** dezarmează placa: dacă era armată, rămâne armată. Folosește DISARM înainte
de a închide pagina. Limita de tensiune nu este o garanție termică sau de siguranță la atingere;
respectă regulile din `README.md` și `firmware/PROTOCOL.md` ale proiectului.

## Rulare locală

```text
cd haptic-duo/app
python -m http.server 8000
```

Apoi `http://localhost:8000` (localhost este context sigur, deci Web Bluetooth funcționează în Chrome/Edge).
