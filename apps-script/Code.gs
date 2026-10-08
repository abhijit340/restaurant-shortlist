/**
 * Seattle Food & Bev: backend script that lives inside the Google Sheet
 * (Extensions → Apps Script). It reads the restaurant tab, looks places up on
 * Google, and serves everything to the app as JSON. Secrets (the app key and
 * MAPS_KEY) live in Script Properties, never in this file.
 */

const SOURCE_TAB = 'Seattle dining';
const DATA_TAB = 'app data'; // managed by this script; the source tab is never written
const ADDED_TAB = 'added from app'; // places added from the phone; the script only ever adds rows here
const COLS = 5; // Name, menu/website, description, neighborhood, deals?

// Hard monthly caps, about 90% of Google's free allowances (checked 2026-09-30).
// Every Google request goes through spend_(), which refuses past these.
const MONTHLY_LIMITS = { textSearch: 900, placeDetails: 900, matrixTransit: 4500, matrixWalk: 9000, geocode: 9000 };

const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };

// Section header text (lowercase) → section id.
const SECTIONS = {
  'would recommend / want to return': 'recommend',
  'avoid': 'avoid',
  'to try': 'try',
};

// When a place is listed twice, the higher rank wins (AVOID beats everything).
const RANK = { try: 1, recommend: 2, avoid: 3 };

// ---------- Web endpoint ----------

/** Changes come in as POSTs with a JSON body: { key, action: "visit", place, verdict, deals, notes }. */
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad-request' }); }
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || body.key !== key) return json_({ error: 'bad-key' });
  try {
    if (body.action === 'visit') return json_(saveVisit_(body));
    if (body.action === 'fill') return json_(quickFill_(QUICK_FILL_MAX));
    if (body.action === 'add') return json_(addPlace_(body));
    if (body.action === 'edit') return json_(saveEdit_(body));
    return json_({ error: 'bad-request' });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

function doGet(e) {
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || !e || e.parameter.key !== key) return json_({ error: 'bad-key' });
  try {
    if (e.parameter.action === 'times') return json_(travelTimes_(e.parameter.from, e.parameter.to, e.parameter.when));
    if (e.parameter.action === 'geocode') return json_(geocode_(e.parameter.q));
    if (e.parameter.action === 'find') return json_(findPlaces_(e.parameter.q));
    const places = withAppData_(readAllPlaces_(), readAppData_());
    return json_({
      places,
      // Anything that needs a human's attention (empty when all is well).
      health: healthFrom_(PropertiesService.getScriptProperties().getProperties(), places, new Date()),
      // The browser map key (locked to the app's web address and to Maps JavaScript only).
      mapsKey: PropertiesService.getScriptProperties().getProperty('MAPS_BROWSER_KEY') || '',
      loadedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json_({ error: String(err) });
  }
}

// ---------- Run these from the editor ----------

/** Run once: creates the secret key (if needed) and prints it, plus a place count. */
function showAppSetup() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('KEY');
  if (!key) {
    key = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('KEY', key);
  }
  Logger.log('Key for the app: ' + key);
  Logger.log('Places found: ' + readAllPlaces_().length);
}

/** Run if the key ever leaks: the old key stops working, then run showAppSetup. */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  Logger.log('Key deleted. Run showAppSetup to make a new one, then re-enter it in the app.');
}

// ---------- Sheet menu ----------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Seattle Food & Bev')
    .addItem('Fill missing info', 'fillMissing')
    .addItem('Refresh hours now (10 oldest places)', 'refreshHoursNow')
    .addItem('Show Google usage this month', 'showUsage')
    .addToUi();
}

function showUsage() {
  const props = PropertiesService.getScriptProperties();
  const lines = Object.keys(MONTHLY_LIMITS).map(sku =>
    `${sku}: ${props.getProperty(usageKey_(sku)) || 0} of ${MONTHLY_LIMITS[sku]}`);
  SpreadsheetApp.getUi().alert(`Google usage for ${month_()}\n\n${lines.join('\n')}`);
}

// ---------- Auto-fill: look places up on Google ----------

const RUN_BUDGET_MS = 4.5 * 60 * 1000; // Apps Script stops any run at 6 minutes
const BATCH = 10;
const BATCH_INTERVAL_MS = 12000;       // 10 requests per 12 s = 50 a minute, under the 60/min quota

/**
 * Looks up every place that has no Google data yet, or whose search text changed
 * (for example you added a neighborhood to help it). Saves progress to the
 * "app data" tab and, if there's more to do, continues by itself a minute later.
 */
function fillMissing() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return notify_('Already running. Check the "app data" tab in a few minutes.');
  const started = Date.now();
  let data, places, done = 0, remaining = 0, stopReason = '';
  try {
    deleteTriggers_('continueFill');
    ensureNightly_();
    const apiKey = PropertiesService.getScriptProperties().getProperty('MAPS_KEY');
    if (!apiKey) throw new Error('MAPS_KEY is missing from Script Properties.');

    places = readAllPlaces_();
    data = readAppData_();
    recheckNames_(data);
    const todo = places.filter(p => needsLookup_(p, data.get(p.key)));
    remaining = todo.length;

    for (let i = 0; i < todo.length; i += BATCH) {
      if (Date.now() - started > RUN_BUDGET_MS) { stopReason = 'time'; break; }
      const batch = todo.slice(i, i + BATCH);
      if (!spend_('textSearch', batch.length)) { stopReason = 'limit'; break; }
      const t0 = Date.now();
      const responses = UrlFetchApp.fetchAll(batch.map(p => searchRequest_(p, apiKey)));
      watch_('place lookup', responses[0]);
      let rateLimited = false;
      batch.forEach((p, j) => {
        const rec = toRecord_(p, responses[j].getResponseCode(), responses[j].getContentText());
        if (rec.status === 'retry') { rateLimited = true; return; }
        data.set(p.key, carryVisit_(rec, data.get(p.key)));
        done++;
        remaining--;
      });
      if (rateLimited) { stopReason = 'rate'; break; }
      const wait = BATCH_INTERVAL_MS - (Date.now() - t0);
      if (wait > 0 && i + BATCH < todo.length) Utilities.sleep(wait);
    }
  } finally {
    if (data && places) writeAppData_(data, places);
    lock.releaseLock();
  }

  if (remaining > 0 && stopReason !== 'limit') {
    ScriptApp.newTrigger('continueFill').timeBased().after(60 * 1000).create();
  }
  const counts = { 'not found': 0, 'check name': 0 };
  data.forEach(r => { if (r.status in counts) counts[r.status]++; });
  notify_([
    `Looked up ${done} places.`,
    remaining === 0 ? 'All done.'
      : stopReason === 'limit' ? `${remaining} left, but this month's safety cap was reached. They'll be filled next month.`
      : `${remaining} left. Continuing automatically in about a minute.`,
    `Not found: ${counts['not found']}. Check name: ${counts['check name']}. (See the "${DATA_TAB}" tab.)`,
  ].join(' '));
}

