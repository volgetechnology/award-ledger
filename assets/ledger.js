/* Monaqasat Award Ledger — client renderer.
   Reads data/awards.json (written by n8n) and renders three views:
     #/            front page, one row per edition
     #/e/<date>    a single edition — the awards sent to WhatsApp that day
     #/rivals      cumulative win/loss tally across every edition
   All analysis happens here, so n8n only ever has to reshape rows. */

const TZ = 'Asia/Qatar';
const app = document.getElementById('app');

let DATA = null;

/* ---------- helpers ---------- */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 5807693.17 -> "5,807,693.17"   17485680 -> "17,485,680"
function qar(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!isFinite(v)) return null;
  const s = Math.abs(v % 1) < 0.005 ? String(Math.round(v)) : v.toFixed(2);
  const p = s.split('.');
  p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return p.join('.');
}

function compact(n) {
  const v = Number(n);
  if (!isFinite(v)) return '—';
  if (v >= 1e6) return (v / 1e6).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'k';
  return String(Math.round(v));
}

// the edition a record belongs to = the Qatar-local day it was sent
const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(iso));

const longDate = (iso) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
}).format(new Date(iso));

const shortDate = (ymd) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric'
}).format(new Date(ymd + 'T00:00:00Z'));

const clock = (iso) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
}).format(new Date(iso)) + ' AST';

/* ---------- analysis ---------- */

const winnerCrs = (a) => new Set(
  a.participants.filter(p => p.stage === 'awarded').map(p => p.cr || p.company)
);

/* One bar per company, cheapest first. A bidder repeats once per lot on the
   source page, so keep only their lowest published figure. */
function ladderFor(award) {
  const wins = winnerCrs(award);
  let priced = award.participants.filter(p => p.stage === 'financial' && p.proposalAmountQar != null);

  // some awards publish a figure only against the awarded rows
  if (!priced.length) {
    priced = award.participants
      .filter(p => p.stage === 'awarded' && p.approvedValueQar != null)
      .map(p => ({ ...p, proposalAmountQar: p.approvedValueQar }));
  }

  const byCr = new Map();
  for (const p of priced) {
    const k = p.cr || p.company;
    const prev = byCr.get(k);
    if (!prev || Number(p.proposalAmountQar) < Number(prev.proposalAmountQar)) byCr.set(k, p);
  }

  const rows = [...byCr.values()]
    .sort((x, y) => Number(x.proposalAmountQar) - Number(y.proposalAmountQar))
    .map(p => ({
      name: p.company,
      amount: Number(p.proposalAmountQar),
      lvr: p.localValueRatio,
      excluded: !!p.excluded,
      win: wins.has(p.cr || p.company)
    }));

  const max = rows.length ? Math.max(...rows.map(r => r.amount)) : 0;
  rows.forEach(r => { r.pct = max ? (r.amount / max) * 100 : 0; });
  return rows;
}

function gapFor(rows) {
  const winner = rows.find(r => r.win);
  const bestLoser = rows.find(r => !r.win);
  if (!winner || !bestLoser || !bestLoser.amount) return null;
  const pct = Math.round(((bestLoser.amount - winner.amount) / bestLoser.amount) * 100);
  return { pct, rival: bestLoser.name, cheaper: pct > 0 };
}

