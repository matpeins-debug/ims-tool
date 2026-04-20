// ─────────────────────────────────────────────────────────────────────────────
// IMS Plattform — shared.js (v2 — Race-Safe mit Ops-Queue + CAS)
// Gemeinsame Bibliothek für station.html (und später cockpit.html).
// index.html nutzt diese Datei (noch) NICHT — es bleibt unverändert produktiv.
//
// Architektur v2:
// - Statt Full-State-Overwrite: Operationen in Queue, flush() mit CAS.
// - Optimistische UI-Updates: Mutation wirkt sofort lokal, Server folgt.
// - Offline-Queue in localStorage → überlebt Reload, syncht bei online-Event.
// - Compare-and-Swap via updated_at-Filter → verhindert verlorene Updates.
//
// Goldene Regel: EINE API-Funktion für Supabase-Calls (sbFetch/sbPatchCAS).
// Beim Plattform-Umstieg auf Node.js-API werden nur diese zwei getauscht.
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
    AUTH_KEY:       'ims_authed',
    POLL_MS:        15000,
    // Queue / CAS
    OP_QUEUE_KEY:       'ims_op_queue',
    OP_QUEUE_MAX:       500,
    CONFLICT_LOG_KEY:   'ims_conflict_log',
    CONFLICT_LOG_MAX:   100,
    SHARED_VERSION_KEY: 'ims_shared_version',
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
  const ABHAENGIGKEITEN = {
    'Zusammenbau':     ['CNC', 'AP-Armatur 1', 'AP-Armatur 2', 'UP-Armatur 1', 'UP-Armatur 2'],
    'Nachbearbeitung': ['CNC', 'AP-Armatur 1', 'AP-Armatur 2', 'UP-Armatur 1', 'UP-Armatur 2', 'Zusammenbau'],
  };

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
  function isAPOffen(a, apFull) {
    if (!getAuftragAPs(a).includes(apFull)) return false;
    if (a.stationFertig && a.stationFertig[apFull]) return false;
    return true;
  }

  // Blockierung auf diesem AP?
  function hatBlockierung(a, apFull) {
    return !!(a.blockierungen && a.blockierungen[apFull]);
  }

  // Abhängigkeiten erfüllt (Vorgänger-APs fertig)?
  function sindVorgaengerFertig(a, apFull) {
    const deps = ABHAENGIGKEITEN[apFull];
    if (!deps) return true;
    const aps = getAuftragAPs(a);
    const relevante = deps.filter(d => aps.includes(d));
    return relevante.every(d => a.stationFertig && a.stationFertig[d]);
  }

  // Timer-Key für Auftrag x AP (so wie in index.html verwendet)
  function timerKey(auftragId, apFull) {
    return `${auftragId}_${apFull}`;
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
  const LOCK_NAME = 'ims_op_queue_lock';

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
  const store = {
    auftraege: [],
    updatedAt: null,

    async load() {
      this.auftraege = await sbFetch('load');
      this.updatedAt = new Date().toISOString();
      return this.auftraege;
    },

    async save() {
      await sbFetch('save', this.auftraege);
      this.updatedAt = new Date().toISOString();
    },

    getAuftrag(id) {
      return this.auftraege.find(a => a.id === id);
    },

    // SAFE: Prüft Lauf-Status bevor start überschrieben wird (gleicher Guard wie index.html).
    async timerStart(id, apFull) {
      const a = this.getAuftrag(id);
      if (!a) return false;
      if (!a.timers) a.timers = {};
      const key = timerKey(id, apFull);
      const existing = a.timers[key] || {};

      let totalMs = existing.totalMs || 0;
      if (existing.start && !existing.end) {
        const elapsed = Date.now() - new Date(existing.start).getTime();
        if (elapsed > 0) totalMs += elapsed;
        console.warn('[shared] timerStart: laufender Timer automatisch gestoppt', key, '+', Math.round(elapsed / 60000), 'min gerettet');
      }

      a.timers[key] = { totalMs, start: new Date().toISOString(), end: null };
      await this.save();
      return true;
    },

    async timerStop(id, apFull) {
      const a = this.getAuftrag(id);
      if (!a || !a.timers) return false;
      const key = timerKey(id, apFull);
      const td = a.timers[key];
      if (!td || !td.start || td.end) return false;

      const elapsed = Date.now() - new Date(td.start).getTime();
      a.timers[key] = {
        totalMs: (td.totalMs || 0) + elapsed,
        start:   td.start,
        end:     new Date().toISOString(),
      };
      await this.save();
      return true;
    },

    async setBlockierung(id, apFull, grund) {
      const a = this.getAuftrag(id);
      if (!a) return false;
      if (!a.blockierungen) a.blockierungen = {};
      if (grund) a.blockierungen[apFull] = grund;
      else delete a.blockierungen[apFull];
      a.blockierung = Object.keys(a.blockierungen).length > 0
        ? Object.values(a.blockierungen)[0]
        : null;
      await this.save();
      return true;
    },

    async markStationFertig(id, apFull) {
      const a = this.getAuftrag(id);
      if (!a) return false;
      if (!a.stationFertig) a.stationFertig = {};
      a.stationFertig[apFull] = new Date().toISOString();
      // Laufenden Timer für diese Station sauber stoppen
      if (a.timers && a.timers[timerKey(id, apFull)] && !a.timers[timerKey(id, apFull)].end) {
        await this.timerStop(id, apFull);  // save() passiert dort bereits
      } else {
        await this.save();
      }
      return true;
    },

    // Rueckgaengig-Funktion: Fertig-Meldung zuruecknehmen (Timer bleibt wie er ist)
    async undoStationFertig(id, apFull) {
      const a = this.getAuftrag(id);
      if (!a || !a.stationFertig) return false;
      delete a.stationFertig[apFull];
      await this.save();
      return true;
    },
  };

  // ─── EXPORT ────────────────────────────────────────────────────────────────
  global.IMS = {
    CONFIG,
    sbFetch,
    route,
    resolveAP,
    isAuthed, authCheck, logout,
    GRUPPEN, ARBEITSPLAETZE, BLOCKIERUNG_GRUENDE, AP_FOTO_REQUIRED, ABHAENGIGKEITEN,
    getAuftragAPs, isAPOffen, hatBlockierung, sindVorgaengerFertig, timerKey,
    calcTotalMs, istTimerAktiv,
    formatMs, formatElapsed, formatDatum, formatZeit, tageBis,
    store,
    // v2 Ops-Framework (Queue + Flush werden in nachfolgenden Commits ergänzt)
    uuid, clientId, logConflict,
    makeOp, applyOp, applyOpsToState,
    opQueue, withQueueLock,
  };
})(window);