function continueFill() { fillMissing(); }

const QUICK_FILL_MAX = 20; // few enough to answer the phone in a few seconds, under the per-minute quota

/**
 * "Look up now" from the phone: looks up to `max` waiting places on Google right
 * away. Anything beyond that carries on in the background a minute later.
 */
function quickFill_(max) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: 'busy' };
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty('MAPS_KEY');
    if (!apiKey) return { error: 'MAPS_KEY is missing from Script Properties.' };
    const places = readAllPlaces_();
    const data = readAppData_();
    const waiting = (list) => list.filter(p => needsLookup_(p, data.get(p.key)));
    const now = waiting(places).slice(0, max);
    if (now.length) {
      if (!spend_('textSearch', now.length)) return { error: 'monthly-limit' };
      for (let i = 0; i < now.length; i += BATCH) {
        const batch = now.slice(i, i + BATCH);
        const res = UrlFetchApp.fetchAll(batch.map(p => searchRequest_(p, apiKey)));
        watch_('place lookup', res[0]);
        batch.forEach((p, j) => {
          const rec = toRecord_(p, res[j].getResponseCode(), res[j].getContentText());
          if (rec.status !== 'retry') data.set(p.key, carryVisit_(rec, data.get(p.key)));
        });
      }
      writeAppData_(data, places);
    }
    const remaining = waiting(places).length;
    if (remaining) {
      deleteTriggers_('continueFill');
      ScriptApp.newTrigger('continueFill').timeBased().after(60 * 1000).create();
    }
    return { ok: true, looked: now.length, remaining };
  } finally {
    lock.releaseLock();
  }
}

/** Runs at 3 am: look up new rows, then refresh the oldest hours. */
function nightlyFill() {
  try {
    fillMissing();
    refreshStale_(REFRESH_PER_NIGHT, REFRESH_AFTER_DAYS);
    setHealth_('nightly', { ok: true });
  } catch (err) {
    setHealth_('nightly', { ok: false, msg: String(err).slice(0, 200) });
    throw err;
  }
}

// ---------- Health: things that need a human's attention ----------

const SKU_LABELS = { textSearch: 'Place lookups', placeDetails: 'Hours refreshes', matrixTransit: 'Transit times',
  matrixWalk: 'Walking times', geocode: 'Typed-place lookups' };

function setHealth_(name, value) {
  PropertiesService.getScriptProperties().setProperty('health:' + name, JSON.stringify(Object.assign({ at: Date.now() }, value)));
}

/**
 * Remembers when Google refuses a request (bad key, billing off, API disabled…),
 * and forgets it once the same kind of request works again. 429 (too fast) and
 * 404 (a retired place ID) are normal and ignored.
 */
function watch_(service, res) {
  const code = res.getResponseCode();
  const props = PropertiesService.getScriptProperties();
  if (code === 200) {
    const last = props.getProperty('health:apiError');
    if (last && JSON.parse(last).service === service) props.deleteProperty('health:apiError');
    return;
  }
  if (code === 429 || code === 404) return;
  let msg = '';
  try { msg = JSON.parse(res.getContentText()).error.message; } catch (e) { /* not JSON */ }
  setHealth_('apiError', { service, code, msg: String(msg).slice(0, 160) });
}

/**
 * The list of problems worth showing in the app, in plain words. Pure, testable:
 * props = all Script Properties, places = what the app is about to receive.
 */
function healthFrom_(props, places, now) {
  const out = [];
  const read = (key) => { try { return JSON.parse(props[key] || 'null'); } catch (e) { return null; } };
  const daysAgo = (ms) => (now.getTime() - ms) / 86400000;
  const day = (ms) => Utilities.formatDate(new Date(ms), 'America/Los_Angeles', 'MMM d');

  if (!places.length) {
    out.push('The script found no places. Check that the restaurant tab and its section headings ("To Try", "would recommend / want to return") still have exactly those names.');
  } else if (!places.some(p => p.section === 'try' && !p.added)) {
    out.push('The "To Try" heading wasn\'t found in the restaurant tab, so those places are missing. Check its spelling.');
  }

  const month = Utilities.formatDate(now, 'America/Los_Angeles', 'yyyy-MM');
  for (const sku of Object.keys(MONTHLY_LIMITS)) {
    const used = Number(props['usage:' + month + ':' + sku] || 0);
    if (used >= MONTHLY_LIMITS[sku]) out.push(SKU_LABELS[sku] + ' have hit this month\'s safety cap and are paused until next month.');
    else if (used >= 0.9 * MONTHLY_LIMITS[sku]) out.push(SKU_LABELS[sku] + ' are at ' + Math.round(100 * used / MONTHLY_LIMITS[sku]) + '% of this month\'s safety cap.');
  }

  const api = read('health:apiError');
  if (api && daysAgo(api.at) < 3) {
    out.push('Google refused a ' + api.service + ' request on ' + day(api.at) + ' (' + api.code + (api.msg ? ': ' + api.msg : '') +
      '). Check in Google Cloud that billing is active and the API key is still valid.');
  }

  const nightly = read('health:nightly');
  if (nightly && !nightly.ok) {
    out.push('The overnight update failed on ' + day(nightly.at) + ' (' + nightly.msg + ').');
  } else if (nightly && daysAgo(nightly.at) > 3) {
    out.push('The overnight update hasn\'t run since ' + day(nightly.at) + '. In Apps Script, open Triggers and check "nightlyFill" is still there; running "Fill missing info" from the Sheet\'s menu sets it up again.');
  }
  return out;
}

