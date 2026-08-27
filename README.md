# Award Ledger

Static dashboard for awarded Qatar tenders, published to GitHub Pages. One
**edition** per WhatsApp digest — each page is exactly what the group received
that day.

Source of truth is NocoDB. n8n rewrites one file, `data/awards.json`, at the end
of every digest run; the page reads it in the browser and does all the analysis
client-side. Nothing here is generated at build time, so there is no build step.

```
index.html            shell + nav
assets/ledger.css     design tokens, light + dark
assets/ledger.js      router, bid-ladder maths, rivals tally
data/awards.json      the only file n8n touches
```

## Views

| Route | What it shows |
|---|---|
| `#/` | Front page — one row per edition, newest first |
| `#/e/2026-08-26` | One edition: that day's awards, bid ladders, verbatim WhatsApp text |
| `#/rivals` | Cumulative win/loss tally across every edition |

An edition is keyed on the **Qatar-local day the digest was sent** (`sentAt`),
not the day the tender was awarded — so one page maps to one group message.

## Deploy

Repo → Settings → Pages → Source: `Deploy from a branch`, branch `main`, folder `/`.

`.nojekyll` is present so Pages serves the files as-is.

> GitHub Pages is publicly readable even from a private repo below Enterprise.
> `noindex, nofollow` is set in `index.html`, which keeps it out of search
> results but is not access control.

## The n8n publish contract

The digest workflow (`N0Rn49pvty2lSAvY`) hangs the publish off `Loop Over Awards`
**output 0** — the "done" branch, which fires once after every tender in the
batch has been sent. It rebuilds the whole file rather than patching it, so the
JSON can never drift out of sync with the table.

```
Loop Over Awards (output 0)
  → Fetch Announced Awards   NocoDB, where=(announced,checked)
  → Fetch Participants       NocoDB, limit=1000
  → Build awards.json        Code node — reshape only, no analysis
  → Get file sha             GET  /repos/:owner/:repo/contents/data/awards.json
  → Put file                 PUT  same path, base64 content + that sha
```

The GitHub Contents API needs the existing file's `sha` to overwrite it, so this
is GET-then-PUT, not a bare PUT.

### Record shape

```jsonc
{
  "generatedAt": "2026-08-27T06:50:00.000Z",
  "source": "…",
  "awards": [{
    "id": 8,                      // NocoDB row Id
    "tenderNumber": "6351/2024",
    "customId": "MNQ-6351/2024",
    "subject": "…",
    "ministry": "…",
    "tenderType": "Public Tender",
    "sector": "Contractors",
    "awardedDate": "2026-08-23",  // YYYY-MM-DD
    "sentAt": "2026-08-26T12:47:45.000Z",   // ISO UTC — keys the edition
    "awardedAmountQar": 42751888.17,
    "tenderBondQar": 1500000,
    "participantCount": 9,
    "awardedCount": 3,
    "reportUrl": "https://monaqasat.mof.gov.qa/…",
    "takeaway": "…",              // the one-line qwen sentence, stored not re-derived
    "messageSent": "🏆 *TENDER AWARDED* — …",   // verbatim, as posted
    "participants": [{
      "company": "MANNAI TECHNOLOGIES",
      "cr": "36800",              // crPrimary — identity across tenders
      "stage": "awarded",         // awarded | technical | financial
      "approvedValueQar": 5807693.17,
      "proposalAmountQar": null,
      "localValueRatio": 87.96,
      "excluded": false           // notes === "Excluded"
    }]
  }]
}
```

**Keep the Code node dumb.** It reshapes rows and nothing else — no percentages,
no gaps, no rankings. All of that is derived in `ledger.js`, so redesigning the
dashboard never means touching n8n. And the model stays where it is: qwen writes
the one-line `takeaway` and nothing that carries a company name, a price, or a
winner.

`cr` (`crPrimary` in NocoDB) is what makes the rivals tally work — company names
are spelled inconsistently across reports, CR numbers are not.

## Local preview

```
npx serve .          # or: python -m http.server
```

Opening `index.html` directly via `file://` will fail — `fetch` of the JSON is
blocked by CORS on the file protocol.

## Known data quirks

- Records sent before 26 Aug 2026 12:58 carry a placeholder source link in
  `messageSent` (`golden-eye-frontend.vercel.app`) from before the URL fix. The
  working link is always in `reportUrl`.
- A bidder appears once per lot on the source page, so the bid ladder keeps only
  each company's lowest published figure.
- Some tenders publish a price only against the winning companies. The ladder
  then shows winners only and says so; there is no price gap to read.