/* Companies that cleared technical opening but never had a price published. */
function silentBidders(award, rows) {
  const shown = new Set(rows.map(r => r.name));
  const seen = new Set();
  return award.participants
    .filter(p => p.stage === 'technical')
    .filter(p => {
      const k = p.cr || p.company;
      if (shown.has(p.company) || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(p => p.company);
}

function editions(awards) {
  const map = new Map();
  for (const a of awards) {
    const k = dayKey(a.sentAt);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(a);
  }
  return [...map.entries()]
    .map(([date, items]) => {
      items.sort((x, y) => y.awardedAmountQar - x.awardedAmountQar);
      return {
        date,
        items,
        total: items.reduce((s, a) => s + Number(a.awardedAmountQar || 0), 0),
        buyers: new Set(items.map(a => a.ministry)).size
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function rivals(awards) {
  const map = new Map();
  for (const a of awards) {
    const wonHere = new Set();
    for (const p of a.participants) {
      const k = p.cr || p.company;
      if (!map.has(k)) map.set(k, { name: p.company, tenders: new Set(), won: 0, value: 0, lvr: null });
      const r = map.get(k);
      r.tenders.add(a.tenderNumber);
      if (p.localValueRatio != null) r.lvr = p.localValueRatio;
      if (p.stage === 'awarded') {
        r.value += Number(p.approvedValueQar || 0);
        if (!wonHere.has(k)) { r.won += 1; wonHere.add(k); }
      }
    }
  }
  return [...map.values()]
    .map(r => ({ ...r, entered: r.tenders.size }))
    .sort((a, b) => b.entered - a.entered || b.value - a.value || b.won - a.won);
}

/* ---------- render ---------- */

function ladderHtml(rows) {
  return rows.map(r => `
    <div class="bid${r.win ? ' win' : ''}${r.excluded ? ' excluded' : ''}">
      <div class="bid-top">
        <span class="bid-name">${esc(r.name)}</span>
        ${r.win ? '<span class="tag win">Won</span>' : ''}
        ${r.excluded ? '<span class="tag exc">Excluded</span>' : ''}
        ${r.lvr != null ? `<span class="tag local">${Math.round(r.lvr)}% local</span>` : ''}
        <span class="bid-amt">${esc(qar(r.amount))}</span>
      </div>
      <div class="track"><div class="fill" style="width:${r.pct.toFixed(1)}%"></div></div>
    </div>`).join('');
}

function recordHtml(a) {
  const rows = ladderFor(a);
  const gap = gapFor(rows);
  const quiet = silentBidders(a, rows);
  const noLosingPrice = rows.length > 0 && rows.every(r => r.win);

  return `
  <article class="record">
    <header>
      <p class="rec-id">
        <span class="rec-num">${esc(a.tenderNumber)}</span>
        <span class="rec-buyer">${esc(a.ministry)}</span>
        <span class="rec-date">Awarded ${esc(shortDate(a.awardedDate))}</span>
      </p>
      <h3 class="rec-title">${esc(a.subject)}</h3>
    </header>
    <div class="rec-body">
      <div class="rec-facts">
        <div class="fact">
          <span class="k">Awarded</span>
          <span class="v big">${esc(qar(a.awardedAmountQar))}</span>
          <span class="sub">QAR${a.awardedCount > 1 ? `, split ${a.awardedCount} ways` : ', single winner'}</span>
        </div>
        ${a.tenderBondQar ? `<div class="fact"><span class="k">Tender bond</span><span class="v">${esc(qar(a.tenderBondQar))}</span></div>` : ''}
        <div class="fact">
          <span class="k">Field</span>
          <span class="v">${esc(a.participantCount)}</span>
          <span class="sub">${rows.length} price${rows.length === 1 ? '' : 's'} published</span>
        </div>
        <div class="fact">
          <span class="k">Type</span>
          <span class="v sm">${esc(a.tenderType || '—')}</span>
          ${a.sector ? `<span class="sub">${esc(a.sector)}</span>` : ''}
        </div>
      </div>

      <div class="rec-field">
        <div>
          <p class="field-label">${noLosingPrice ? 'Awarded companies' : 'Bid ladder &middot; cheapest first'}</p>
          <div class="ladder">${ladderHtml(rows)}</div>
        </div>

        ${gap ? `<p class="gap-call"><b>${Math.abs(gap.pct)}%</b><span>${gap.cheaper ? 'below' : 'above'} ${esc(gap.rival)}, the closest rival with a published price.</span></p>` : ''}

        ${noLosingPrice ? '<p class="note"><strong>No losing price was published.</strong> Monaqasat listed a figure only against the winning companies, so there is no price gap to read here.</p>' : ''}

        ${a.takeaway ? `<p class="note">${esc(a.takeaway)}</p>` : ''}

        ${quiet.length ? `
        <div>
          <p class="field-label">Cleared technical, no price published</p>
          <div class="chips">${quiet.map(c => `<span class="chip">${esc(c)}</span>`).join('')}</div>
        </div>` : ''}

        <p class="note"><a href="${esc(a.reportUrl)}" target="_blank" rel="noopener">Source report on Monaqasat &rarr;</a></p>
      </div>
    </div>
  </article>`;
}

function renderFront() {
  const eds = editions(DATA.awards);
  const grand = DATA.awards.reduce((s, a) => s + Number(a.awardedAmountQar || 0), 0);
  const companies = new Set();
  DATA.awards.forEach(a => a.participants.forEach(p => companies.add(p.cr || p.company)));

  app.innerHTML = `
    <header class="page-head">
      <p class="eyebrow"><span>Monaqasat &middot; Qatar MOF</span><span>${eds.length} edition${eds.length === 1 ? '' : 's'}</span></p>
      <h1>Awarded tenders, by the day we sent them</h1>
      <p class="standfirst">One edition per digest. Each is exactly what the group received that day &mdash; winning price, every published losing bid, and the field the buyer drew.</p>
    </header>

    <dl class="totals">
      <div><dt>Editions</dt><dd>${eds.length}</dd></div>
      <div><dt>Awards</dt><dd>${DATA.awards.length}</dd></div>
      <div><dt>Total awarded</dt><dd>${compact(grand)}<span class="unit"> QAR</span></dd></div>
      <div><dt>Distinct bidders</dt><dd>${companies.size}</dd></div>
    </dl>

    <section>
      <div class="sec-head"><h2>Editions</h2><span class="count">Newest first</span></div>
      <div class="editions">
        ${eds.map(ed => {
          const lead = ed.items[0];
          return `
          <a class="edition-row" href="#/e/${ed.date}">
            <span class="ed-date">${esc(shortDate(ed.date))}<span>${ed.items.length} award${ed.items.length === 1 ? '' : 's'}</span></span>
            <span>
              <span class="ed-headline">${esc(lead.ministry)}</span>
              <span class="ed-sub">${esc(lead.subject.length > 90 ? lead.subject.slice(0, 90).trim() + '…' : lead.subject)}</span>
            </span>
            <span class="ed-value">${compact(ed.total)}<span>QAR total</span></span>
          </a>`;
        }).join('')}
      </div>
    </section>`;
}

function renderEdition(date) {
  const ed = editions(DATA.awards).find(e => e.date === date);
  if (!ed) {
    app.innerHTML = `<p class="state error">No edition for ${esc(date)}</p><p><a class="backlink" href="#/">&larr; All editions</a></p>`;
    return;
  }

  app.innerHTML = `
    <header class="page-head">
      <a class="backlink" href="#/">&larr; All editions</a>
      <p class="eyebrow"><span>Edition of ${esc(shortDate(ed.date))}</span><span>${ed.buyers} buyer${ed.buyers === 1 ? '' : 's'}</span></p>
      <h1>${esc(longDate(ed.items[0].sentAt))}</h1>
      <p class="standfirst">${ed.items.length} award${ed.items.length === 1 ? '' : 's'} posted to the group, worth ${esc(qar(ed.total))} QAR in total.</p>
    </header>

    <section>
      <div class="sec-head"><h2>The awards</h2><span class="count">Largest first</span></div>
      <div class="records">${ed.items.map(recordHtml).join('')}</div>
    </section>

    <section>
      <div class="sec-head"><h2>As posted to WhatsApp</h2><span class="count">Verbatim</span></div>
      ${ed.items.map(a => `
        <details>
          <summary><span>${esc(a.tenderNumber)} &middot; ${esc(a.ministry)}</span><span style="margin-left:auto;color:var(--ink-faint)">${esc(clock(a.sentAt))}</span></summary>
          <pre>${esc(a.messageSent || '(message body not archived for this record)')}</pre>
        </details>`).join('')}
    </section>`;
}

function renderRivals() {
  const all = rivals(DATA.awards);
  const shown = all.filter(r => r.entered > 1 || r.won > 0);
  const omitted = all.length - shown.length;
  const eds = editions(DATA.awards);

  app.innerHTML = `
    <header class="page-head">
      <a class="backlink" href="#/">&larr; All editions</a>
      <p class="eyebrow"><span>Cumulative</span><span>${all.length} companies &middot; ${DATA.awards.length} tenders</span></p>
      <h1>Who keeps showing up</h1>
      <p class="standfirst">Every company seen across all ${eds.length} edition${eds.length === 1 ? '' : 's'}, ranked by how many tenders they entered.</p>
    </header>

    <section>
      <div class="sec-head"><h2>Repeat bidders and winners</h2><span class="count">All editions</span></div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Company</th>
              <th scope="col" class="num">Entered</th>
              <th scope="col" class="num">Won</th>
              <th scope="col" class="num">Value won (QAR)</th>
              <th scope="col" class="num">Local value</th>
            </tr>
          </thead>
          <tbody>
            ${shown.map(r => `
              <tr${r.entered > 1 && r.won > 0 ? ' class="hot"' : ''}>
                <td>${esc(r.name)}</td>
                <td class="num">${r.entered}</td>
                <td class="num">${r.won}</td>
                <td class="num">${r.value ? esc(qar(r.value)) : '—'}</td>
                <td class="num">${r.lvr != null ? Math.round(r.lvr) + '%' : 'not published'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${omitted > 0 ? `<p class="note" style="margin-top:.9rem">${omitted} further compan${omitted === 1 ? 'y' : 'ies'} appeared once and won nothing; omitted above.</p>` : ''}
    </section>`;
}

/* ---------- router ---------- */

function route() {
  if (!DATA) return;
  const h = location.hash.replace(/^#\/?/, '');
  document.querySelectorAll('.topbar nav a').forEach(a => a.removeAttribute('aria-current'));

  if (h.startsWith('e/')) {
    renderEdition(h.slice(2));
  } else if (h === 'rivals') {
    document.querySelector('a[href="#/rivals"]')?.setAttribute('aria-current', 'page');
    renderRivals();
  } else {
    document.querySelector('a[href="#/"]')?.setAttribute('aria-current', 'page');
    renderFront();
  }
  window.scrollTo(0, 0);
}

function stamp() {
  const el = document.getElementById('stamp');
  if (el && DATA.generatedAt) {
    el.textContent = `Data as of ${longDate(DATA.generatedAt)}, ${clock(DATA.generatedAt)} · ${DATA.awards.length} awards`;
  }
}

fetch('./data/awards.json', { cache: 'no-store' })
  .then(r => {
    if (!r.ok) throw new Error(`awards.json returned ${r.status}`);
    return r.json();
  })
  .then(d => {
    DATA = d;
    DATA.awards = (DATA.awards || []).filter(a => a && a.sentAt);
    stamp();
    route();
  })
  .catch(err => {
    app.innerHTML = `<p class="state error">Could not load the ledger data — ${esc(err.message)}</p>`;
  });

window.addEventListener('hashchange', route);
