# IMS Station-Tool — Projektbeschreibung & UX-Design-Regeln

**Stand:** April 2026
**Scope:** `station.html` (Tablet-Ansicht pro Arbeitsplatz) + `shared.js` (Daten-Layer)
**Ziel:** Produktionsmitarbeiter (MA) können an Tablets Aufträge abarbeiten, Timer erfassen, Stationen fertig melden — schnell, fehlerarm, ohne Training.

---

## 1. Zielgruppe & Kontext

Die UI wird von **11 Produktionsmitarbeitern** genutzt, an **Tablets in der Halle**:
- Wechselndes Licht (Sonne, Halogenleuchten, Schatten)
- Handschuhe, teils verschmutzte Finger
- Ablenkung durch Maschinenlärm, Zeitdruck
- Blickabstand 30–80 cm, teils im Vorbeigehen 2 m
- Keine Maus, keine Tastatur (außer für Login)
- Keine formale Software-Schulung — Bedienung muss selbsterklärend sein

Diese Rahmenbedingungen bestimmen **jede** Designentscheidung.

---

## 2. UX-Grundsätze (Meta-Regeln)

### 2.1 Light Mode ist verbindlich
Dunkler Hintergrund existiert nicht und wird nicht gebaut. Produktions-Tablets stehen in hellen Hallen, dunkle UIs spiegeln und ermüden.
→ `--bg: #f5f7fa`, dunkler Text, IMS-Akzentgrün.

### 2.2 Eine Aktion = eine Bedeutung
Jede Farbe, jedes Symbol, jeder Button kodiert **genau eine** Information. Doppelbelegungen (z.B. rot = HighPrio + rot = Alarm) werden aktiv vermieden.

### 2.3 Scan-Freundlichkeit vor Informationsdichte
Der MA liest keine Karten — er **scannt** sie. Typografische Hierarchie (groß = primär, klein = sekundär) entscheidet über Verständlichkeit in < 2 Sekunden.

### 2.4 Direkte Aktion, Undo statt Confirm
Confirm-Dialoge verlangsamen trainierte Nutzer. Bevorzugt: **Aktion sofort ausführen + Rückgängig-Option** sichtbar danach.

### 2.5 Redundanz ist ok bei Sicherheitsrelevanz
Nielsen-Heuristik: Doppelkodierung (Farbe + Text) ist bei destruktiven/irreversiblen Aktionen gewollt.

### 2.6 Datenintegrität vor UI-Eleganz
Wenn Aktion A Aktion B zwingend auslösen muss (z.B. Timer-Stopp bei Fertig), passiert das **automatisch im Backend** — nicht per User-Reminder.

---

## 3. Farbsystem

| Farbe | Bedeutung | Einsatzorte |
|---|---|---|
| 🔴 **Rot** (`#d63040`) | Problem, Fehler, überfällig | Datum-Chip „5 Tage über", Überfällig-Group-Header |
| 🟠 **Amber** (`#d98200`) | Warnung, Blockierung | Block-Toggle, Vorgänger-Warn, „soon-prio" Stripe |
| 🟢 **Grün** (`#00a87a`) | Läuft, heute, OK | Running-Hintergrund, today-Group-Header, Sync-OK, Start-Button |
| 🟣 **Violett** (`#7c3aed`) | HighPrio (ohne Alarm) | HighPrio-Badge, HighPrio-Card-Rand, HighPrio-Prio-Pill |
| 🔷 **Teal** (`#0e7490` / `#164e63`) | Aufwand/Stückzahl | Stk-Zahl ab 30 (teal), ab 75 (dark teal) |
| 🔵 **Blau** (`#0066cc`) | Primär-Aktion | FERTIG-Button, Fotodoku-Hinweis |
| 🟡 **Sanftes Amber** (`#fdf1d8`) | Sektions-Marker (keine Warnung) | Datum-Group-Header „normale Tage" |
| ⚪ Neutral | Sekundäre Info | Kommission, Meta-Daten |

**Regel:** Bevor eine neue Farbe eingeführt wird, muss geprüft werden, ob ein existierender Kanal ausreicht. **Farbinflation** ist der häufigste UX-Fehler.

---

## 4. Typografie