// ---------- Monthly refresh: hours, closures, new chain branches ----------

const REFRESH_AFTER_DAYS = 28; // each place is refreshed about once a month…
const REFRESH_PER_NIGHT = 40;  // …a few dozen a night, so it never bunches up

function refreshHoursNow() { refreshStale_(10, 0); }

/**
 * Refreshes up to `limit` places whose Google data is at least `minAgeDays` old,
 * oldest first. Single-location places are refreshed by their Google ID (Place
 * Details), which keeps the exact match and your ok/skip marks; chains are
 * searched again so new branches appear and closed ones drop off.
 */
function refreshStale_(limit, minAgeDays) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return notify_('Busy with another update. Try again in a few minutes.');
  let refreshed = 0, capped = false;
  try {
    const apiKey = PropertiesService.getScriptProperties().getProperty('MAPS_KEY');
    if (!apiKey) throw new Error('MAPS_KEY is missing from Script Properties.');
    const places = readAllPlaces_();
    const byKey = new Map(places.map(p => [p.key, p]));
    const data = readAppData_();
    const due = pickStale_(places, data, new Date(), minAgeDays, limit);

    for (let i = 0; i < due.length; i += BATCH) {
      const batch = due.slice(i, i + BATCH);
      const byId = batch.filter(r => r.locs.length === 1 && r.locs[0].id);
      const bySearch = batch.filter(r => !byId.includes(r));
      if ((byId.length && !spend_('placeDetails', byId.length)) ||
          (bySearch.length && !spend_('textSearch', bySearch.length))) { capped = true; break; }

      const t0 = Date.now();
      const res = UrlFetchApp.fetchAll(
        byId.map(r => detailsRequest_(r.locs[0].id, apiKey))
          .concat(bySearch.map(r => searchRequest_(byKey.get(r.key), apiKey))));
      watch_('hours refresh', res[0]);
      byId.forEach((r, j) => {
        data.set(r.key, refreshFromDetails_(r, res[j].getResponseCode(), res[j].getContentText()));
      });
      bySearch.forEach((r, j) => {
        const x = res[byId.length + j];
        data.set(r.key, refreshFromSearch_(r, toRecord_(byKey.get(r.key), x.getResponseCode(), x.getContentText())));
      });
      refreshed += batch.length;

      const wait = BATCH_INTERVAL_MS - (Date.now() - t0);
      if (wait > 0 && i + BATCH < due.length) Utilities.sleep(wait);
    }
    writeAppData_(data, places);
  } finally {
    lock.releaseLock();
  }
  notify_(`Refreshed hours for ${refreshed} places.` + (capped ? " Stopped at this month's safety cap." : ''));
}

function detailsRequest_(placeId, apiKey) {
  return {
    url: 'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId),
    method: 'get',
    muteHttpExceptions: true,
    // Same fields as Text Search, without its "places." prefix.
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACE_FIELDS.replace(/places\./g, '') },
  };
}

function ensureNightly_() {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'nightlyFill')) return;
  ScriptApp.newTrigger('nightlyFill').timeBased().everyDays(1).atHour(3).create();
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === handler)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function notify_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, 'Seattle Food & Bev', 15); } catch (e) { /* no UI in triggers */ }
}

// ---------- Travel times (walking + transit) ----------

const MAX_DESTINATIONS = 20; // the app sends ~15; this caps the cost of any one request

/**
 * from = "lat,lng"; to = "lat,lng|lat,lng|…"; when = optional departure time
 * (milliseconds since 1970) for planning ahead, so transit uses that time's schedule.
 * Returns { walk: [minutes|null…], transit: [...] } in the same order as `to`.
 * Walking and transit are fetched in parallel.
 */
function travelTimes_(from, to, when) {
  const origin = parseLatLng_(from);
  const dests = String(to || '').split('|').filter(Boolean).map(parseLatLng_);
  if (!origin || !dests.length || dests.length > MAX_DESTINATIONS || dests.some(d => !d)) {
    return { error: 'bad-request' };
  }
  const apiKey = PropertiesService.getScriptProperties().getProperty('MAPS_KEY');
  if (!apiKey) return { error: 'MAPS_KEY is missing from Script Properties.' };
  // Transit has the smaller allowance, so check it first.
  if (!spend_('matrixTransit', dests.length)) return { error: 'monthly-limit' };
  if (!spend_('matrixWalk', dests.length)) return { error: 'monthly-limit' };

  const depart = departureTime_(when, new Date());
  const answers = UrlFetchApp.fetchAll(['WALK', 'TRANSIT'].map(mode => matrixRequest_(origin, dests, mode, apiKey, depart)));
  watch_('travel time', answers[1]);
  const [walk, transit] = answers.map(res => parseMatrix_(res.getResponseCode(), res.getContentText(), dests.length));
  return { walk, transit };
}

function parseLatLng_(s) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(String(s || '').trim());
  return m ? { latitude: Number(m[1]), longitude: Number(m[2]) } : null;
}

/** A planned departure as an ISO time, or null for "now" (also for past or far-off times). */
function departureTime_(when, now) {
  const t = Number(when);
  if (!t || t < now.getTime() + 60000 || t > now.getTime() + 90 * 86400000) return null;
  return new Date(t).toISOString();
}

