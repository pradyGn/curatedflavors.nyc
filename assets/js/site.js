/* site.js - progressive enhancement for curatedflavors.nyc
 *
 * The page is complete without this file: every row it touches ships baked into
 * the HTML, so a failed load, parse or fetch leaves real content on screen.
 * Hydrate over something real, never into a hole.
 *
 * Reasoning: plans/EP01-curated-flavors-website/S03-data-and-live.md
 * No libraries, no network beyond the same-origin snapshot.
 *
 * SECURITY: rows clone a <template> and set textContent only, never innerHTML.
 * Venue names come from scraped sources and must not become markup.
 *
 * Author: pgangan
 */

(function () {
  'use strict';

  var DATA_URL = 'assets/data/site.json';
  var FETCH_TIMEOUT_MS = 4000;

  /** Join meta segments, dropping empties: the exporter legitimately emits an
   * empty area or price, and a blind join leaves "Thai ·  · $$". */
  function metaLine(parts) {
    return parts
      .map(function (p) { return (p || '').trim(); })
      .filter(function (p) { return p.length > 0; })
      .join(' · ');
  }

  /** Replace a list's children with rows cloned from a <template>. */
  function renderRows(list, templateId, items, fill) {
    var template = document.getElementById(templateId);
    if (!list || !template || !items || !items.length) return false;

    var fragment = document.createDocumentFragment();
    for (var i = 0; i < items.length; i++) {
      var row = template.content.firstElementChild.cloneNode(true);
      fill(row, items[i]);
      fragment.appendChild(row);
    }
    list.replaceChildren(fragment);
    return true;
  }

  /** Set an element's text, if the element exists. */
  function setText(root, selector, value) {
    var el = root.querySelector(selector);
    if (el) el.textContent = value == null ? '' : String(value);
  }

  /** "Month YYYY" for the ledger caption; "" rather than "Invalid Date". */
  function monthYear(iso) {
    var when = new Date(iso);
    if (isNaN(when.getTime())) return '';
    return when.toLocaleDateString('en-US', {
      month: 'long', year: 'numeric', timeZone: 'America/New_York'
    });
  }

  /** Swap the six baked ledger rows for the exported top six. */
  function hydrateLedger(data) {
    var list = document.querySelector('[data-ledger]');
    var ok = renderRows(list, 'ledger-row-template', data.ledger, function (row, item) {
      setText(row, '.ledger__rank', item.rank);
      setText(row, '.ledger__name', item.name);
      setText(row, '.ledger__meta', metaLine([item.area, item.cuisine, item.price]));
      setText(row, '.ledger__score', item.tasty_index);
    });
    if (!ok) return;

    // The baked caption says "Illustrative ledger". Once these are the real top
    // six, saying so is both more accurate and more persuasive.
    var caption = document.querySelector('[data-ledger-caption]');
    var stamp = monthYear(data.generated_at);
    if (caption) {
      caption.textContent = stamp
        ? 'Live index · updated ' + stamp
        : 'Live index · the app ships 1,000+';
    }
  }

  /** Swap the four baked event rows for the next four upcoming. */
  function hydrateEvents(data) {
    var list = document.querySelector('[data-events]');
    renderRows(list, 'event-row-template', data.events, function (row, item) {
      setText(row, '.ev__month', item.month);
      setText(row, '.ev__name', item.name);
      setText(row, '.ev__where', item.where);
    });
  }

  /** Fetch the snapshot and hand it to each consumer. Failure is silent by
   * design: an unreachable data file must leave the baked page intact. */
  function boot() {
    var options = {};
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
      options.signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    }

    fetch(DATA_URL, options)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!data || typeof data !== 'object') return;
        hydrateLedger(data);
        hydrateEvents(data);
        if (window.__nycEatsHappyHours) window.__nycEatsHappyHours(data);
      })
      .catch(function (error) {
        // Baked content stays exactly as served.
        console.debug('[site] keeping baked content:', error && error.message);
      });
  }


  /* ---- Happy-hour live engine (EP01.S03.T03) -------------------------- *
   * The caption claims the countdown is live, so it has to be. Status comes
   * from the exported schedules against the New York clock, never the
   * visitor's: London at 22:00 should see Manhattan at 17:00. */

  var DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var SOON_WINDOW_MIN = 90;   // how far ahead "STARTS SOON" reaches
  var MINUTES_PER_DAY = 1440;

  /* How long a window with no end time is assumed to run.
   *
   * 18 venues in the real data say "until closing" and carry a null end. Treating
   * that as "live until the same minute tomorrow" made them pour around the clock:
   * a verification sweep found 57 percent of the week claiming "N pouring" with no
   * venue actually in a bounded window, including "8 pouring" at 4am. Four hours is
   * the length of a typical happy hour in this dataset and errs toward saying less
   * than it can prove. */
  var OPEN_ENDED_RUN_MIN = 240;

  var nyPartsFormatter = null;

  /** New York weekday/minute/second via Intl parts, so DST comes from the
   * platform's timezone database rather than from arithmetic here. */
  function nowInNewYork() {
    if (!nyPartsFormatter) {
      nyPartsFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
    }
    var parts = nyPartsFormatter.formatToParts(new Date());
    var lookup = {};
    for (var i = 0; i < parts.length; i++) lookup[parts[i].type] = parts[i].value;
    var weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    // 'hour: 2-digit' with hour12:false yields 24 for midnight in some engines.
    var hour = parseInt(lookup.hour, 10) % 24;
    if (!(lookup.weekday in weekdays)) return null;   // never silently mean Sunday
    return {
      dayIndex: weekdays[lookup.weekday],
      minute: hour * 60 + parseInt(lookup.minute, 10),
      second: parseInt(lookup.second, 10) || 0
    };
  }

  /**
   * Expand a venue's schedule into windows measured in minutes from now.
   *
   * Offsets rather than clock times, so an overnight window needs no special case:
   * its end offset simply exceeds its start offset.
   */
  function windowsFor(venue, now) {
    var out = [];
    var schedule = venue.schedule || {};
    // Yesterday, today and tomorrow: yesterday's window can still be running if
    // it crossed midnight, and tomorrow's is what a quiet evening falls back to.
    for (var offset = -1; offset <= 1; offset++) {
      var index = (now.dayIndex + offset + 7) % 7;
      var windows = schedule[DAY_KEYS[index]];
      if (!windows) continue;
      for (var w = 0; w < windows.length; w++) {
        var start = windows[w][0];
        var end = windows[w][1];
        if (typeof start !== 'number') continue;
        var base = offset * MINUTES_PER_DAY - now.minute;
        var startOffset = base + start;
        var endOffset = null;
        if (typeof end === 'number') {
          endOffset = base + end;
          // end < start means the window crosses midnight into the next day.
          if (end <= start) endOffset += MINUTES_PER_DAY;
        }
        out.push({
          start: startOffset, end: endOffset,
          allDay: endOffset !== null && (endOffset - startOffset) >= MINUTES_PER_DAY
        });
      }
    }
    // The schema allows several windows per day even though today's export emits
    // one, and the bucketing takes the first match.
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  /** Bucket every venue by what it is doing right now. */
  function bucketVenues(venues, now) {
    // `open` is separate from `live`: an all-day venue is open, not pouring, and
    // counting it would inflate the headline figure with venues that have no
    // happy hour running at all.
    var live = [], open = [], soon = [], later = [], tomorrow = [];
    for (var i = 0; i < venues.length; i++) {
      var venue = venues[i];
      var windows = windowsFor(venue, now);
      for (var w = 0; w < windows.length; w++) {
        var win = windows[w];
        var entry = { venue: venue, start: win.start, end: win.end,
                      allDay: win.allDay };
        var running = win.start <= 0 && (win.end === null
          ? win.start > -OPEN_ENDED_RUN_MIN
          : win.end > 0);
        if (running) { (entry.allDay ? open : live).push(entry); break; }
        if (win.start > 0) {
          if (win.start <= SOON_WINDOW_MIN) { soon.push(entry); break; }
          // Same New York day: still ahead of the minutes left before midnight.
          if (win.start < MINUTES_PER_DAY - now.minute) { later.push(entry); break; }
          tomorrow.push(entry); break;
        }
      }
    }
    var byStart = function (a, b) { return a.start - b.start; };
    var tag = function (list, bucket) {
      for (var j = 0; j < list.length; j++) list[j].bucket = bucket;
      return list;
    };
    tag(live, 'live'); tag(open, 'open'); tag(soon, 'soon');
    tag(later, 'later'); tag(tomorrow, 'tomorrow');
    // Feature the live venue closing soonest, because that is the one a countdown
    // means anything for. Venues with no computable finish (null end, or an
    // all-day window) sort last however early they started: featuring one turns
    // the card's headline into "Open all day", which is the least urgent thing it
    // could say.
    live.sort(function (a, b) {
      var aVague = a.end === null || a.allDay;
      var bVague = b.end === null || b.allDay;
      if (aVague !== bVague) return aVague ? 1 : -1;
      if (aVague) return a.start - b.start;
      return a.end - b.end;
    });
    soon.sort(byStart); later.sort(byStart); tomorrow.sort(byStart);
    open.sort(byStart);
    return { live: live, open: open, soon: soon, later: later, tomorrow: tomorrow };
  }

  /** Render minutes as a clock time in New York, e.g. "5:00 PM". */
  function clockLabel(minutesFromNow, now) {
    var absolute = ((now.minute + minutesFromNow) % MINUTES_PER_DAY + MINUTES_PER_DAY)
                   % MINUTES_PER_DAY;
    var hour = Math.floor(absolute / 60);
    var minute = absolute % 60;
    var suffix = hour >= 12 ? 'PM' : 'AM';
    var display = hour % 12 === 0 ? 12 : hour % 12;
    return display + ':' + (minute < 10 ? '0' : '') + minute + ' ' + suffix;
  }

  /** "in 24m" / "in 2h 10m", for a start that has not happened yet. */
  function untilLabel(minutes) {
    if (minutes < 60) return 'in ' + minutes + 'm';
    return 'in ' + Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }

  /** Countdown text; switches to seconds under an hour, as the design does. */
  function countdownLabel(msRemaining) {
    var total = Math.max(0, Math.floor(msRemaining / 1000));
    var hours = Math.floor(total / 3600);
    var minutes = Math.floor((total % 3600) / 60);
    var seconds = total % 60;
    if (hours > 0) return 'Ends in ' + hours + 'h ' + minutes + 'm';
    return 'Ends in ' + minutes + 'm ' + (seconds < 10 ? '0' : '') + seconds + 's';
  }

  /* startAt/endAt are absolute timestamps, not the minute offsets the buckets are
   * built from: an offset captured at first paint is how countdowns drift. */
  var hh = {
    timer: null, venues: null, bar: null, countdown: null,
    startAt: 0, endAt: 0, running: false, lastMinute: -1
  };

  /** Fill one secondary row from the template. */
  function fillRow(row, entry, label, sub, later) {
    setText(row, '.hh__row-name', entry.venue.name);
    setText(row, '.hh__row-meta', metaLine([entry.venue.area, entry.venue.type]));
    var when = row.querySelector('.hh__when');
    if (when) {
      // Neither baked template can express this modifier, so the engine owns it.
      // Without it every hydrated row renders at STARTS SOON weight and colour.
      when.classList.toggle('hh__when--later', !!later);
      setText(when, '.hh__when-label', label);
      setText(when, '.hh__when-sub', sub);
    }
  }

  /** Paint the whole card for the current minute. */
  function renderHappyHours() {
    if (!hh.venues) return;
    var now = nowInNewYork();
    if (!now) return;                 // unknown weekday: leave the baked card alone
    hh.lastMinute = Math.floor(Date.now() / 60000);
    var buckets = bucketVenues(hh.venues, now);

    var count = document.querySelector('[data-hh-count]');
    var status = document.querySelector('[data-hh-status]');
    var featuredEl = document.querySelector('[data-hh-featured]');
    var list = document.querySelector('[data-hh-list]');
    if (!featuredEl || !list) return;

    hh.running = false;
    var featured = buckets.live[0] || null;
    var isLive = !!featured;
    if (!featured) {
      featured = buckets.open[0] || buckets.soon[0] ||
                 buckets.later[0] || buckets.tomorrow[0];
      isLive = !!(featured && featured.bucket === 'open');
    }
    if (!featured) return;   // nothing scheduled at all: keep the baked card

    // Never "0 pouring". All-day venues are excluded: open, not pouring.
    if (count) {
      count.textContent = buckets.live.length
        ? buckets.live.length + ' pouring'
        : 'none pouring yet';
    }
    if (status) {
      status.textContent = buckets.live.length ? 'Live this minute' : 'Next up';
    }

    // Featured venue.
    setText(featuredEl, '.hh__name', featured.venue.name);
    setText(featuredEl, '.hh__meta',
            metaLine([featured.venue.area, featured.venue.type, featured.venue.deal]));
    // The badge must agree with the row that describes the same venue: honouring
    // the bucket here is what stops a card reading "Later today" beside a row
    // reading "Tomorrow" for one venue.
    var badge = featuredEl.querySelector('.hh__badge');
    if (badge) {
      badge.textContent = isLive ? (featured.allDay ? 'Open now' : 'Live now')
        : featured.bucket === 'tomorrow' ? 'Tomorrow'
        : featured.start <= SOON_WINDOW_MIN ? 'Starts soon'
        : 'Later today';
    }

    // Progress bar and countdown only mean something for a live window with a
    // known end. Otherwise both are hidden rather than faked.
    var barTrack = featuredEl.querySelector('.bar');
    hh.bar = featuredEl.querySelector('[data-hh-bar]');
    hh.countdown = featuredEl.querySelector('[data-hh-countdown]');
    if (isLive && featured.end !== null && !featured.allDay) {
      hh.running = true;
      // featured.* are whole minutes from the top of the current NY minute, so
      // elapsed seconds must come out or the countdown reads up to 59s high.
      var secOffset = (now.second || 0) * 1000;
      hh.startAt = Date.now() + featured.start * 60000 - secOffset;
      hh.endAt = Date.now() + featured.end * 60000 - secOffset;
      if (barTrack) barTrack.hidden = false;
    } else {
      hh.running = false;
      if (barTrack) barTrack.hidden = true;
      if (hh.countdown) {
        hh.countdown.textContent = isLive
          ? (featured.allDay ? 'Open all day' : 'Open until closing')
          : featured.start <= 0 ? ''
          : (featured.bucket === 'tomorrow' ? 'Opens tomorrow ' : 'Starts ')
            + clockLabel(featured.start, now);
      }
    }

    // When nothing is live the featured slot already consumed the first
    // upcoming entry, so skip it here or the card shows one venue twice.
    var rest = buckets.open.concat(buckets.soon, buckets.later, buckets.tomorrow)
      .filter(function (e) { return e !== featured; });
    var secondary = (buckets.live.length ? buckets.live.slice(1, 2) : [])
      .concat(rest).slice(0, 2);
    var template = document.getElementById('hh-row-template');
    if (template) {
      var fragment = document.createDocumentFragment();
      for (var i = 0; i < secondary.length; i++) {
        var entry = secondary[i];
        var row = template.content.firstElementChild.cloneNode(true);
        if (entry.start <= 0) {
          // "Live now" here beside "none pouring yet" in the header would
          // contradict itself; an all-day venue is open, not pouring.
          fillRow(row, entry,
                  entry.allDay ? 'Open now' : 'Live now',
                  entry.allDay ? 'all day' : 'pouring',
                  entry.allDay);
        } else if (entry.start <= SOON_WINDOW_MIN) {
          fillRow(row, entry, 'Starts soon', untilLabel(entry.start), false);
        } else if (entry.bucket === 'tomorrow') {
          // At 23:45 a venue opening at 11:30 is not "later today".
          fillRow(row, entry, 'Tomorrow', clockLabel(entry.start, now), true);
        } else {
          fillRow(row, entry, 'Later today', clockLabel(entry.start, now), true);
        }
        fragment.appendChild(row);
      }
      // Unconditional: baked mockup rows beside hydrated data are worse than none.
      list.replaceChildren(fragment);
    }

    // The baked caption says "Sample of the in-app feed"; it no longer is.
    var caption = document.querySelector('[data-hh-caption]');
    if (caption) {
      caption.textContent = buckets.live.length
        ? 'Live from the app feed · ' + buckets.live.length + ' pouring in Manhattan'
        : 'Live from the app feed · Manhattan happy hours';
    }

    tick();
  }

  /** Update countdown and bar each second, from absolute timestamps. */
  function tick() {
    if (!hh.running || !hh.countdown) return;
    var remaining = hh.endAt - Date.now();
    if (remaining <= 0) { renderHappyHours(); return; }   // window just closed
    hh.countdown.textContent = countdownLabel(remaining);
    var duration = hh.endAt - hh.startAt;
    if (hh.bar && duration > 0) {
      var elapsed = Date.now() - hh.startAt;
      hh.bar.style.width =
        Math.min(100, Math.max(0, elapsed / duration * 100)).toFixed(2) + '%';
    }
  }

  /** Start ticking, pausing whenever the tab is hidden. */
  function startTicking() {
    stopTicking();
    if (document.hidden) return;
    hh.timer = window.setInterval(function () {
      // Compare minute numbers rather than watching for second :00. A 1s interval
      // that misses the :00 tick (main-thread jank, a backgrounded tab) would
      // otherwise never rebucket, and when the featured venue has no end time this
      // is the only refresh path there is.
      if (Math.floor(Date.now() / 60000) !== hh.lastMinute) renderHappyHours();
      else tick();
    }, 1000);
  }

  function stopTicking() {
    if (hh.timer) { window.clearInterval(hh.timer); hh.timer = null; }
  }

  document.addEventListener('visibilitychange', function () {
    if (!hh.venues) return;
    if (document.hidden) stopTicking();
    else { renderHappyHours(); startTicking(); }
  });

  window.__nycEatsHappyHours = function (data) {
    if (!data.happy_hours || !data.happy_hours.length) return;
    hh.venues = data.happy_hours;
    renderHappyHours();
    startTicking();
  };


  /* ---- Reveal on scroll (EP01.S03.T04) -------------------------------- *
   * The hidden state is applied by JS, never CSS. That is the safety property:
   * no JS, a parse error or an old browser leaves everything visible, because
   * nothing ever hid it. A CSS opacity:0 default would blank the page. */

  var REVEAL_MARGIN = '0px 0px -8% 0px';
  var REVEAL_SAFETY_MS = 2500;

  function initReveal() {
    var targets = Array.prototype.slice.call(
      document.querySelectorAll('[data-reveal]'));
    if (!targets.length) return;

    // Respect the visitor's motion preference, and bail out on anything without
    // IntersectionObserver rather than leaving elements hidden forever.
    var motionOK = !(window.matchMedia &&
                     window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (!motionOK || typeof IntersectionObserver === 'undefined') return;

    // Only hide what is below the fold. Hiding something already on screen would
    // make it flash out and back in, which is worse than not animating at all.
    var pending = targets.filter(function (el) {
      return el.getBoundingClientRect().top > window.innerHeight * 0.92;
    });
    if (!pending.length) return;

    pending.forEach(function (el) { el.classList.add('is-hidden'); });

    var remaining = pending.length;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        // Reveal on intersection, and also for anything already scrolled past:
        // a fast flick moves an element from below the fold to above it without
        // ever reporting as intersecting, which would leave it invisible until
        // the safety timeout. That is a real 2.5 second hole on a phone.
        var scrolledPast = entry.boundingClientRect.bottom < 0;
        if (!entry.isIntersecting && !scrolledPast) return;
        show(entry.target);
        observer.unobserve(entry.target);
      });
      // Nothing left to watch: stop holding a reference to every section.
      if (remaining <= 0) observer.disconnect();
    }, { rootMargin: REVEAL_MARGIN, threshold: 0.04 });

    pending.forEach(function (el) { observer.observe(el); });

    function show(el) {
      if (!el.classList.contains('is-hidden')) return;
      el.classList.remove('is-hidden');
      remaining--;
    }

    /* IntersectionObserver alone is not enough: it only fires on a threshold
     * crossing, and a fling-scroll moves an element from below the viewport to
     * above it in one frame, reporting "not intersecting" both times. Measured:
     * 5 of 8 sections stayed invisible until the safety timeout. */
    var sweeping = false;
    function sweep() {
      sweeping = false;
      for (var i = pending.length - 1; i >= 0; i--) {
        var el = pending[i];
        if (!el.classList.contains('is-hidden')) continue;
        if (el.getBoundingClientRect().top < window.innerHeight * 0.92) show(el);
      }
      if (remaining <= 0) {
        observer.disconnect();
        window.removeEventListener('scroll', onScroll);
      }
    }
    function onScroll() {
      if (sweeping) return;
      sweeping = true;
      window.requestAnimationFrame(sweep);
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    // Safety net: whatever the observer has not fired for by now is revealed
    // anyway. Content must never be able to stay invisible because of a scroll
    // quirk, a restored scroll position, or a browser we did not anticipate.
    window.setTimeout(function () {
      pending.forEach(show);
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
    }, REVEAL_SAFETY_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReveal);
  } else {
    initReveal();
  }

  boot();
}());