### 4.1 Schrift
- **Primär:** IBM Plex Sans (400/500/600/700/800)
- **Mono (Timer, Zahlen):** IBM Plex Mono (600/700)
- **Fallback:** `system-ui, sans-serif`

### 4.2 Hierarchie & Größen

| Element | Größe | Gewicht | Bemerkung |
|---|---|---|---|
| Auftragsnr (Hero) | 44px | 800 | Dominantes ID-Element |
| Auftragsnr (Queue) | 32px | 800 | |
| Jahr-Prefix der Nr | ~60% der Nr | 500 | Sekundär, gedämpft |
| Stückzahl (Hero) | 52px | 800 | Zweitgrößtes Element |
| Stückzahl (Queue) | 46px | 800 | |
| Timer-Wert (Hero) | 36px | 600 | Mono |
| Timer-Wert (Queue) | 30px | 600 | Mono |
| Kunde | 16–18px | 500 | Kontext |
| Kommission | 14px | 600 | Teal-Farbe |
| Badges | 11–12px | 700 | Uppercase |
| Date-Header | 20px | 800 | |

### 4.3 Zahlen
**Immer** `font-variant-numeric: tabular-nums`. Sonst springen Ziffern während Timer läuft.

### 4.4 Auftragsnr-Format
Format „2023 680" mit echtem Leerzeichen — **kopierbar**. Jahr gedämpft, Nr dominant.

```
2023 680    ←  "2023" in 20px/500/grau, "680" in 32px/800/schwarz
```

### 4.5 Caps nur für Labels
`HIGH PRIO`, `NOTIZ`, `HEUTE ERLEDIGT` — Caps signalisiert „Label/Klasse". Fließtext bleibt Mixed Case: „in 3 Tagen", „heute", „morgen".

---

## 5. Layout-Patterns

### 5.1 Sektions-Aufbau (von oben nach unten)

```
[ Header: Station · IMS Produktion · Sync · Logout ]
[ Suchfeld                                          ]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
● AKTUELL IN ARBEIT  (pulsierender grüner Dot)
  [Hero-Karte(n) — bei 1: Cockpit-Layout, bei 2+: Grid]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WARTESCHLANGE (N)     Als Nächstes: [...]    ↓ Heute erledigt
  ┌ Datum-Gruppe (heute)
  └ Karten pro Tagesoptimierung (01, 02, …)
  ┌ Datum-Gruppe (morgen)
  └ Karten
  …
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ HEUTE ERLEDIGT (N)  Gesamt-Zeit: Xh Ym   ↑ Zur Warteschlange
  [Tabellarische Einträge mit Rückgängig]
```

### 5.2 Hero-Karte (Cockpit)
- **Voll breit**, oben, nicht übersehbar
- Bei 1 laufendem Auftrag: **zweispaltig** (Action links, Positionen-Platzhalter rechts)
- Bei 2+ laufenden (z.B. 2 CNC-Maschinen parallel): **Grid** mit je einer Karte, ohne Cockpit-Layout
- Größerer Auftragsnr-Block, größerer Timer, grüner Rand + Schatten

### 5.3 Queue-Karte
- **Grid, nicht Multi-Column-Flow** — gleiche Row-Höhe, FERTIG-Button per `margin-top: auto` am Kartenboden fixiert
- **Gruppiert nach Lieferdatum** (Tagesoptimierung via `a.prio` innerhalb der Gruppe)
- Karten-Rand kodiert Zustand: violett (HighPrio), orange (bald), amber (blockiert), grün (läuft)

### 5.4 Tages-Tabelle „Heute erledigt"
- Dichter Zeilen-Layout (nicht Karten)
- Feste Spaltenbreiten: Prio · Zeit · Nr · Kunde · Kommission · Stk · IST · Rückgängig
- Header klickbar für Sortierung (mit Pfeil-Indikator)
- Default: nach Fertigmeldung-Uhrzeit desc
- Immer sichtbar (auch bei 0 Einträgen: Empty-State)
- Alignment: Header- und Zellen-Inhalt gleich (alles links bündig)

### 5.5 Responsiveness
- **Ab 900 px:** Hero als 2-Spalten-Cockpit
- **Unter 900 px:** Cockpit stackt vertikal
- Queue-Grid: `auto-fit, minmax(380px, 1fr)` — passt sich automatisch an
- Tabelle unter 820 px: Header weg, Zeilen stacken kompakt