function matrixRequest_(origin, dests, mode, apiKey, depart) {
  const point = (ll) => ({ waypoint: { location: { latLng: ll } } });
  const body = { origins: [point(origin)], destinations: dests.map(point), travelMode: mode };
  if (depart && mode === 'TRANSIT') body.departureTime = depart; // walking doesn't depend on the time
  return {
    url: 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix',
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition' },
    payload: JSON.stringify(body),
  };
}

// ---------- "Near a place": turn typed text into a location ----------

/** q = "Capitol Hill" or an address. Returns { lat, lng, label } or { error }. */
function geocode_(q) {
  q = String(q || '').trim().slice(0, 200);
  if (!q) return { error: 'bad-request' };
  const apiKey = PropertiesService.getScriptProperties().getProperty('MAPS_KEY');
  if (!apiKey) return { error: 'MAPS_KEY is missing from Script Properties.' };
  if (!spend_('geocode', 1)) return { error: 'monthly-limit' };
  // "bounds" makes Google prefer matches around Puget Sound ("Capitol Hill" → Seattle's).
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(q) +
    '&bounds=47.2,-122.7%7C48.0,-121.9&region=us&key=' + apiKey;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const answer = parseGeocode_(res.getResponseCode(), res.getContentText());
  // Geocoding reports a refused request inside a normal answer, so record it by hand.
  if (answer.error && answer.error !== 'not-found') setHealth_('apiError', { service: 'typed-place lookup', code: answer.error, msg: '' });
  return answer;
}

function parseGeocode_(code, body) {
  if (code !== 200) return { error: 'geocode failed (' + code + ')' };
  const data = JSON.parse(body);
  if (data.status === 'ZERO_RESULTS') return { error: 'not-found' };
  if (data.status !== 'OK' || !data.results.length) return { error: 'geocode ' + data.status };
  const r = data.results[0];
  return { lat: r.geometry.location.lat, lng: r.geometry.location.lng, label: r.formatted_address };
}

/** Google's answer → minutes per destination (null where no route or an error). Pure, testable. */
function parseMatrix_(code, body, count) {
  const minutes = new Array(count).fill(null);
  if (code !== 200) return minutes;
  for (const el of JSON.parse(body)) {
    if (el.condition !== 'ROUTE_EXISTS' || !el.duration) continue;
    minutes[el.destinationIndex || 0] = Math.round(parseInt(el.duration, 10) / 60);
  }
  return minutes;
}

// ---------- Usage counter (hard monthly cap) ----------

/** Records n requests for a Google service; returns false (and records nothing) past the cap. */
function spend_(sku, n) {
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const props = PropertiesService.getScriptProperties();
    const used = Number(props.getProperty(usageKey_(sku)) || 0);
    if (used + n > MONTHLY_LIMITS[sku]) return false;
    props.setProperty(usageKey_(sku), String(used + n));
    return true;
  } finally {
    lock.releaseLock();
  }
}

function usageKey_(sku) { return 'usage:' + month_() + ':' + sku; }

// Google's free allowances reset monthly on Pacific time.
function month_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM'); }

// ---------- Reading the tab ----------

/** Every place the app shows: the human-edited tab, plus places added from the phone. */
function readAllPlaces_() {
  const main = readSourcePlaces_();
  return main.concat(parseAdded_(readAddedRows_(), new Set(main.map(p => p.key))));
}

function readAddedRows_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(ADDED_TAB);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, ADDED_HEADERS.length).getDisplayValues();
}

/**
 * Rows of the "added from app" tab → places in the "To Try" section. A place that
 * is also in the main tab is skipped here (the main tab wins), so copying a row
 * across by hand doesn't show it twice. Pure, testable.
 */
function parseAdded_(rows, taken) {
  const out = [];
  rows.forEach((r, i) => {
    const [name, menu, desc, hood, deals] = r.map(v => String(v || '').trim());
    const key = normKey_(name);
    if (!key || taken.has(key)) return;
    taken.add(key);
    out.push({
      key, name, section: 'try', row: 'added ' + (i + 2), desc, hood, deals,
      menu: /^https?:\/\//i.test(menu) ? menu : '', tags: [], fav: false, struck: false, added: true,
    });
  });
  return out;
}

function readSourcePlaces_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SOURCE_TAB);
  if (!sheet) throw new Error('No tab named "' + SOURCE_TAB + '"');
  const rows = sheet.getLastRow();
  const nameCol = sheet.getRange(1, 1, rows, 1);
  return parseSheet({
    values: sheet.getRange(1, 1, rows, COLS).getDisplayValues(),
    backgrounds: nameCol.getBackgrounds().map(r => r[0]),
    bold: nameCol.getFontWeights().map(r => r[0] === 'bold'),
    strike: nameCol.getFontLines().map(r => r[0] === 'line-through'),
    links: nameCol.getRichTextValues().map(r => linkIn_(r[0])),
  });
}

function linkIn_(richText) {
  if (!richText) return '';
  const run = richText.getRuns().find(r => r.getLinkUrl());
  return run ? run.getLinkUrl() : '';
}

/**
 * Turns the raw tab into a list of places. Pure function (no Google calls), so it
 * can also be tested outside Apps Script. Rules:
 *  - "would recommend…", "To Try", "AVOID" header rows set the section.
 *  - A bold row with only a name starts a group (e.g. a market or restaurant group); a blank row ends it.
 *  - Rows whose name is a URL are reference links, not places.
 *  - A green name cell marks a favorite.
 *  - AVOID places are dropped, including their duplicates in other sections.
 */
