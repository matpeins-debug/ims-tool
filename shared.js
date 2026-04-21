// ─────────────────────────────────────────────────────────────────────────────
// IMS Plattform — shared-v2.js (Canary-Deploy fuer station-v2.html)
//
// Diese Datei ist eine parallele Version von shared.js mit Race-Safe
// Ops-Queue + CAS. Wird NUR von station-v2.html geladen waehrend des
// Canary-Tests (einzelnes Tablet, z.B. CNC). Andere Tablets nutzen weiter
// shared.js (v1).
//
// Getrennte localStorage-Keys (ims_v2_*) damit v1 und v2 sich nicht beissen:
//   Queue, Konflikt-Log, Schema-Version alle mit v2-Prefix.
//   AUTH_KEY bleibt gleich — MA muss nicht doppelt einloggen.
//
// Nach erfolgreichem Canary-Test: shared-v2.js überschreibt shared.js,
// station-v2.html überschreibt station.html, Canary-Dateien werden entfernt.
//
// Architektur v2:
// - Statt Full-State-Overwrite: Operationen in Queue, flush() mit CAS.
// - Optimistische UI-Updates: Mutation wirkt sofort lokal, Server folgt.
// - Offline-Queue in localStorage → überlebt Reload, syncht bei online-Event.
// - Compare-and-Swap via updated_at-Filter → verhindert verlorene Updates.
// ─────────────────────────────────────────────────────────────────────────────
(function (global) {
  'use strict';

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const CONFIG = {
    SUPABASE_URL:   'https://elwlptapzwwqhjuxnnws.supabase.co',
    SUPABASE_KEY:   'sb_publishable_MbE6UlJorEnYMe6w77Lixw_ttcF5gBx',
    SUPABASE_TABLE: 'ims_data',
    SUPABASE_ROW:   'main',
    AUTH_PW:        'imsflow',
    AUTH_KEY:       'ims_authed',          // bleibt gleich — Login geteilt mit v1
    POLL_MS:        15000,
    // Queue / CAS — v2-Keys damit v1 und v2 parallel koexistieren koennen
    OP_QUEUE_KEY:       'ims_v2_op_queue',
    OP_QUEUE_MAX:       500,
    CONFLICT_LOG_KEY:   'ims_v2_conflict_log',
    CONFLICT_LOG_MAX:   100,
    SHARED_VERSION_KEY: 'ims_v2_shared_version',
    SHARED_VERSION:     '2',
    FLUSH_DEBOUNCE_MS:  250,
    CAS_MAX_RETRIES:    5,
  };

  // ─── UUID (mit Fallback für ältere Browser ohne crypto.randomUUID) ─────────
  function uuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback: Timestamp + zwei Random-Chunks (ausreichend eindeutig für unseren Scope)
    return 'op-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10);
  }

  // Client-ID aus URL-Parameter (z.B. "station-cnc" für ?ap=cnc)
  function clientId() {
    try {
      const ap = (new URLSearchParams(location.search)).get('ap') || 'unknown';
      return 'station-' + ap;
    } catch (e) {
      return 'client-unknown';
    }
  }

  // ─── KONFLIKT-LOG (localStorage, FIFO max 100) ─────────────────────────────
  function logConflict(op, reason, extra) {
    try {
      const raw = localStorage.getItem(CONFIG.CONFLICT_LOG_KEY) || '[]';
      const log = JSON.parse(raw);
      log.push({
        ts:              new Date().toISOString(),
        op_id:           op ? op.op_id : null,
        type:            op ? op.type : null,
        auftrag_id:      op ? op.auftrag_id : null,
        station:         op ? op.station : null,
        reason,
        ...(extra || {}),
      });
      // FIFO: oldest raus wenn Limit überschritten
      if (log.length > CONFIG.CONFLICT_LOG_MAX) {
        log.splice(0, log.length - CONFIG.CONFLICT_LOG_MAX);
      }
      localStorage.setItem(CONFIG.CONFLICT_LOG_KEY, JSON.stringify(log));
      console.warn('[shared] conflict:', reason, { op_id: op && op.op_id, type: op && op.type, ...(extra || {}) });
    } catch (e) {
      console.error('[shared] logConflict failed:', e);
    }
  }

  // ─── SUPABASE-WRAPPER ──────────────────────────────────────────────────────
  // Einzige Stelle mit Supabase-Spezifika. Actions: 'load' | 'save'.
  async function sbFetch(action, payload) {
    const baseUrl = `${CONFIG.SUPABASE_URL}/rest/v1/${CONFIG.SUPABASE_TABLE}?id=eq.${CONFIG.SUPABASE_ROW}`;
    const headers = {
      'apikey':        CONFIG.SUPABASE_KEY,
      'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
    };

    if (action === 'load') {
      const res = await fetch(`${baseUrl}&select=auftraege`, { headers });
      if (!res.ok) throw new Error('sbFetch load failed ' + res.status);
      const data = await res.json();
      return (data[0] && data[0].auftraege) || [];
    }

    if (action === 'save') {
      const res = await fetch(baseUrl, {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Prefer':       'return=minimal',
        },
        body: JSON.stringify({
          auftraege:  payload,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error('sbFetch save failed ' + res.status);
      return true;
    }

    throw new Error('sbFetch: unbekannte action "' + action + '"');
  }

  // ─── ROUTING via URL-Parameter ─────────────────────────────────────────────
  // ?view=station&ap=cnc   → Station-Modus CNC
  // ?view=flow             → Cockpit/Flow (später)
  // ohne Parameter          → full (Default, für Planung/GF-Browser)
  const _params = new URLSearchParams(location.search);
  const route = {
    view: _params.get('view') || 'full',
    ap:   _params.get('ap') || null,    // 'cnc' | 'ap1' | 'ap2' | 'up1' | 'up2' | 'heizung' | 'zusammenbau' | 'nachbearbeitung' | 'einbauelement' | 'versand'
  };

  // Mapping URL-Kürzel → voller AP-Name (wie in GRUPPEN / Timer-Keys verwendet)
  const AP_ALIAS = {
    'cnc':             'CNC',
    'ap1':             'AP-Armatur 1',
    'ap2':             'AP-Armatur 2',
    'up1':             'UP-Armatur 1',
    'up2':             'UP-Armatur 2',
    'heizung':         'Heizung',
    'zusammenbau':     'Zusammenbau',
    'nachbearbeitung': 'Nachbearbeitung',
    'einbauelement':   'Einbauelement',
    'versand':         'Versand',
  };
  function resolveAP(alias) {
    if (!alias) return null;
    return AP_ALIAS[alias.toLowerCase()] || alias;
  }

  // ─── AUTH ──────────────────────────────────────────────────────────────────
  // Identisches Verhalten wie index.html: Passwort im localStorage-Flag.
  // Nicht sicher, aber Mis-Click-Schutz. Echte Auth kommt mit Plattform-Migration.
  function isAuthed() {
    return localStorage.getItem(CONFIG.AUTH_KEY) === '1';
  }
  function authCheck(pw) {
    if (pw === CONFIG.AUTH_PW) {
      localStorage.setItem(CONFIG.AUTH_KEY, '1');
      return true;
    }
    return false;
  }
  function logout() {
    localStorage.removeItem(CONFIG.AUTH_KEY);
  }

  // ─── KONSTANTEN (identisch zu index.html) ──────────────────────────────────
  const GRUPPEN = {
    '0': { name: 'Gruppe 0', aps: ['CNC', 'AP-Armatur 1', 'AP-Armatur 2', 'Zusammenbau', 'Nachbearbeitung'] },
    '1': { name: 'Gruppe 1', aps: ['CNC', 'UP-Armatur 1', 'UP-Armatur 2', 'Zusammenbau', 'Nachbearbeitung'] },
    '2': { name: 'Gruppe 2', aps: ['Heizung'] },
    '3': { name: 'Gruppe 3', aps: ['CNC', 'AP-Armatur 1', 'AP-Armatur 2', 'UP-Armatur 1', 'UP-Armatur 2', 'Heizung'] },
    '4': { name: 'Gruppe 4', aps: ['CNC', 'AP-Armatur 1', 'AP-Armatur 2', 'UP-Armatur 1', 'UP-Armatur 2', 'Heizung'] },
    '5': { name: 'Gruppe 5', aps: ['CNC', 'UP-Armatur 1', 'UP-Armatur 2', 'Einbauelement'] },
    '6': { name: 'Gruppe 6', aps: ['Versand'] },
  };
  const ARBEITSPLAETZE = [
    'CNC', 'AP-Armatur 1', 'AP-Armatur 2',
    'UP-Armatur 1', 'UP-Armatur 2',
    'Heizung', 'Zusammenbau', 'Nachbearbeitung', 'Einbauelement',
  ];
  const BLOCKIERUNG_GRUENDE = [
    'Material fehlt',
    'Kundenabklärung',
    'Interne Abklärung',
    'MATERIAL BEIGESTELLT',
  ];
  const AP_FOTO_REQUIRED = ['UP-Armatur 1', 'UP-Armatur 2'];
  // Abhaengigkeiten:
  //   Zusammenbau:     braucht VF-Stationen (CNC + AP/UP) fertig
  //   Nachbearbeitung: braucht VF-Stationen fertig — laeuft PARALLEL zu ZB
  //                     (ZB ist KEIN direkter Vorgaenger).
  // Plus transitive Regel in sindVorgaengerFertig: wenn Zusammenbau fertig,
  // gelten alle VF-Stationen als fertig (rettet Auftraege mit Race-verlorenen
  // VF-Meldungen die aber bereits durch ZB durch sind).
  const ABHAENGIGKEITEN = {
    'Zusammenbau':     ['CNC', 'AP-Armatur 1', 'AP-Armatur 2', 'UP-Armatur 1', 'UP-Armatur 2'],
    'Nachbearbeitung': ['CNC', 'AP-Armatur 1', 'AP-Armatur 2', 'UP-Armatur 1', 'UP-Armatur 2'],
  };
  const VF_STATIONS = ['CNC', 'AP-Armatur 1', 'AP-Armatur 2', 'UP-Armatur 1', 'UP-Armatur 2'];

  // ─── AUFTRAGS-HELPERS ──────────────────────────────────────────────────────
  // Welche APs sind für diesen Auftrag relevant (aus Gruppen aufgelöst)?
  function getAuftragAPs(a) {
    const aps = new Set();
    if (a.gruppen && a.gruppen.length) {
      a.gruppen.forEach(g => { if (GRUPPEN[g.gruppe]) GRUPPEN[g.gruppe].aps.forEach(ap => aps.add(ap)); });
    } else if (a.gruppe && GRUPPEN[a.gruppe]) {
      GRUPPEN[a.gruppe].aps.forEach(ap => aps.add(ap));
    }
    return [...aps];
  }

  // Hat dieser Auftrag den gegebenen AP noch offen (nicht station-fertig)?
  // Prueft beide Key-Varianten (space/dash vs. underscore — Legacy-Kompatibilitaet)
  //
  // SONDERFALL Versand: kein Produktions-AP, sondern Endpunkt. Zeige ALLE
  // noch nicht versendeten Auftraege. Fehlende Vorstations-Meldungen sind
  // nur Warnung + werden protokolliert (a.skipLog), kein Blocker.
  function isAPOffen(a, apFull) {
    if (apFull === 'Versand') {
      if (a.fertig) return false;                      // bereits versendet
      if (_sfHas(a, 'Versand')) return false;          // explizit fertig markiert
      return true;                                      // sonst immer offen
    }
    if (!getAuftragAPs(a).includes(apFull)) return false;
    if (_sfHas(a, apFull)) return false;
    return true;
  }

  // Liefert die fehlenden Vorgaenger-Meldungen fuer eine Station
  // (fuer UI-Warnung + Skip-Log). Beruecksichtigt transitive Regel.
  function fehlendeVorgaenger(a, apFull) {
    if (apFull === 'Versand') {
      // Versand-Spezial: wenn NB fertig, gilt alles als "soweit ok";
      // sonst alle APs ausser Versand checken
      if (_sfHas(a, 'Nachbearbeitung')) return [];
      const aps = getAuftragAPs(a).filter(ap => ap !== 'Versand');
      return aps.filter(ap => !_sfHas(a, ap));
    }
    const deps = ABHAENGIGKEITEN[apFull];
    if (!deps) return [];
    const aps = getAuftragAPs(a);
    const relevante = deps.filter(d => aps.indexOf(d) !== -1);
    const zbFertig = _sfHas(a, 'Zusammenbau');
    return relevante.filter(d => {
      if (_sfHas(a, d)) return false;
      if (zbFertig && VF_STATIONS.indexOf(d) !== -1) return false;
      return true;
    });
  }

  // Blockierung auf diesem AP? Auch hier beide Key-Varianten.
  function hatBlockierung(a, apFull) {
    if (!a || !a.blockierungen) return false;
    if (a.blockierungen[apFull]) return true;
    const norm = String(apFull).replace(/[^a-z0-9]/gi, '_');
    return !!a.blockierungen[norm];
  }

  // Hilfsfunktion: stationFertig-Lookup mit Fallback auf normalisierten Key
  // (index.html legacy schreibt 'AP_Armatur_1', shared.js v2 'AP-Armatur 1'
  // — beide Varianten muessen gefunden werden).
  function _sfHas(a, station) {
    if (!a || !a.stationFertig) return false;
    if (a.stationFertig[station]) return true;
    const norm = String(station).replace(/[^a-z0-9]/gi, '_');
    return !!a.stationFertig[norm];
  }

  // Abhängigkeiten erfüllt (Vorgänger-APs fertig)?
  // Transitive Regel: Wenn Zusammenbau fertig ist, gelten VF-Stationen
  // implizit als fertig (auch wenn deren stationFertig durch die
  // Race-Condition verloren ging).
  function sindVorgaengerFertig(a, apFull) {
    const deps = ABHAENGIGKEITEN[apFull];
    if (!deps) return true;
    const aps = getAuftragAPs(a);
    const relevante = deps.filter(d => aps.includes(d));
    const zbFertig = _sfHas(a, 'Zusammenbau');
    return relevante.every(d => {
      if (_sfHas(a, d)) return true;
      // Transitive Regel: ZB fertig → VF gilt als fertig
      if (zbFertig && VF_STATIONS.indexOf(d) !== -1) return true;
      return false;
    });
  }

  // Timer-Key für Auftrag x AP (so wie in index.html verwendet)
  function timerKey(auftragId, apFull) {
    return `${auftragId}_${apFull}`;
  }

  // Stueckzahl die AN DIESER Station tatsaechlich bearbeitet wird.
  // Auftraege koennen multiple Gruppen haben (a.gruppen[]), jede mit eigener
  // stk-Zahl. Die Summe der Gruppen-stk deren Gruppe diesen AP enthaelt ist
  // die korrekte Stueckzahl fuer die Station.
  //
  // Beispiel Auftrag 2023732: {stk:6,gruppe:'0'} + {stk:14,gruppe:'1'} + {stk:8,gruppe:'2'}
  //   → CNC (in G0+G1):      6 + 14 = 20 Stk  (nicht 28!)
  //   → Heizung (nur G2):    8 Stk
  //   → AP-Armatur (nur G0): 6 Stk
  //   → UP-Armatur (nur G1): 14 Stk
  function stkFuerStation(a, apFull) {
    if (!a) return 0;
    if (a.gruppen && a.gruppen.length) {
      let sum = 0;
      a.gruppen.forEach(g => {
        const grp = GRUPPEN[g.gruppe];
        if (grp && grp.aps.indexOf(apFull) !== -1) {
          sum += Number(g.stk) || 0;
        }
      });
      return sum;
    }
    // Fallback: einzelne Gruppe (Legacy-Struktur)
    if (a.gruppe && GRUPPEN[a.gruppe] && GRUPPEN[a.gruppe].aps.indexOf(apFull) !== -1) {
      return Number(a.stk) || 0;
    }
    return 0;
  }

  // ─── OPERATION FACTORY ─────────────────────────────────────────────────────
  // Erzeugt ein Op-Objekt das in die Queue geht und später auf den Server-State
  // angewendet wird. Jede Op hat eine eindeutige op_id → Idempotenz.
  function makeOp(type, auftragId, station, payload) {
    return {
      op_id:      uuid(),
      client_id:  clientId(),
      ts:         new Date().toISOString(),
      type,
      auftrag_id: auftragId,
      station:    station || null,
      payload:    payload || {},
    };
  }

  // ─── OPERATION APPLY ───────────────────────────────────────────────────────
  // Pure Funktion: (state, op) → new_state
  // Idempotenz-Regeln pro Op-Type:
  //   timer_start:      first-write-wins (laufender Timer wird NICHT überschrieben)
  //   timer_stop:       last-write-wins (end wird gesetzt/aktualisiert)
  //   station_fertig:   first-write-wins (früheste Meldung gewinnt) + impliziter timer_stop
  //   station_undo:     löscht stationFertig, Timer bleibt erhalten
  //   blockierung_set:  last-write-wins
  //   blockierung_clear: idempotent
  //   notiz_set:        last-write-wins (Freitext, nicht kritisch)
  // Bei Konflikt: Logeintrag via logConflict(), State bleibt unverändert.
  function applyOp(state, op) {
    if (!state || !Array.isArray(state)) {
      console.error('[shared] applyOp: invalid state');
      return state || [];
    }
    const aIdx = state.findIndex(a => a.id === op.auftrag_id);
    if (aIdx === -1) {
      logConflict(op, 'auftrag_not_found');
      return state;
    }

    const result = state.slice();                   // shallow copy array
    const a      = Object.assign({}, state[aIdx]);  // shallow copy auftrag

    switch (op.type) {
      case 'timer_start': {
        const key = timerKey(a.id, op.station);
        const timers = Object.assign({}, a.timers || {});
        const td = timers[key];
        if (td && td.start && !td.end) {
          // Timer läuft bereits — first-write-wins, nicht überschreiben
          logConflict(op, 'timer_already_running', { existing_start: td.start });
          return state;
        }
        timers[key] = {
          totalMs: (td && td.totalMs) || 0,
          start:   op.ts,
          end:     null,
        };
        a.timers = timers;
        break;
      }

      case 'timer_stop': {
        const key = timerKey(a.id, op.station);
        const timers = Object.assign({}, a.timers || {});
        const td = timers[key];
        if (!td || !td.start || td.end) {
          logConflict(op, 'no_running_timer');
          return state;
        }
        const elapsed = new Date(op.ts).getTime() - new Date(td.start).getTime();
        timers[key] = {
          totalMs: (td.totalMs || 0) + Math.max(elapsed, 0),
          start:   td.start,
          end:     op.ts,
        };
        a.timers = timers;
        break;
      }

      case 'station_fertig': {
        const stationFertig = Object.assign({}, a.stationFertig || {});
        if (stationFertig[op.station]) {
          // First-write-wins: frühere Meldung bleibt stehen
          logConflict(op, 'already_fertig', {
            existing_value:  stationFertig[op.station],
            attempted_value: op.ts,
          });
          return state;
        }
        stationFertig[op.station] = op.ts;
        a.stationFertig = stationFertig;

        // ── SKIP-LOG: fehlende Vorstations-Meldungen protokollieren ────
        // Damit Mat auswerten kann wie oft pro Station die Fertigmeldung
        // uebersprungen wurde (MA-Disziplin-Auswertung).
        const missing = fehlendeVorgaenger(a, op.station);
        if (missing.length > 0) {
          a.skipLog = (a.skipLog || []).slice();
          a.skipLog.push({
            ts:      op.ts,
            station: op.station,
            missing: missing,
            client:  op.client_id,
          });
        }

        // Sonderfall Versand: markiert Auftrag als komplett fertig (versendet)
        if (op.station === 'Versand') {
          a.fertig = true;
          a.fertigAm = op.ts;
        }

        // Impliziter timer_stop wenn Timer läuft
        const key = timerKey(a.id, op.station);
        const timers = Object.assign({}, a.timers || {});
        const td = timers[key];
        if (td && td.start && !td.end) {
          const elapsed = new Date(op.ts).getTime() - new Date(td.start).getTime();
          timers[key] = {
            totalMs: (td.totalMs || 0) + Math.max(elapsed, 0),
            start:   td.start,
            end:     op.ts,
          };
          a.timers = timers;
        }
        break;
      }

      case 'station_undo': {
        const stationFertig = Object.assign({}, a.stationFertig || {});
        if (!stationFertig[op.station]) {
          logConflict(op, 'undo_without_fertig');
          return state;
        }
        delete stationFertig[op.station];
        a.stationFertig = stationFertig;
        // Sonderfall Versand: a.fertig/a.fertigAm auch zuruecknehmen
        if (op.station === 'Versand') {
          a.fertig = false;
          delete a.fertigAm;
        }
        // Timer bleibt erhalten (Historie)
        break;
      }

      case 'blockierung_set': {
        const blockierungen = Object.assign({}, a.blockierungen || {});
        blockierungen[op.station] = op.payload.grund;
        a.blockierungen = blockierungen;
        // Legacy-Feld 'blockierung' synchron halten
        a.blockierung = Object.keys(blockierungen).length > 0
          ? Object.values(blockierungen)[0]
          : null;
        break;
      }

      case 'blockierung_clear': {
        const blockierungen = Object.assign({}, a.blockierungen || {});
        delete blockierungen[op.station];
        a.blockierungen = blockierungen;
        a.blockierung = Object.keys(blockierungen).length > 0
          ? Object.values(blockierungen)[0]
          : null;
        break;
      }

      case 'notiz_set': {
        a.notiz = op.payload.text;
        break;
      }

      default:
        // Forward-compatible: unbekannte Op-Types loggen + skippen, nicht crashen
        console.warn('[shared] applyOp: unknown op type', op.type, '(op_id:', op.op_id, ')');
        logConflict(op, 'unknown_op_type');
        return state;
    }

    result[aIdx] = a;
    return result;
  }

  // Ops sequenziell auf State anwenden
  function applyOpsToState(state, ops) {
    if (!ops || !ops.length) return state;
    return ops.reduce(function (s, op) { return applyOp(s, op); }, state);
  }

  // ─── OP QUEUE (localStorage-backed, Multi-Tab-Safe) ────────────────────────
  // Jede Mutation wird erst in die Queue gepusht, dann optimistisch auf den
  // lokalen State angewendet, dann via flush() zum Server gebracht.
  // Multi-Tab-Lock: navigator.locks verhindert dass zwei Tabs gleichzeitig
  // den Queue-JSON lesen/schreiben (Read-Modify-Write-Race).
  const LOCK_NAME = 'ims_v2_op_queue_lock';

  function _hasLocksAPI() {
    return typeof navigator !== 'undefined' &&
           navigator.locks &&
           typeof navigator.locks.request === 'function';
  }

  // Unter Lock ausfuehren (falls API verfuegbar), sonst direkt
  async function withQueueLock(fn) {
    if (_hasLocksAPI()) {
      return await navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, async () => await fn());
    }
    // Fallback: einfach ausfuehren (Multi-Tab-Race moeglich, aber unwahrscheinlich
    // bei Produktions-Nutzung mit meist 1 Tab pro Tablet/Laptop)
    return await fn();
  }

  const opQueue = {
    _read() {
      try {
        return JSON.parse(localStorage.getItem(CONFIG.OP_QUEUE_KEY) || '[]');
      } catch (e) {
        console.error('[queue] read failed, resetting:', e);
        localStorage.setItem(CONFIG.OP_QUEUE_KEY, '[]');
        return [];
      }
    },

    _write(ops) {
      localStorage.setItem(CONFIG.OP_QUEUE_KEY, JSON.stringify(ops));
    },

    async enqueue(op) {
      return await withQueueLock(async () => {
        const ops = this._read();
        if (ops.length >= CONFIG.OP_QUEUE_MAX) {
          console.error('[queue] size limit reached (' + CONFIG.OP_QUEUE_MAX + ') — op rejected');
          logConflict(op, 'queue_overflow');
          _setSyncState('err', 'Offline — bitte Techniker rufen');
          return false;
        }
        ops.push(op);
        this._write(ops);
        return true;
      });
    },

    // Snapshot der Queue — nicht loeschen, nur lesen (fuer flush-Retry)
    peek() {
      return this._read();
    },

    // Ops mit gegebenen op_ids aus der Queue entfernen
    async remove(opIds) {
      if (!opIds || !opIds.length) return;
      const idSet = new Set(opIds);
      return await withQueueLock(async () => {
        const ops = this._read();
        const filtered = ops.filter(function (op) { return !idSet.has(op.op_id); });
        this._write(filtered);
      });
    },

    size() {
      return this._read().length;
    },

    clear() {
      // Nur fuer Tests oder Notfall-Reset
      this._write([]);
    },
  };

  // Sync-State-Callback — wird spaeter vom store gesetzt damit UI den Queue-Status sehen kann
  let _syncCallback = null;
  function _setSyncState(state, msg) {
    if (_syncCallback) {
      try { _syncCallback(state, msg, opQueue.size()); } catch (e) { console.error('[sync-cb]', e); }
    }
  }

  // ─── SUPABASE META-FETCH + CAS-PATCH ───────────────────────────────────────
  // Neben sbFetch('load'/'save') brauchen wir fuer CAS den Server-Zustand
  // INKLUSIVE updated_at (nicht nur auftraege). sbFetchWithMeta() liefert das.
  async function sbFetchWithMeta() {
    const url = `${CONFIG.SUPABASE_URL}/rest/v1/${CONFIG.SUPABASE_TABLE}?id=eq.${CONFIG.SUPABASE_ROW}&select=auftraege,updated_at`;
    const res = await fetch(url, {
      headers: {
        'apikey':        CONFIG.SUPABASE_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
      },
    });
    if (!res.ok) throw new Error('sbFetchWithMeta failed ' + res.status);
    const data = await res.json();
    const row = data[0] || {};
    return {
      auftraege:  row.auftraege || [],
      updated_at: row.updated_at || null,
    };
  }

  // PATCH mit updated_at=eq.<expected> Filter (Compare-and-Swap).
  // Returns true bei Erfolg (1 Row updated), false bei Konflikt (0 Rows).
  async function sbPatchCAS(newAuftraege, expectedUpdatedAt) {
    const baseUrl = `${CONFIG.SUPABASE_URL}/rest/v1/${CONFIG.SUPABASE_TABLE}?id=eq.${CONFIG.SUPABASE_ROW}`;
    const casFilter = expectedUpdatedAt
      ? `&updated_at=eq.${encodeURIComponent(expectedUpdatedAt)}`
      : '';
    const res = await fetch(baseUrl + casFilter, {
      method: 'PATCH',
      headers: {
        'apikey':        CONFIG.SUPABASE_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify({
        auftraege:  newAuftraege,
        // updated_at wird vom Server-Trigger automatisch gesetzt (falls vorhanden),
        // ansonsten nutzen wir Client-Zeit als Fallback
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error('sbPatchCAS failed ' + res.status);
    const updated = await res.json();
    // Leeres Array → kein Row passt → Konflikt (jemand anderes hat zwischendrin geschrieben)
    return Array.isArray(updated) && updated.length > 0;
  }

  // ─── FLUSH (Ops auf Server bringen via CAS-Loop) ───────────────────────────
  let _flushInFlight = false;        // Single-Flight-Lock
  let _flushTimer    = null;         // Debounce-Timer

  function scheduleFlush(delay) {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(function () {
      _flushTimer = null;
      flush().catch(function (e) { console.error('[flush] unexpected', e); });
    }, delay == null ? CONFIG.FLUSH_DEBOUNCE_MS : delay);
  }

  // flush() laedt den Server-State, wendet alle Pending-Ops an, versucht PATCH
  // mit updated_at-Filter. Bei Konflikt: Retry mit Exp-Backoff (max 5).
  // Nach Erfolg: verarbeitete op_ids aus Queue entfernen.
  async function flush() {
    if (_flushInFlight) return false;
    _flushInFlight = true;
    try {
      const ops = opQueue.peek();
      if (!ops.length) {
        _setSyncState('ok', 'Synchronisiert');
        return true;
      }

      _setSyncState('loading', 'Synchronisiere…');

      for (let retry = 0; retry < CONFIG.CAS_MAX_RETRIES; retry++) {
        try {
          // 1. Server-State holen
          const meta = await sbFetchWithMeta();
          // 2. Ops auf Server-State anwenden
          const newState = applyOpsToState(meta.auftraege, ops);
          // 3. CAS-PATCH
          const ok = await sbPatchCAS(newState, meta.updated_at);
          if (ok) {
            // Erfolg: Queue aufraeumen, Store aktualisieren
            await opQueue.remove(ops.map(function (o) { return o.op_id; }));
            _storeRef.auftraege = newState;
            _storeRef.updatedAt = new Date().toISOString();
            _setSyncState('ok', 'Synchronisiert');
            return true;
          }
          // CAS-Konflikt: jemand anderes war schneller → Retry
          console.warn('[flush] CAS conflict, retry ' + (retry + 1) + '/' + CONFIG.CAS_MAX_RETRIES);
          const wait = 100 * Math.pow(2, retry);  // 100/200/400/800/1600
          await new Promise(function (r) { setTimeout(r, wait); });
        } catch (e) {
          console.error('[flush] error on retry ' + retry + ':', e);
          // Netzwerk-Fehler: abbrechen, Queue bleibt, naechster Poll versucht erneut
          _setSyncState('err', 'Offline — Queue: ' + opQueue.size());
          return false;
        }
      }

      // Alle Retries erschoepft → Queue bleibt, naechster Poll retryt
      console.error('[flush] exhausted ' + CONFIG.CAS_MAX_RETRIES + ' retries');
      _setSyncState('err', 'Sync-Konflikt, Retry folgt');
      return false;
    } finally {
      _flushInFlight = false;
    }
  }

  // Vorwaertsdeklaration — wird am Ende dem echten store zugewiesen
  // (damit flush() auf _storeRef.auftraege zugreifen kann)
  let _storeRef = null;

  // Online-Event: bei Netzwerk-Wiederherstellung sofort flushen
  if (typeof window !== 'undefined') {
    window.addEventListener('online', function () {
      console.log('[shared] online-event, flushing queue');
      scheduleFlush(0);
    });
  }

  // ─── TIMER-BERECHNUNG ──────────────────────────────────────────────────────
  // Liefert totalMs inkl. laufender Zeit wenn Timer aktiv.
  function calcTotalMs(timerData) {
    if (!timerData) return 0;
    let total = timerData.totalMs || 0;
    if (timerData.start && !timerData.end) {
      const run = Date.now() - new Date(timerData.start).getTime();
      if (run > 0) total += run;
    }
    return total;
  }

  function istTimerAktiv(timerData) {
    return !!(timerData && timerData.start && !timerData.end);
  }

  // ─── FORMATTER ─────────────────────────────────────────────────────────────
  function formatMs(ms) {
    if (!ms || ms < 0) return '0m';
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 60) return totalMin + 'm';
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }

  function formatElapsed(ms) {
    if (!ms || ms < 0) return '00:00:00';
    const totalSec = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  const _WT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  function formatDatum(iso) {
    if (!iso) return '';
    const d = (iso instanceof Date) ? iso : new Date(iso);
    if (isNaN(d)) return '';
    return `${_WT[d.getDay()]}, ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.`;
  }

  function formatZeit(iso) {
    if (!iso) return '';
    const d = (iso instanceof Date) ? iso : new Date(iso);
    if (isNaN(d)) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function tageBis(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    const heute = new Date();
    heute.setHours(0, 0, 0, 0);
    d.setHours(0, 0, 0, 0);
    return Math.round((d - heute) / 86400000);
  }

  // ─── STORE: State + Schreib-Aktionen ───────────────────────────────────────
  // Hält den aktuellen auftraege-Array und kapselt alle Mutationen.
  // Die Timer-Start-Logik enthält den gleichen Guard wie der Bug-Fix in index.html.
  // ─── STORE v2: Ops-basiert ────────────────────────────────────────────────
  // Jede Mutation erzeugt eine Op, pusht sie in die Queue, wendet sie optimistisch
  // auf den lokalen State an, und schedulet flush(). Alle Funktions-Signaturen
  // bleiben identisch zu v1 — station.html ruft dieselben Methoden unverändert.
  const store = {
    auftraege: [],
    updatedAt: null,

    async load() {
      // Server-State laden + Pending-Queue-Ops optimistisch drauf anwenden,
      // damit UI konsistent bleibt mit lokalen nicht-synchronisierten Mutationen.
      const meta = await sbFetchWithMeta();
      const pendingOps = opQueue.peek();
      this.auftraege = pendingOps.length
        ? applyOpsToState(meta.auftraege, pendingOps)
        : meta.auftraege;
      this.updatedAt = meta.updated_at;
      // Wenn Queue nicht leer: versuche zu syncen
      if (pendingOps.length) {
        _setSyncState('loading', 'Pending: ' + pendingOps.length);
        scheduleFlush(0);
      }
      return this.auftraege;
    },

    // Legacy-API: save() ist jetzt Trigger für flush.
    // Wird von altem Code noch aufgerufen, aber die neuen Mutationen schedulen
    // ihren Flush selbst — save() ist im neuen Pfad quasi no-op.
    async save() {
      scheduleFlush(0);
    },

    getAuftrag(id) {
      return this.auftraege.find(a => a.id === id);
    },

    // ─── Mutationen via Op-Queue ──
    // Muster: (1) Op bauen, (2) in Queue, (3) optimistisch auf State appyn,
    //         (4) Flush schedulen. Alle Signaturen wie v1.

    async timerStart(id, apFull) {
      const a = this.getAuftrag(id);
      if (!a) return false;
      const op = makeOp('timer_start', id, apFull);
      await opQueue.enqueue(op);
      this.auftraege = applyOp(this.auftraege, op);
      scheduleFlush();
      return true;
    },

    async timerStop(id, apFull) {
      const a = this.getAuftrag(id);
      if (!a) return false;
      const op = makeOp('timer_stop', id, apFull);
      await opQueue.enqueue(op);
      this.auftraege = applyOp(this.auftraege, op);
      scheduleFlush();
      return true;
    },

    async setBlockierung(id, apFull, grund) {
      const a = this.getAuftrag(id);
      if (!a) return false;
      const op = grund
        ? makeOp('blockierung_set', id, apFull, { grund: grund })
        : makeOp('blockierung_clear', id, apFull);
      await opQueue.enqueue(op);
      this.auftraege = applyOp(this.auftraege, op);
      scheduleFlush();
      return true;
    },

    async markStationFertig(id, apFull) {
      const a = this.getAuftrag(id);
      if (!a) return false;
      // Eine einzelne 'station_fertig' Op — impliziter timer_stop passiert in applyOp
      const op = makeOp('station_fertig', id, apFull);
      await opQueue.enqueue(op);
      this.auftraege = applyOp(this.auftraege, op);
      scheduleFlush();
      return true;
    },

    async undoStationFertig(id, apFull) {
      const a = this.getAuftrag(id);
      if (!a) return false;
      const op = makeOp('station_undo', id, apFull);
      await opQueue.enqueue(op);
      this.auftraege = applyOp(this.auftraege, op);
      scheduleFlush();
      return true;
    },

    // Manueller Flush — z.B. fuer den Klick auf Sync-Badge
    async syncNow() {
      return await flush();
    },
  };

  // Forward-Reference von flush() auf den store setzen
  // (flush() muss store.auftraege + store.updatedAt nach Erfolg aktualisieren)
  _storeRef = store;

  // API fuer station.html um Sync-State-Updates zu abonnieren
  function onSync(cb) {
    _syncCallback = cb;
    // Initialen Zustand pushen
    _setSyncState('ok', 'Synchronisiert');
  }

  // ─── SCHEMA-MIGRATION (v1 → v2) ────────────────────────────────────────────
  // Wird beim Laden der Seite einmalig ausgefuehrt. Sauberer Upgrade-Pfad
  // fuer Tablets die vorher shared.js v1 benutzt haben.
  (function migrateSchema() {
    try {
      const currentVersion = localStorage.getItem(CONFIG.SHARED_VERSION_KEY);
      if (currentVersion === CONFIG.SHARED_VERSION) return;  // schon aktuell

      console.log('[shared] Schema-Migration v' + (currentVersion || '1') + ' → v' + CONFIG.SHARED_VERSION);

      // Op-Queue initialisieren falls nicht vorhanden
      if (!localStorage.getItem(CONFIG.OP_QUEUE_KEY)) {
        localStorage.setItem(CONFIG.OP_QUEUE_KEY, '[]');
      }
      // Konflikt-Log initialisieren falls nicht vorhanden
      if (!localStorage.getItem(CONFIG.CONFLICT_LOG_KEY)) {
        localStorage.setItem(CONFIG.CONFLICT_LOG_KEY, '[]');
      }
      // Version markieren
      localStorage.setItem(CONFIG.SHARED_VERSION_KEY, CONFIG.SHARED_VERSION);
      console.log('[shared] Migration abgeschlossen');
    } catch (e) {
      console.error('[shared] Migration fehlgeschlagen:', e);
    }
  })();

  // ─── EXPORT ────────────────────────────────────────────────────────────────
  global.IMS = {
    CONFIG,
    sbFetch,
    route,
    resolveAP,
    isAuthed, authCheck, logout,
    GRUPPEN, ARBEITSPLAETZE, BLOCKIERUNG_GRUENDE, AP_FOTO_REQUIRED, ABHAENGIGKEITEN,
    getAuftragAPs, isAPOffen, hatBlockierung, sindVorgaengerFertig, fehlendeVorgaenger, timerKey, stkFuerStation,
    calcTotalMs, istTimerAktiv,
    formatMs, formatElapsed, formatDatum, formatZeit, tageBis,
    store,
    // v2 Ops-Framework
    uuid, clientId, logConflict,
    makeOp, applyOp, applyOpsToState,
    opQueue, withQueueLock,
    sbFetchWithMeta, sbPatchCAS,
    flush, scheduleFlush,
    onSync,
  };
})(window);
