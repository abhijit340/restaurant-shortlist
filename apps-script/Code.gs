/**
 * Seattle Food & Bev: backend script that lives inside the Google Sheet
 * (Extensions → Apps Script). It reads the restaurant tab, looks places up on
 * Google, and serves everything to the app as JSON. Secrets (the app key and
 * MAPS_KEY) live in Script Properties, never in this file.
 */

const SOURCE_TAB = 'Seattle dining';
const DATA_TAB = 'app data'; // managed by this script; the source tab is never written
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
    return json_({
      places: withAppData_(readSourcePlaces_(), readAppData_()),
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
  Logger.log('Places found: ' + readSourcePlaces_().length);
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

    places = readSourcePlaces_();
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
    const places = readSourcePlaces_();
    const data = readAppData_();
    const waiting = (list) => list.filter(p => needsLookup_(p, data.get(p.key)));
    const now = waiting(places).slice(0, max);
    if (now.length) {
      if (!spend_('textSearch', now.length)) return { error: 'monthly-limit' };
      for (let i = 0; i < now.length; i += BATCH) {
        const batch = now.slice(i, i + BATCH);
        const res = UrlFetchApp.fetchAll(batch.map(p => searchRequest_(p, apiKey)));
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
  fillMissing();
  refreshStale_(REFRESH_PER_NIGHT, REFRESH_AFTER_DAYS);
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
    const places = readSourcePlaces_();
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
  const [walk, transit] = UrlFetchApp.fetchAll(['WALK', 'TRANSIT'].map(mode => matrixRequest_(origin, dests, mode, apiKey, depart)))
    .map(res => parseMatrix_(res.getResponseCode(), res.getContentText(), dests.length));
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
  return parseGeocode_(res.getResponseCode(), res.getContentText());
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

// ---------- Mark visited ----------

const VERDICTS = ['Loved', 'Good', 'Meh'];

function saveVisit_(body) {
  // A long lookup or refresh run rewrites the whole tab, so wait for it rather than race it.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { error: 'busy' };
  try {
    const places = readSourcePlaces_();
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
  });
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
    return Object.assign(p, {
      cuisine: locs[0] ? locs[0].cuisine : '',
      closed: overallStatus_(locs),
      locs: locs.filter(l => l.status !== 'CLOSED_PERMANENTLY')
        .map(l => ({ lat: l.lat, lng: l.lng, addr: l.addr, maps: l.maps, hours: l.hours || [] })),
      visit: visitOf_(rec),
      pending: needsLookup_(p, rec), // not looked up on Google yet (new row, or its name/neighborhood changed)
    });
  });
}

function today_() { return Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd'); }

// ---------- The "app data" tab ----------

// Visit columns sit next to the place name so they're easy to read; the long
// JSON column stays last. Columns are found by header name, so an older tab
// (different order, fewer columns) still reads correctly.
const DATA_HEADERS = ['key', 'Your name', 'Sheet row', 'Status', 'Visited', 'Verdict', 'Deals seen',
  'Visit notes', 'Google name', 'Address', 'Locations', 'Cuisine (Google)', 'Open/closed',
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
    query: col('Searched for'), json: col('data (JSON)'),
    at: Math.max(col('Last updated'), col('Looked up')), // older tabs called it "Looked up"
  };
  const get = (r, i) => (i < 0 || r[i] == null ? '' : r[i]);
  const map = new Map();
  for (const r of rows) {
    const key = get(r, c.key);
    if (!key) continue;
    let locs = [];
    try { locs = JSON.parse(get(r, c.json) || '[]'); } catch (e) { /* hand-edited cell; look it up again */ }
    // Accept hand-typed statuses in any case ("OK", " Skip").
    const typed = String(get(r, c.status)).trim().toLowerCase();
    map.set(key, {
      key, name: get(r, c.name), row: get(r, c.row),
      status: MANUAL_STATUSES.includes(typed) ? typed : get(r, c.status),
      query: get(r, c.query), at: get(r, c.at), locs,
      visited: get(r, c.visited), verdict: get(r, c.verdict),
      dealsSeen: get(r, c.dealsSeen), visitNotes: get(r, c.visitNotes),
    });
  }
  return map;
}

/** Records → tab rows in sheet order, plus each row's status color. Pure, testable. */
function dataToRows_(data, places) {
  const rows = [];
  const colors = [];
  for (const p of places) {
    const r = data.get(p.key);
    if (!r) continue;
    const first = r.locs[0] || {};
    rows.push([r.key, p.name, p.row, r.status, r.visited || '', r.verdict || '', r.dealsSeen || '',
      r.visitNotes || '', first.name || '', first.addr || '', r.locs.length, first.cuisine || '',
      overallStatus_(r.locs), r.query, r.at, JSON.stringify(r.locs)]);
    colors.push(STATUS_COLORS[r.status] || null);
  }
  return { rows, colors };
}

/** Rewrites the tab in sheet order. Places no longer in the list (or moved to AVOID) drop off. */
function writeAppData_(data, places) {
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(DATA_TAB) || ss.insertSheet(DATA_TAB);
  const { rows, colors } = dataToRows_(data, places);
  const statusCol = DATA_HEADERS.indexOf('Status') + 1;
  sheet.clearContents();
  sheet.getRange(1, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (!rows.length) return;
  sheet.getRange(2, 1, rows.length, DATA_HEADERS.length).setValues(rows);
  // The status colors may sit in a different column than before, so clear the whole body first.
  sheet.getRange(2, 1, sheet.getMaxRows() - 1, sheet.getMaxColumns()).setBackground(null);
  sheet.getRange(2, statusCol, rows.length, 1).setBackgrounds(colors.map(c => [c]));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
