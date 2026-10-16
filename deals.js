/**
 * Reads the free-text "deals?" column into weekly time windows.
 *
 *   "hh tu-th 3-4:45, sat-sun 1-2"   → Tue–Thu 3:00–4:45 PM, Sat–Sun 1–2 PM
 *   "daily 5-6, 9-close"             → every day 5–6 PM and 9 PM–closing
 *   "$1 tacos tuesdays"              → a Tuesday special (no times)
 *
 * Rules (restaurant happy hours are afternoons/evenings):
 *  - Bare hours are PM ("4-6" = 4–6 PM); 12 is noon; "11-12" = 11 PM–midnight.
 *  - No days given = daily. A clause with only times takes the days of the
 *    clause before it ("HH m-f 4-5, 8-9" = both Mon–Fri).
 *  - A clause with only days, followed by a clause with only times, pairs up
 *    ("tues-sat, 4-6"); otherwise it's an all-day special that day.
 *
 * parseDeals(text) → { windows: [{ days, start, end, kind, text }], vagueHH, understood }
 *   days: [0–6], 0 = Sunday. start/end: minutes after midnight; end may be
 *   "close". kind: "hh" (has times) or "special" (day only, no times).
 */
(function (root) {
  const DAY = {
    su: 0, sun: 0, sunday: 0, sundays: 0,
    m: 1, mo: 1, mon: 1, monday: 1, mondays: 1,
    tu: 2, tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
    w: 3, we: 3, wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
    th: 4, thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
    f: 5, fr: 5, fri: 5, friday: 5, fridays: 5,
    sa: 6, sat: 6, saturday: 6, saturdays: 6,
  };
  const ALL = [0, 1, 2, 3, 4, 5, 6];
  const DAY_WORD = Object.keys(DAY).sort((a, b) => b.length - a.length).join("|");

  // "sun-thurs" → [0..4]; wraps across the week ("tue-sun" → 2..6, 0).
  function dayRange(a, b) {
    const out = [];
    for (let d = DAY[a]; ; d = (d + 1) % 7) { out.push(d); if (d === DAY[b] || out.length > 7) break; }
    return out;
  }

  // "mwth" → [1, 3, 4]: run-together single/double-letter day codes.
  function compactDays(word) {
    const codes = ["th", "sa", "su", "m", "t", "w", "f"];
    const map = { th: 4, sa: 6, su: 0, m: 1, t: 2, w: 3, f: 5 };
    const out = [];
    let rest = word;
    while (rest) {
      const c = codes.find((x) => rest.startsWith(x));
      if (!c) return null;
      out.push(map[c]);
      rest = rest.slice(c.length);
    }
    // A day can't repeat, so "mmm" isn't Monday three times.
    return out.length >= 2 && new Set(out).size === out.length ? out : null;
  }

  // "except mon", "no hh on sundays", "closed tue-wed", "but not mon", "not valid on fri":
  // the days after it (up to the first time, a "." or "/" break, or a fresh "hh") are left out.
  // A bare "but" is handled in findDays.
  const EXCEPT = new RegExp(`\\b(?:except|excluding|no|not|closed)\\b(?:\\s+(?:on|hh|happy hours?|deals?|specials?|available|valid|offered|served|during))*\\s+(?=(?:${DAY_WORD}|weekdays?|weekends?)\\b)(?:(?!\\d|[./]|\\s[-–]\\s|\\b(?:all day|after|until|hh|happy hours?)\\b).)*`);

  // A clause that is nothing but days ("sat", "sat & sun", "on wed").
  const DAYS_ONLY = new RegExp(`^(?:[\\s&/–-]|\\b(?:on|thru|through|to|weekends?|weekdays?|${DAY_WORD})\\b)*$`);

  /** All the days mentioned in a clause, or null. Only exclusions ("except mon") = daily minus those. */
  function findDays(s) {
    let excluded = null;
    // "every day but mon 4-6" = except; in "4-6 daily, but fri 3-6" Friday's own time is a clause of its own.
    const but = /\bbut\b/.exec(s), pre = but && s.slice(0, but.index);
    if (but && !findTimes(pre).length && findDays(pre)) s = `${pre}except${s.slice(but.index + 3)}`;
    s = s.replace(EXCEPT, (rest) => { excluded = findDays(rest.replace(/\b(?:except|excluding|no|not|closed)\b/g, " ")); return " "; });
    const days = new Set();
    let found = false;
    const add = (list) => { list.forEach((d) => days.add(d)); found = true; };
    if (/\b(daily|every ?day|all week)\b/.test(s)) add(ALL);
    if (/\bweekdays?\b/.test(s)) add([1, 2, 3, 4, 5]);
    if (/\bweekends?\b/.test(s)) add([0, 6]);
    // Ranges first ("m-f", "sun-thurs"), then remove them so their ends aren't re-read.
    s = s.replace(new RegExp(`\\b(${DAY_WORD})\\s*(?:[-–]|\\b(?:thru|through|to)\\b)\\s*(${DAY_WORD})\\b`, "g"), (_, a, b) => { add(dayRange(a, b)); return " "; });
    for (const word of s.split(/[^a-z]+/)) {
      // "we" on its own is the word, not Wednesday ("we-fr" is still read as a range above).
      if (word in DAY && word !== "we") add([DAY[word]]);
      else if (/^[mtwfsuha]{3,6}$/.test(word)) { const c = compactDays(word); if (c) add(c); }
    }
    if (!excluded) return found ? [...days].sort() : null;
    const out = (found ? [...days].sort() : ALL).filter((d) => !excluded.includes(d));
    if (!found) out.onlyExcept = excluded; // e.g. a lone "except sundays" clause
    return out;
  }

  // Hour (+ optional minutes, am/pm) → minutes after midnight, afternoon-biased.
  function toMinutes(h, m, ampm) {
    h = Number(h); m = Number(m || 0);
    if (ampm === "am") h = h === 12 ? 0 : h;
    else if (ampm === "pm") h = h === 12 ? 12 : h + 12;
    else if (h >= 1 && h <= 11) h += 12;
    return h * 60 + m;
  }

  /** All the time windows in a clause: [{ start, end }]. */
  function findTimes(s) {
    const out = [];
    const T = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?";
    const re = new RegExp(`(?:^|[^$\\d.:/])${T}\\s*(?:[-–—]|to\\b)\\s*(?:${T}|(close))`, "g");
    let m;
    while ((m = re.exec(s))) {
      const endAmPm = m[6];
      const startAmPm = m[3] || (endAmPm === "pm" && Number(m[1]) < 12 ? "pm" : undefined);
      const start = toMinutes(m[1], m[2], startAmPm);
      let end = m[7] ? "close" : toMinutes(m[4], m[5], endAmPm);
      if (end !== "close" && end <= start) end += 12 * 60; // "11-12" → 11 PM–midnight
      if (end !== "close" && end <= start) end += 12 * 60; // "10pm-2am" → past midnight
      out.push({ start, end });
    }
    const after = /\bafter (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s);
    if (after) out.push({ start: toMinutes(after[1], after[2], after[3]), end: "close" });
    const until = /\buntil (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(s);
    if (until && !out.length) out.push({ start: null, end: toMinutes(until[1], until[2], until[3]) });
    if (/\ball day\b/.test(s)) out.push({ start: 0, end: 24 * 60 });
    return out;
  }

  /** Sheets sometimes turns "5-6" into a date (5/6/2025 or 2025-05-06); turn it back. */
  function undoDate(text) {
    let m = /^\d{4}-(\d{2})-(\d{2})(?: 00:00:00)?$/.exec(text);
    if (m) return `${Number(m[1])}-${Number(m[2])}`;
    m = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/.exec(text);
    if (m) return `${m[1]}-${m[2]}`;
    return text;
  }

  function parseDeals(raw) {
    const text = undoDate(String(raw || "").trim());
    const s = text.toLowerCase()
      .replace(/\b([ap])\.m\.?/g, "$1m")     // "p.m." → "pm" (its "m" isn't Monday)
      .replace(/(\d)\s*([ap])\b/g, "$1$2m")  // "4p-6p" → "4pm-6pm"
      .replace(/\bw\//g, "with ")            // "w/ food" isn't Wednesday
      // "mon and tue 4-6" / "except mon and tue" is one day list, not two clauses; but
      // "3-6 m-f and sat 12-3" / "3-6 except sat and sun 12-3" are two (both sides have a time).
      .replace(new RegExp(`\\b(${DAY_WORD}) and (?=(?:${DAY_WORD})\\b)`, "g"), (m, a, at, str) => {
        const before = str.slice(0, at).split(/[;,]|\band\b/).pop() + a;
        const after = str.slice(at + m.length).split(/[;,]|\band\b/)[0];
        return !findTimes(before).length || (EXCEPT.test(before) && !findTimes(after).length) ? `${a} & ` : m;
      });
    // Clauses, each remembering whether "and" (not a comma) came right before it.
    const parts = s.split(/([;,]|\band\b)/);
    const clauses = [], andBefore = [];
    parts.forEach((p, i) => {
      if (i % 2 || !p.trim()) return;
      // "hh 4-6 m-f except fri 3-5", "hh 4-6 except sun all day": the left-out day has its
      // own time, so it becomes a clause of its own ("…except fri" + "fri 3-5").
      const ex = EXCEPT.exec(p), end = ex && ex.index + ex[0].length;
      if (ex && findTimes(p.slice(0, ex.index)).length && findTimes(p.slice(end)).length) {
        clauses.push(p.slice(0, end).trim(), (ex[0].replace(/\b(?:except|excluding|no|not|closed)\b/g, " ") + p.slice(end)).trim());
        andBefore.push(parts[i - 1] === "and", false);
        return;
      }
      clauses.push(p.trim());
      andBefore.push(parts[i - 1] === "and");
    });
    const windows = [];
    let prevDays = null;
    let pendingDays = null; // days-only clause waiting for a times-only clause
    let lastTimed = false;  // the clause just before had times and days of its own

    clauses.forEach((c, i) => {
      const days = findDays(c);
      const times = findTimes(c);
      if (times.length) {
        const useDays = days || pendingDays || prevDays || ALL;
        times.forEach((t) => windows.push({ days: useDays, start: t.start, end: t.end, kind: "hh", text: c }));
        prevDays = useDays;
        pendingDays = null;
        lastTimed = !!days;
        return;
      }
      const wasTimed = lastTimed;
      lastTimed = false;
      if (days && days.onlyExcept && prevDays) {
        // "hh 3-6, except sundays": take those days out of the clause before.
        const left = prevDays.filter((d) => !days.onlyExcept.includes(d));
        windows.forEach((w) => { if (w.days === prevDays) w.days = left; });
        prevDays = left;
      } else if (days && wasTimed && andBefore[i] && DAYS_ONLY.test(c)) {
        // "hh 4-6 mon and tue", "10pm-2am fri and sat": more days for the clause before.
        const more = [...new Set([...prevDays, ...days])].sort();
        windows.forEach((w) => { if (w.days === prevDays) w.days = more; });
        prevDays = more;
        lastTimed = true;
      } else if (days) {
        const next = clauses[i + 1];
        if (next && findTimes(next).length && !findDays(next)) pendingDays = days;
        else if (!days.onlyExcept) windows.push({ days, start: 0, end: 24 * 60, kind: "special", text: c }); // "closed mon" isn't a special
      }
    });

    const vagueHH = /\b(hh|happy hours?)\b/.test(s) && !windows.some((w) => w.kind === "hh");
    return { windows, vagueHH, understood: windows.length > 0 };
  }

  // ---------- Describing a window in plain words (for review and the app) ----------

  const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function describeDays(days) {
    if (days.length === 7) return "Daily";
    const key = days.join(",");
    if (key === "1,2,3,4,5") return "Mon–Fri";
    if (key === "0,6") return "Sat–Sun";
    // Consecutive runs in week order starting Monday ("Tue–Sat", "Sun–Thu").
    const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
    const runs = [];
    for (const d of order) {
      const last = runs[runs.length - 1];
      if (last && (last[1] + 1) % 7 === d) last[1] = d; else runs.push([d, d]);
    }
    if (runs.length > 1 && runs[0][0] === 1 && runs[runs.length - 1][1] === 0) {
      const wrap = runs.pop(); runs[0][0] = wrap[0]; // "Sun–Thu" across the week boundary
    }
    return runs.map(([a, b]) => (a === b ? NAMES[a] : `${NAMES[a]}–${NAMES[b]}`)).join(", ");
  }

  function describeTime(min) {
    if (min === "close") return "close";
    if (min === null) return "?";
    if (min === 24 * 60) return "midnight";
    const h = Math.floor(min / 60) % 24, m = min % 60;
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`;
  }

  function describeWindow(w) {
    const days = describeDays(w.days);
    if (w.kind === "special") return `${days} (special, all day)`;
    if (w.start === 0 && w.end === 24 * 60) return `${days} all day`;
    if (w.start === null) return `${days} until ${describeTime(w.end)}`; // "until 6": from opening
    return `${days} ${describeTime(w.start)}–${describeTime(w.end)}`;
  }

  // ---------- Is a deal on when you'd arrive? ----------

  const WEEK = 7 * 1440;
  const SOON = 30;     // a deal starting within this many minutes of arrival counts
  const MIN_LEFT = 10; // a running deal needs at least this many minutes left
  const LAST_CALL = 6 * 60; // a "…-close" deal is over by 6 AM the next morning at the latest

  /**
   * The deal that matters for arriving at `when`: one running then (with 10+ min
   * left) or starting within 30 min. `closesIn` = minutes from arrival until the
   * place closes, used for "…-close" windows (null if unknown → midnight).
   * Returns { kind, status: "now" | "soon", startsIn, endsIn } or null; happy hours
   * beat specials, and "now" beats "soon".
   */
  function dealAt(windows, when, closesIn) {
    const t = when.getDay() * 1440 + when.getHours() * 60 + when.getMinutes();
    let found = null;
    const rank = (c) => (c.kind === "hh" ? 0 : 2) + (c.status === "now" ? 0 : 1);
    for (const w of windows) {
      for (const d of w.days) {
        for (const shift of [0, -WEEK, WEEK]) { // windows near the Sat→Sun edge
          const day = d * 1440 + shift; // midnight at the start of that day
          const start = day + (w.start === null ? 0 : w.start);
          // "…-close" ends when the place closes that night, and never later than
          // 6 AM the next morning. Without that limit, last night's "9-close"
          // would count as running at any hour the place is open today.
          const end = w.end === "close"
            ? Math.min(closesIn != null ? t + closesIn : day + 1440, day + 1440 + LAST_CALL)
            : day + w.end;
          let c = null;
          if (start <= t && t <= end - MIN_LEFT) c = { kind: w.kind, status: "now", startsIn: 0, endsIn: end - t };
          else if (start > t && start - t <= SOON && end > start) c = { kind: w.kind, status: "soon", startsIn: start - t, endsIn: end - t };
          if (c && (!found || rank(c) < rank(found))) found = c;
        }
      }
    }
    return found;
  }

  root.Deals = { parseDeals, dealAt, describeWindow, describeDays, describeTime };
})(typeof window !== "undefined" ? window : globalThis);