function parseSheet(d) {
  let section = null;
  let group = null;
  const byKey = new Map();

  for (let i = 1; i < d.values.length; i++) { // row 0 holds the column titles
    const [name, menu, desc, hood, deals] = d.values[i].slice(0, COLS).map(v => String(v || '').trim());
    if (!name) { group = null; continue; }

    const hasDetails = Boolean(menu || desc || hood || deals);
    const headerSection = SECTIONS[name.toLowerCase()];
    if (headerSection && !hasDetails) { section = headerSection; group = null; continue; }
    if (/^https?:\/\//i.test(name)) continue;
    if (d.bold[i] && !hasDetails) { group = name.split(' - ')[0].trim(); continue; }
    if (!section) continue;

    const place = {
      key: normKey_(name),
      name,
      section,
      row: i + 1,
      desc,
      hood,
      deals,
      menu: /^https?:\/\//i.test(menu) ? menu : (d.links[i] || ''),
      tags: group ? [group] : [],
      fav: isGreen_(d.backgrounds[i]),
      struck: Boolean(d.strike[i]),
    };

    const prev = byKey.get(place.key);
    if (!prev) { byKey.set(place.key, place); continue; }
    const winner = RANK[place.section] > RANK[prev.section] ? place : prev;
    const other = winner === place ? prev : place;
    winner.tags = [...new Set([...winner.tags, ...other.tags])];
    winner.fav = winner.fav || other.fav;
    for (const f of ['desc', 'hood', 'deals', 'menu']) if (!winner[f]) winner[f] = other[f];
    byKey.set(place.key, winner);
  }

  return [...byKey.values()].filter(p => p.section !== 'avoid');
}

/** "Café Olé " → "cafe ole": used to spot the same place listed twice. */
function normKey_(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** True for any greenish, non-white fill, e.g. Sheets' "light green 2/3". */
function isGreen_(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return false;
  const [r, g, b] = m.slice(1).map(x => parseInt(x, 16));
  return g > r + 10 && g > b + 10;
}

// ---------- Google lookup helpers (pure, testable) ----------

const PLACE_FIELDS = ['id', 'displayName', 'formattedAddress', 'location', 'primaryTypeDisplayName',
  'businessStatus', 'googleMapsUri', 'regularOpeningHours.periods', 'utcOffsetMinutes']
  .map(f => 'places.' + f).join(',');

/**
 * What to search for. A neighborhood like "capitol hill, ballard" or "several locs"
 * means a chain: search the name alone and keep every matching location.
 */
function buildQuery_(p) {
  const multi = /,|&|\band\b|several|others|more|varies|multiple|locs|locations/i.test(p.hood);
  const hint = multi ? '' : p.hood
    .replace(/[?()]/g, ' ')
    .replace(/\b(others?|more|etc)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  return { text: [p.name, hint].filter(Boolean).join(' '), multi };
}

function searchRequest_(p, apiKey) {
  const q = buildQuery_(p);
  return {
    url: 'https://places.googleapis.com/v1/places:searchText',
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACE_FIELDS },
    payload: JSON.stringify({
      textQuery: q.text,
      pageSize: q.multi ? 10 : 1,
      locationBias: { circle: { center: SEATTLE, radius: 50000 } },
    }),
  };
}

/** Turns one Google response into the record saved in the "app data" tab. */
function toRecord_(p, code, body) {
  if (code === 429) return { status: 'retry' }; // per-minute quota hit; try again next run
  const rec = { key: p.key, name: p.name, row: p.row, query: buildQuery_(p).text, at: today_(), locs: [] };
  if (code !== 200) return Object.assign(rec, { status: 'error ' + code });
  const found = (JSON.parse(body).places || []).filter(g => g.location);
  if (!found.length) return Object.assign(rec, { status: 'not found' });
  const matches = found.filter(g => namesMatch_(p.name, g.displayName && g.displayName.text));
  return Object.assign(rec, {
    status: matches.length ? 'ok' : 'check name',
    locs: (matches.length ? matches : found.slice(0, 1)).map(compactLoc_),
  });
}

function compactLoc_(g) {
  return {
    id: g.id,
    name: g.displayName ? g.displayName.text : '',
    addr: g.formattedAddress || '',
    lat: g.location.latitude,
    lng: g.location.longitude,
    cuisine: g.primaryTypeDisplayName ? g.primaryTypeDisplayName.text : '',
    status: g.businessStatus || '',
    maps: g.googleMapsUri || '',
    utc: g.utcOffsetMinutes,
    // Each period as [openDay, openHHMM, closeDay, closeHHMM]; days 0 = Sunday.
    hours: ((g.regularOpeningHours || {}).periods || []).map(x => [
      ...(x.open ? [x.open.day, x.open.hour * 100 + (x.open.minute || 0)] : []),
      ...(x.close ? [x.close.day, x.close.hour * 100 + (x.close.minute || 0)] : []),
    ]),
  };
}

// Words too generic to prove two names are the same place.
const GENERIC_WORDS = new Set(['the', 'and', 'cafe', 'bar', 'restaurant', 'seattle', 'kitchen',
  'grill', 'house', 'eatery', 'bistro', 'shop', 'company']);

function nameTokens_(s) {
  return normKey_(s || '').split(' ').filter(t => t.length >= 3 && !GENERIC_WORDS.has(t));
}

/**
 * True if Google's name plausibly is ours:
 *  - Google's name starts with ours, ignoring spaces and punctuation, at a word
 *    boundary ("zu zu" ≈ "Zu Zu Kitchen", "qaz" ≈ "qa'z Seattle", but "mira" ≠ "Miracle Diner"), or
 *  - they share a distinctive word ("joes" ≈ "Joe's Noodle Shack"), allowing one typo
 *    ("bellatrixa" ≈ "Belatrixa").
 */
function namesMatch_(ours, theirs) {
  const compact = normKey_(ours).replace(/ /g, '');
  let prefix = '';
  for (const word of normKey_(theirs || '').split(' ')) {
    prefix += word;
    if (prefix === compact) return true;
    if (prefix.length >= compact.length) break;
  }
  const a = nameTokens_(ours);
  const b = nameTokens_(theirs);
  return a.some(t => b.some(u => wordsMatch_(t, u)));
}

/** "harry" ≈ "harrys", "tacos" ≈ "taco", one typo allowed; but "mira" ≠ "miracle". */
function wordsMatch_(t, u) {
  const [short, long] = t.length <= u.length ? [t, u] : [u, t];
  if (long.startsWith(short) && long.length - short.length <= 2) return true;
  return long.length >= 4 && withinOneEdit_(short, long);
}

/** True if two words differ by at most one inserted, deleted, or changed letter. */
function withinOneEdit_(s, t) {
  if (Math.abs(s.length - t.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < s.length && j < t.length) {
    if (s[i] === t[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (s.length > t.length) i++;
    else if (t.length > s.length) j++;
    else { i++; j++; }
  }
  return edits + (s.length - i) + (t.length - j) <= 1;
}

function overallStatus_(locs) {
  if (!locs.length) return '';
  if (locs.every(l => l.status === 'CLOSED_PERMANENTLY')) return 'closed permanently';
  if (locs.every(l => l.status !== 'OPERATIONAL')) return 'closed temporarily';
  return 'open';
}

/** Matched places whose data is at least minAgeDays old, oldest first (unreadable dates count as oldest). */
function pickStale_(places, data, now, minAgeDays, limit) {
  const time = (r) => { const t = new Date(r.at).getTime(); return isNaN(t) ? 0 : t; };
  return places.map(p => data.get(p.key))
    .filter(r => r && r.locs.length && /^(ok|check name)$/.test(r.status) &&
      (now.getTime() - time(r)) / 86400000 >= minAgeDays)
    .sort((a, b) => time(a) - time(b))
    .slice(0, limit);
}

/** Place Details answer → refreshed record. Keeps the status (including your "ok"). */
function refreshFromDetails_(rec, code, body) {
  if (code === 404) return Object.assign({}, rec, { status: 'error 404' }); // ID retired: search again tonight
  if (code !== 200) return rec;                                            // try again another night
  const g = JSON.parse(body);
  if (!g.location) return rec;
  return Object.assign({}, rec, { locs: [compactLoc_(g)], at: today_() });
}

/** Chain re-search → refreshed record; keeps the old data if the search failed. */
function refreshFromSearch_(old, fresh) {
  if (fresh.status === 'retry' || /^error/.test(fresh.status)) return old;
  if (fresh.status === 'not found') return Object.assign({}, old, { at: today_() });
  if (old.status === 'ok' && fresh.status === 'check name') fresh.status = 'ok'; // you'd approved it
  return carryVisit_(fresh, old);
}

// ---------- Add a place from the phone ----------

const ADDED_HEADERS = ['Name', 'menu/website', 'description', 'neighborhood', 'deals?', 'Added'];

/** q = a restaurant name (optionally with a neighborhood). Returns up to 5 Google matches to choose from. */
function findPlaces_(q) {
  q = String(q || '').trim().slice(0, 120);
  if (!q) return { error: 'bad-request' };
  const apiKey = PropertiesService.getScriptProperties().getProperty('MAPS_KEY');
  if (!apiKey) return { error: 'MAPS_KEY is missing from Script Properties.' };
  if (!spend_('textSearch', 1)) return { error: 'monthly-limit' };
  const res = UrlFetchApp.fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': PLACE_FIELDS },
    payload: JSON.stringify({ textQuery: q, pageSize: 5, locationBias: { circle: { center: SEATTLE, radius: 50000 } } }),
  });
  watch_('place search', res);
  if (res.getResponseCode() !== 200) return { error: 'search failed (' + res.getResponseCode() + ')' };
  const found = (JSON.parse(res.getContentText()).places || []).filter(g => g.location);
  return { candidates: found.map(compactLoc_) };
}

/**
 * Adds one row to the "added from app" tab (never the main tab). If the phone
 * sent the Google match the user picked, it's saved too, so no second lookup is needed.
 */
function addPlace_(body) {
  const clip = (x, n) => String(x || '').trim().slice(0, n);
  const name = clip(body.name, 120);
  const key = normKey_(name);
  if (!key) return { error: 'bad-request' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: 'busy' };
  try {
    if (readAllPlaces_().some(p => p.key === key)) return { error: 'already-listed' };
    const ss = SpreadsheetApp.getActive();
    let sheet = ss.getSheetByName(ADDED_TAB);
    if (!sheet) {
      sheet = ss.insertSheet(ADDED_TAB);
      sheet.getRange(1, 1, 1, ADDED_HEADERS.length).setValues([ADDED_HEADERS]).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    const hood = clip(body.hood, 120);
    sheet.appendRow([name, clip(body.menu, 300), clip(body.desc, 300), hood, clip(body.deals, 300), today_()].map(safeCell_));

    const loc = cleanLoc_(body.loc);
    if (loc) {
      const data = readAppData_();
      data.set(key, { key, name, row: 'added', status: 'ok', query: buildQuery_({ name, hood }).text, at: today_(), locs: [loc] });
      writeAppData_(data, readAllPlaces_());
    }
    return { ok: true, key };
  } finally {
    lock.releaseLock();
  }
}

/** Text starting with = + - @ would be run as a formula by Sheets; a leading apostrophe keeps it as text. */
function safeCell_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

/** The Google match sent back by the phone, reduced to the known fields with sane types (or null). */
function cleanLoc_(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const lat = Number(loc.lat), lng = Number(loc.lng);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const text = (x, n) => String(x || '').slice(0, n);
  const hours = Array.isArray(loc.hours)
    ? loc.hours.filter(h => Array.isArray(h) && h.length <= 4 && h.every(n => Number.isInteger(n))).slice(0, 30) : [];
  return {
    id: text(loc.id, 200), name: text(loc.name, 200), addr: text(loc.addr, 300), lat, lng,
    cuisine: text(loc.cuisine, 100), status: text(loc.status, 40), maps: /^https:\/\//.test(loc.maps) ? text(loc.maps, 300) : '',
    utc: Number(loc.utc) || 0, hours,
  };
}

// ---------- Mark visited ----------

const VERDICTS = ['Loved', 'Good', 'Meh'];

function saveVisit_(body) {
  // A long lookup or refresh run rewrites the whole tab, so wait for it rather than race it.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: 'busy' };
  try {
    const places = readAllPlaces_();
    const place = places.find(p => p.key === body.place);
    if (!place) return { error: 'no-such-place' };
    const data = readAppData_();
    const rec = data.get(place.key) ||
      { key: place.key, name: place.name, row: place.row, status: '', query: '', at: '', locs: [] };
    data.set(place.key, applyVisit_(rec, body, today_()));
    writeAppData_(data, places);
    return { ok: true, visit: visitOf_(data.get(place.key)) };
  } finally {
    lock.releaseLock();
  }
}

/** Sets (or, with no verdict, clears) the visit on a record. The first visit date is kept on edits. */
function applyVisit_(rec, body, today) {
  const clip = (x) => String(x || '').trim().slice(0, 500);
  if (!VERDICTS.includes(body.verdict)) {
    return Object.assign({}, rec, { visited: '', verdict: '', dealsSeen: '', visitNotes: '' });
  }
  return Object.assign({}, rec, {
    visited: rec.visited || today, verdict: body.verdict, dealsSeen: clip(body.deals), visitNotes: clip(body.notes),
  });
}

/** The visit as the app sees it, or null. Sheets turns typed dates into Date objects; send text. */
function visitOf_(rec) {
  if (!rec || !rec.verdict) return null;
  const date = rec.visited instanceof Date
    ? Utilities.formatDate(rec.visited, 'America/Los_Angeles', 'yyyy-MM-dd') : String(rec.visited || '');
  return { date, verdict: rec.verdict, deals: rec.dealsSeen || '', notes: rec.visitNotes || '' };
}

/** A fresh Google lookup replaces a record; keep the visit that was on the old one. */
function carryVisit_(fresh, old) {
  if (!old || fresh.status === 'retry') return fresh;
  return Object.assign(fresh, {
    visited: old.visited || '', verdict: old.verdict || '', dealsSeen: old.dealsSeen || '', visitNotes: old.visitNotes || '',
    edits: old.edits || {},
  });
}

// ---------- Edit a place's notes from the app ----------
// Edits never touch the restaurant tab. Each is stored in "app data" with the Sheet
// text it replaced ({ was, now }); if someone later changes that cell in the Sheet,
// "was" no longer matches and the Sheet's text wins.

const EDITABLE = ['desc', 'deals'];

function saveEdit_(body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: 'busy' };
  try {
    const places = readAllPlaces_();
    const place = places.find(p => p.key === body.place);
    if (!place) return { error: 'no-such-place' };
    const data = readAppData_();
    const rec = data.get(place.key) ||
      { key: place.key, name: place.name, row: place.row, status: '', query: '', at: '', locs: [] };
    data.set(place.key, applyEdit_(rec, place, body));
    writeAppData_(data, places);
    const shown = withAppData_([Object.assign({}, place)], data)[0];
    return { ok: true, desc: shown.desc, deals: shown.deals, edited: shown.edited };
  } finally {
    lock.releaseLock();
  }
}

/** New edits for a record. Setting a field back to the Sheet's text removes that edit. Pure, testable. */
function applyEdit_(rec, place, body) {
  const edits = Object.assign({}, rec.edits || {});
  for (const f of EDITABLE) {
    if (!(f in body)) continue;
    const now = String(body[f] == null ? '' : body[f]).trim().slice(0, 500);
    if (now === place[f]) delete edits[f];
    else edits[f] = { was: place[f], now };
  }
  return Object.assign({}, rec, { edits });
}

function needsLookup_(p, rec) {
  return !rec || /^error/.test(rec.status) || rec.query !== buildQuery_(p).text;
}

/**
 * Statuses you can type into the "app data" tab yourself:
 *  ok   = the Google match is right (stop flagging it)
 *  skip = not a single place (a restaurant group, a roaming food truck): no location in the app
 */
const MANUAL_STATUSES = ['ok', 'skip'];

/** Free re-check of yellow rows with the current matching rules (no Google calls). */
function recheckNames_(data) {
  let upgraded = 0;
  data.forEach(r => {
    if (r.status === 'check name' && r.locs[0] && namesMatch_(r.name, r.locs[0].name)) {
      r.status = 'ok';
      upgraded++;
    }
  });
  return upgraded;
}

/** Adds Google data to each place for the app (closed locations dropped). */
function withAppData_(places, data) {
  return places.map(p => {
    const rec = data.get(p.key);
    const locs = rec && rec.status !== 'skip' ? rec.locs : [];
    // App edits replace the Sheet's text only while the Sheet still says what was edited.
    const edited = {};
    for (const f of EDITABLE) {
      const e = rec && rec.edits && rec.edits[f];
      if (e && e.was === p[f]) edited[f] = { sheet: p[f], now: e.now };
    }
    return Object.assign(p, {
      desc: edited.desc ? edited.desc.now : p.desc,
      deals: edited.deals ? edited.deals.now : p.deals,
      edited: Object.keys(edited).length ? edited : null,
      cuisine: locs[0] ? locs[0].cuisine : '',
      closed: overallStatus_(locs),
      locs: locs.filter(l => l.status !== 'CLOSED_PERMANENTLY')
        .map(l => ({ lat: l.lat, lng: l.lng, addr: l.addr, maps: l.maps, hours: l.hours || [] })),
      visit: visitOf_(rec),
      pending: needsLookup_(p, rec), // not looked up on Google yet (new row, or its name/neighborhood changed)
      added: Boolean(p.added),       // came from the "added from app" tab
    });
  });
}

function today_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'); }

// ---------- The "app data" tab ----------

// Visit columns sit next to the place name so they're easy to read; the long
// JSON column stays last. Columns are found by header name, so an older tab
// (different order, fewer columns) still reads correctly.
const DATA_HEADERS = ['key', 'Your name', 'Sheet row', 'Status', 'Visited', 'Verdict', 'Deals seen',
  'Visit notes', 'Edits (JSON)', 'Google name', 'Address', 'Locations', 'Cuisine (Google)', 'Open/closed',
  'Searched for', 'Last updated', 'data (JSON)'];
const STATUS_COLORS = { 'not found': '#f4cccc', 'check name': '#fff2cc', 'skip': '#efefef' };

function readAppData_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(DATA_TAB);
  if (!sheet || sheet.getLastRow() < 2) return new Map();
  const values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
  return rowsToData_(values[0], values.slice(1));
}

/** Tab rows → Map of records, using the header row to find each column. Pure, testable. */
function rowsToData_(header, rows) {
  const col = (name) => header.indexOf(name);
  const c = {
    key: col('key'), name: col('Your name'), row: col('Sheet row'), status: col('Status'),
    visited: col('Visited'), verdict: col('Verdict'), dealsSeen: col('Deals seen'), visitNotes: col('Visit notes'),
    query: col('Searched for'), json: col('data (JSON)'), edits: col('Edits (JSON)'),
    at: Math.max(col('Last updated'), col('Looked up')), // older tabs called it "Looked up"
  };
  const get = (r, i) => (i < 0 || r[i] == null ? '' : r[i]);
  // What someone typed in the app, as text. Older tabs let Sheets turn "5-6" into
  // a date (May 6); turn that back. A leading apostrophe left by safeCell_ is dropped.
  const typedText = (v) => (v instanceof Date ? (v.getMonth() + 1) + '-' + v.getDate() : String(v)).replace(/^'(?=[=+\-@])/, '');
  // Older tabs let Sheets turn "2026-10-02" into a date too. Everything is written
  // back as text, so read those as the text they were.
  const dateText = (v) => (v instanceof Date ? Utilities.formatDate(v, 'America/Los_Angeles', 'yyyy-MM-dd') : v);
  const map = new Map();
  for (const r of rows) {
    const key = String(get(r, c.key)); // a name like "1984" must not come back as a number
    if (!key) continue;
    let locs = [];
    try { locs = JSON.parse(get(r, c.json) || '[]'); } catch (e) { /* hand-edited cell; look it up again */ }
    // Accept hand-typed statuses in any case ("OK", " Skip").
    const typed = String(get(r, c.status)).trim().toLowerCase();
    map.set(key, {
      key, name: typedText(get(r, c.name)), row: get(r, c.row),
      status: MANUAL_STATUSES.includes(typed) ? typed : get(r, c.status),
      query: typedText(get(r, c.query)), at: dateText(get(r, c.at)), locs,
      visited: dateText(get(r, c.visited)), verdict: get(r, c.verdict),
      dealsSeen: typedText(get(r, c.dealsSeen)), visitNotes: typedText(get(r, c.visitNotes)),
      edits: parseEdits_(get(r, c.edits)),
    });
  }
  return map;
}

function parseEdits_(text) {
  try { const e = JSON.parse(text || '{}'); return e && typeof e === 'object' ? e : {}; } catch (err) { return {}; }
}

const NOT_LISTED = 'not in the list';

/** True if a record holds something a person entered in the app (a visit or an edit). */
function hasYourNotes_(r) {
  return Boolean(r.verdict || r.visited || r.dealsSeen || r.visitNotes || (r.edits && Object.keys(r.edits).length));
}

/**
 * Records → tab rows in sheet order, plus each row's status color. Pure, testable.
 * A place that is no longer in the list (renamed, removed, moved to AVOID, or
 * hidden because a section heading was mistyped) loses its Google data, which can
 * be looked up again, but a visit or edit made in the app can't be: those rows are
 * kept at the bottom, and are picked up again if the place comes back.
 */
function dataToRows_(data, places) {
  const rows = [];
  const colors = [];
  const add = (r, name, row) => {
    const first = r.locs[0] || {};
    rows.push([r.key, name, row, r.status, r.visited || '', r.verdict || '', r.dealsSeen || '',
      r.visitNotes || '', r.edits && Object.keys(r.edits).length ? JSON.stringify(r.edits) : '', first.name || '', first.addr || '', r.locs.length, first.cuisine || '',
      overallStatus_(r.locs), r.query, r.at, JSON.stringify(r.locs)].map(safeCell_));
    colors.push(STATUS_COLORS[r.status] || null);
  };
  const listed = new Set();
  for (const p of places) {
    const r = data.get(p.key);
    if (!r || listed.has(p.key)) continue;
    listed.add(p.key);
    add(r, p.name, p.row);
  }
  data.forEach(r => { if (!listed.has(r.key) && hasYourNotes_(r)) add(r, r.name, NOT_LISTED); });
  return { rows, colors };
}

/**
 * Rewrites the tab in sheet order. The new rows are written over the old ones and
 * only then is anything left over cleared, so the tab is never empty part-way
 * through (a phone loading the list at that moment would see no locations, and a
 * failed run would lose every visit).
 */
function writeAppData_(data, places) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DATA_TAB) || ss.insertSheet(DATA_TAB);
  const { rows, colors } = dataToRows_(data, places);
  const width = DATA_HEADERS.length;
  const all = [DATA_HEADERS].concat(rows);
  const statusCol = DATA_HEADERS.indexOf('Status') + 1;
  const hadRows = sheet.getLastRow();
  const hadCols = sheet.getLastColumn();
  if (sheet.getMaxRows() < all.length) sheet.insertRowsAfter(sheet.getMaxRows(), all.length - sheet.getMaxRows());
  if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());

  // Plain-text cells keep what was typed: "5-6" stays "5-6" (not May 6), "1984" stays text.
  sheet.getRange(1, 1, all.length, width).setNumberFormat('@').setValues(all);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (hadRows > all.length) sheet.getRange(all.length + 1, 1, hadRows - all.length, Math.max(hadCols, width)).clearContent();
  if (hadCols > width) sheet.getRange(1, width + 1, all.length, hadCols - width).clearContent(); // an older, wider layout

  // The status colors may sit in a different column than before, so clear the whole body first.
  if (sheet.getMaxRows() > 1) sheet.getRange(2, 1, sheet.getMaxRows() - 1, sheet.getMaxColumns()).setBackground(null);
  if (rows.length) sheet.getRange(2, statusCol, rows.length, 1).setBackgrounds(colors.map(c => [c]));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
