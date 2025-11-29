# eFinancialCareers Jobs Scraper

This Apify actor scrapes job listings from eFinancialCareers using Crawlee's CheerioCrawler and gotScraping.

## Features

- Scrapes eFinancialCareers search results and job detail pages (no browser required).
- Prefers structured data (JSON-LD) where available, falls back to HTML parsing.
- Handles pagination until the requested number of results is reached.
- Optional detail scraping mode to fetch full job descriptions.
- Saves results to an Apify dataset using a consistent schema.

## Input

The actor accepts the following input fields (all optional unless noted):

- `keyword` (string) — Job title or skill to search for. If omitted, the actor fetches general listings.
- `location` (string) — Location filter.
- `category` (string) — Job category (currently not used in search URL).
- `startUrl` / `url` / `startUrls` — Specific eFinancialCareers search URL(s) to start from. If provided, these override keyword/location.
- `results_wanted` (integer) — Maximum number of job listings to collect. Default: 100.
- `max_pages` (integer) — Safety cap on number of listing pages to visit.
- `collectDetails` (boolean) — If true, the actor will visit each job detail page to extract full description. Default: true.
- `cookies` / `cookiesJson` — Optional cookies to include in requests.
- `proxyConfiguration` — Proxy settings (use Apify Proxy for best results).

## Output

Each item saved to the dataset follows this structure:

```
{
	"title": "...",
	"company": "...",
	"category": "...",
	"location": "...",
	"date_posted": "...",
	"description_html": "<p>...</p>",
	"description_text": "Plain text version of description",
	"url": "..."
}
```

## Notes

- The actor uses CheerioCrawler with gotScraping; no additional local packages are required beyond those in package.json.
- On Apify platform, provide `proxyConfiguration` and reasonable `results_wanted` to avoid rate limits.
- If eFinancialCareers changes their markup, selectors in `src/main.js` may need small updates.