/**
 * Nearby Eats: backend script that lives inside the Google Sheet
 * (Extensions → Apps Script). It reads the restaurant tab and serves it to the
 * app as JSON. The secret key lives in Script Properties, never in this file.
 */

const SOURCE_TAB = 'Seattle dining';
const COLS = 5; // Name, menu/website, description, neighborhood, deals?

// Section header text (lowercase) → section id.
const SECTIONS = {
  'would recommend / want to return': 'recommend',
  'avoid': 'avoid',
  'to try': 'try',
};

// When a place is listed twice, the higher rank wins (AVOID beats everything).
const RANK = { try: 1, recommend: 2, avoid: 3 };

// ---------- Web endpoint ----------

function doGet(e) {
  const key = PropertiesService.getScriptProperties().getProperty('KEY');
  if (!key || !e || e.parameter.key !== key) return json_({ error: 'bad-key' });
  try {
    return json_({ places: readPlaces_(), loadedAt: new Date().toISOString() });
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
  Logger.log('Places found: ' + readPlaces_().length);
}

/** Run if the key ever leaks: the old key stops working, then run showAppSetup. */
function resetKey() {
  PropertiesService.getScriptProperties().deleteProperty('KEY');
  Logger.log('Key deleted. Run showAppSetup to make a new one, then re-enter it in the app.');
}

// ---------- Reading the tab ----------

function readPlaces_() {
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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