---

## 6. Interaktions-Patterns

### 6.1 Timer-Bedienung
**Nur Start ↔ Pause Toggle** — kein separater „Stop"-Button. Technisch ist Pause = Timer-Stop, aber linguistisch klarer als Stop. Dritter Zustand (endgültig) ist FERTIG.

### 6.2 FERTIG-Button
- **Groß, prominent, voll breit** am Kartenboden
- Text: `FERTIG` in Caps (Stations-Name redundant — MA weiß wo er ist)
- **Keine Confirm-Modal** — direkte Aktion
- Toast-Bestätigung nach Klick: `✓ 2023 680 abgeschlossen · Timer gestoppt`
- **Rückgängig** via Tages-Tabelle
- Subline dynamisch: „Timer stoppt automatisch" **nur wenn Timer gerade läuft**

### 6.3 Blockierung setzen
- Nicht permanent sichtbar — nur als **Toggle-Button** („Blockierung setzen")
- Klick öffnet Modal mit Gründen
- Bei aktiver Blockierung: inline Dropdown + Aufheben-Button auf der Karte

### 6.4 Suche
- **Live-Filter** (kein Dropdown-Autocomplete)
- Ab 2 Zeichen
- Durchsucht: Nr, Kunde, Kommission
- Match-Counter sichtbar („12 von 18")
- Clear-Button + Esc-Taste
- Filtert Queue **und** Tages-Tabelle gleichzeitig

### 6.5 Sprung-Navigation
- Queue ↔ Tages-Tabelle per klickbarem Link im jeweiligen Header
- `scroll-behavior: smooth`
- **Bidirektional** — Rundreise muss immer möglich sein (Nielsen #3)

### 6.6 Rückgängig
- In der Tages-Tabelle pro Zeile
- Confirm-Modal (leichtgewichtig) mit klarem Text was passiert
- Server-Action: `stationFertig[AP]` löschen, Timer-Daten bleiben erhalten

### 6.7 Station-Picker
- Bei Aufruf ohne `?ap=` Parameter
- **Gruppiert** nach Werkstatt-Bereich (VF, ZB, NB, Heizung, EB, Versand)
- **Live-Info** pro Station: offen / läuft / blockiert / leer
- Keine Tab-Navigation im Tool — Picker ist einmalig, Bookmark wird gesetzt

---

## 7. Datum & Termin-Darstellung

### 7.1 Primär-Gruppierung
Queue ist **nach Lieferdatum gruppiert** (zentrale IMS-Ordnungsregel). Jede Tagesgruppe hat eigenen Header mit:
- Wochentag + Datum (z.B. „Donnerstag, 17.04.2026")
- Relativ-Angabe („· heute" / „· in 3 Tagen" / „· 5 Tage über")
- Anzahl Aufträge

### 7.2 Farb-Codierung Group-Header
- **Grün:** heute (Handlungsauftrag)
- **Rot:** überfällig (Alarm)
- **Sanftes Amber:** alle anderen Tage (Sektions-Marker, kein Alarm)

Bewusst **nur drei Zustände**, keine feinere Abstufung. Begründung: Der MA kennt den Kalender. Orange-für-in-3-Tagen vs. Blau-für-in-5-Tagen bringt keinen Mehrwert, nur visuelle Unruhe.

### 7.3 Innerhalb einer Gruppe
Sortierung nach `a.prio` (Tagesoptimierung — wird in der Planung gesetzt). Die Prio-Nummern (01, 02, 03…) sind **pro Tag** eindeutig — über Tage hinweg können Prios doppelt vorkommen (das ist gewollt und durch die Gruppierung aufgelöst).

---

## 8. Was wir bewusst NICHT machen

| Verzicht | Begründung |
|---|---|
| Dark Mode | MA arbeiten in hellen Hallen, dunkle UIs spiegeln |
| Browser-`confirm()` | Aussehen variiert pro Tablet, „OK" ist schwach, Keyboard-Risiko |
| Tabs | Versteckte Inhalte werden vergessen; Tablet-Klicks sind ungenau |
| Durchschnittszeit-Anzeige (aktuell deaktiviert) | Rohwerte ohne Stückzahl-Bezug sind irreführend — erst wieder mit validen Plan-Zeiten |
| Progress-Bar gegen Plan | Gleicher Grund; + Risiko von Hetzerei |
| Farb-Ampel auf IST-Zeit | Bewertung des MA ist nicht Ziel des Tools |
| Notiz-Kategorien | Aktuell funktioniert eine einheitliche Warnbox — Kategorien wären Overkill |
| Autocomplete-Dropdown | Live-Filter ist überlegen auf Tablet (Kontext bleibt sichtbar) |
| Positionen-Details im Platzhalter-Text | „folgt mit ERP" ist Werbung für Feature das nicht existiert — leerer Platzhalter reicht |

---

## 9. Architektur-Skizze

```
┌──────────────────┐         ┌──────────────────┐
│  station.html    │ ←────→  │   shared.js      │
│  (UI, Routing,   │ imports │   - CONFIG       │
│   Render, State) │         │   - sbFetch()    │ ────→  Supabase
│                  │         │   - route        │         (PATCH/GET)
│                  │         │   - store +      │
│                  │         │     Mutationen   │
│                  │         │   - Helpers      │
└──────────────────┘         └──────────────────┘

            index.html (Planer, Admin)
            nutzt shared.js (noch) NICHT
            — eigene Legacy-Logik, bleibt produktiv bis zur Migration
```

**Goldene Regel:** Alle Supabase-Calls laufen durch `sbFetch()` in `shared.js`. Beim Plattform-Umstieg (Node.js-API) wird nur diese eine Funktion getauscht.

---

## 10. Offene Punkte für Phase 2 (nach ERP-Integration)

- **Auftragspositionen** im Cockpit (rechte Hero-Spalte, aktuell leerer Platzhalter)
- **Plan-Zeit pro Auftrag** aus ERP → reaktiviert Progress-Bar
- **∅-Zeit pro Stück** (statt pro Auftrag) → valide Schätzung
- **Zeichnungs-Link** pro Auftrag (PDF-Öffnen)
- **User-/Tablet-Identifikation** bei Timer-Start → „meine" vs „fremde" Aufträge
- **Undo-Toast** als Alternative zum Confirm bei destruktiveren Aktionen
- **Maschinen-Zuordnung** (CNC 1 / CNC 2) — benötigt Planer-Update in index.html

---

## 11. Entscheidungs-Log (warum Dinge so sind)

| Entscheidung | Warum |
|---|---|
| HighPrio in Violett statt Rot | Rot ist für Produktions-MA „Stop/Problem" — HighPrio ist aber kein Problem, nur Priorität |
| Prio-Pill statt grauem Text | Zu unauffällig bei rosa/violettem HighPrio-Hintergrund |
| Stückzahl 46px (Queue) / 52px (Hero) | Zweitwichtigste Info nach Nr — muss aus 2 m erkennbar sein |
| Queue-Grid statt Multi-Column-Flow | Multi-Column verursacht versetzte Karten; Grid → gleiche Row-Höhe → sauberer Scan |
| Tages-Tabelle unten statt Tab | Tabs verstecken, Undo-Fall braucht schnellen Zugriff |
| Datum-Header Amber (nicht grau) | Lebendigkeit/Scan-Orientierung — rein neutrale Header wirkten leblos |
| FERTIG ohne Subline (außer bei laufendem Timer) | Stations-Name ist redundant, „→ nächste Station" stimmt nicht immer (S1-Miniaufträge) |
| Keine Confirm-Modal bei Fertig | Verzögerung im Haupt-Workflow; Tages-Tabelle bietet Rückgängig |
| Suche als Live-Filter | Tablet-Eingabe vertragsich besser mit Filter als mit Dropdown |
| Tabelle linksbündig (auch Zahlen) | Header-Zellen-Alignment muss konsistent sein; Excel-Konvention greift nicht auf Tablet |
| Kunde grün in Tabelle | Primäres Identifikations-Merkmal nach Nr |
| Kommission neutral (nicht grün) | Keine Farb-Konkurrenz mit Hero-Grün |

---

*Dokument-Stand: April 2026. Alle Regeln sind Ergebnis iterativer UX-Reviews mit dem externen „Dr. Klaus"-Sparring. Änderungen dieser Regeln bitte im Entscheidungs-Log nachpflegen.*
