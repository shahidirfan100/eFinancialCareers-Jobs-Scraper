// eFinancialCareers jobs scraper - CheerioCrawler implementation
import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';
import { load as cheerioLoad } from 'cheerio';
import { HeaderGenerator } from 'header-generator';

const headerGenerator = new HeaderGenerator({
    browsers: [
        { name: 'chrome', minVersion: 120, maxVersion: 131 },
        { name: 'edge', minVersion: 120, maxVersion: 131 },
    ],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
    locales: ['en-US', 'en-GB'],
});

// Single-entrypoint main
await Actor.init();

async function main() {
    try {
        const input = (await Actor.getInput()) || {};
        const {
            keyword = '', location = '', category = '', results_wanted: RESULTS_WANTED_RAW = 100,
            max_pages: MAX_PAGES_RAW = 10, collectDetails = true, startUrl, startUrls, url, proxyConfiguration,
        } = input;

        const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : Number.MAX_SAFE_INTEGER;
        const MAX_PAGES = Number.isFinite(+MAX_PAGES_RAW) ? Math.max(1, +MAX_PAGES_RAW) : 10;

        const toAbs = (href, base = 'https://www.efinancialcareers.com') => {
            try { return new URL(href, base).href; } catch { return null; }
        };

        const cleanText = (html) => {
            if (!html) return '';
            const $ = cheerioLoad(html);
            $('script, style, noscript, iframe, svg, path, img').remove();
            return $.root().text().replace(/\s+/g, ' ').trim();
        };

        const cleanDescriptionHtml = (html) => {
            if (!html) return null;
            const $ = cheerioLoad(`<div>${html}</div>`);
            // Remove unwanted elements
            $('script, style, noscript, iframe, svg, img, button, form, input, select, textarea, nav, header, footer, aside, efc-apply-button, efc-saved-job, efc-icon, efc-job-buttons-container, a[role="button"]').remove();
            // Remove all Angular custom elements that aren't content-related
            $('efc-recruiter-info, efc-about-company, efc-company-jobs, efc-job-details-sidebar, efc-call-to-action, efc-recommended-jobs, efc-matching-jobs').remove();
            // Remove all attributes including Angular ones
            $('*').each((_, el) => {
                const attrs = Object.keys(el.attribs || {});
                attrs.forEach(attr => {
                    $(el).removeAttr(attr);
                });
            });
            // Get cleaned HTML
            let cleaned = $.html();
            // Remove the wrapper div we added
            cleaned = cleaned.replace(/^<div>|<\/div>$/g, '');
            // Clean up empty tags
            cleaned = cleaned.replace(/<(\w+)>\s*<\/\1>/g, '');
            return cleaned.trim() || null;
        };

        const buildStartUrl = (kw, loc, cat) => {
            const u = new URL('https://www.efinancialcareers.com/jobs');
            if (kw) u.searchParams.set('q', String(kw).trim());
            if (loc) u.searchParams.set('location', String(loc).trim());
            // category not directly supported in URL
            return u.href;
        };

        const initial = [];
        if (Array.isArray(startUrls) && startUrls.length) initial.push(...startUrls);
        if (startUrl) initial.push(startUrl);
        if (url) initial.push(url);
        if (!initial.length) initial.push(buildStartUrl(keyword, location, category));

        const proxyConf = proxyConfiguration ? await Actor.createProxyConfiguration({ ...proxyConfiguration }) : undefined;

        let saved = 0;
        const seenUrls = new Set();

        function findJobLinks($, base) {
            const links = new Set();
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href');
                if (!href) return;
                // Match eFinancialCareers job URLs: /jobs-Location-Title.idNUMBER
                if (/\/jobs-[^\/]+\.id\d+/i.test(href)) {
                    const abs = toAbs(href, base);
                    if (abs && !seenUrls.has(abs)) {
                        links.add(abs);
                        seenUrls.add(abs);
                    }
                }
            });
            return [...links];
        }

        const crawler = new CheerioCrawler({
            proxyConfiguration: proxyConf,
            maxRequestRetries: 5,
            useSessionPool: true,
            persistCookiesPerSession: true,
            maxConcurrency: 2,
            minConcurrency: 1,
            requestHandlerTimeoutSecs: 120,
            navigationTimeoutSecs: 90,
            maxRequestsPerMinute: 20,
            // Session rotation for better stealth
            sessionPoolOptions: {
                maxPoolSize: 20,
                sessionOptions: {
                    maxUsageCount: 10,
                    maxErrorScore: 3,
                },
            },
            // Add realistic headers
            preNavigationHooks: [async ({ request, session }, gotoOptions) => {
                const headers = headerGenerator.getHeaders({
                    operatingSystem: 'windows',
                    browser: 'chrome',
                });
                
                request.headers = {
                    ...headers,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'max-age=0',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'DNT': '1',
                };
            }],
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog, crawler: crawlerInstance }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

                // Human-like delays with exponential backoff
                const baseDelay = label === 'LIST' ? 3000 : 5000; // Longer delay for detail pages
                const jitter = Math.random() * 2000;
                const retryMultiplier = (request.retryCount || 0) * 2000; // Add delay on retries
                await new Promise(resolve => setTimeout(resolve, baseDelay + jitter + retryMultiplier));
                
                // Simulate human reading time on detail pages
                if (label === 'DETAIL') {
                    await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 3000));
                }

                if (label === 'LIST') {
                    const links = findJobLinks($, request.url);
                    crawlerLog.info(`LIST page ${pageNo} [${request.url}] -> found ${links.length} unique job links`);

                    if (collectDetails) {
                        const remaining = RESULTS_WANTED - saved;
                        const toEnqueue = links.slice(0, Math.max(0, remaining));
                        if (toEnqueue.length > 0) {
                            crawlerLog.info(`Enqueuing ${toEnqueue.length} job detail pages`);
                            await enqueueLinks({ urls: toEnqueue, userData: { label: 'DETAIL' } });
                        }
                    } else {
                        const remaining = RESULTS_WANTED - saved;
                        const toPush = links.slice(0, Math.max(0, remaining));
                        if (toPush.length > 0) { 
                            await Dataset.pushData(toPush.map(u => ({ url: u, _source: 'efinancialcareers' }))); 
                            saved += toPush.length; 
                            crawlerLog.info(`Saved ${toPush.length} job URLs (total: ${saved})`);
                        }
                    }

                    // Check if we need to fetch more pages
                    if (saved < RESULTS_WANTED && pageNo < MAX_PAGES && links.length > 0) {
                        const nextUrl = new URL(request.url);
                        nextUrl.searchParams.set('page', (pageNo + 1).toString());
                        crawlerLog.info(`Enqueueing next page: ${pageNo + 1}`);
                        await crawlerInstance.addRequests([{ url: nextUrl.href, userData: { label: 'LIST', pageNo: pageNo + 1 } }]);
                    } else {
                        crawlerLog.info(`Pagination stopped: saved=${saved}, pageNo=${pageNo}, links=${links.length}`);
                    }
                    return;
                }

                if (label === 'DETAIL') {
                    if (saved >= RESULTS_WANTED) {
                        crawlerLog.info(`Skipping detail page - already reached target: ${saved}/${RESULTS_WANTED}`);
                        return;
                    }
                    try {
                        const data = {};
                        
                        // Extract job title from h1
                        data.title = $('h1').first().text().trim() || null;
                        
                        // Extract company and location - they appear after h1 in the format "Company Location"
                        // Look for text immediately after the h1
                        const headerSection = $('h1').parent();
                        let companyLocationText = '';
                        
                        // Try to find company and location in various possible locations
                        headerSection.find('p, div').each((_, el) => {
                            const text = $(el).text().trim();
                            if (text && text.length < 200 && !companyLocationText) {
                                companyLocationText = text;
                            }
                        });
                        
                        if (!companyLocationText) {
                            // Fallback: look for text nodes near h1
                            companyLocationText = headerSection.text().replace(data.title || '', '').trim();
                        }
                        
                        // Parse company and location from format "CompanyName Location, Country"
                        if (companyLocationText) {
                            // Common patterns: "Company City, Country" or "Company City, State"
                            const parts = companyLocationText.split(/\s+/);
                            if (parts.length >= 2) {
                                // Last 2-3 parts are likely location
                                const locationParts = [];
                                for (let i = parts.length - 1; i >= 0 && locationParts.length < 3; i--) {
                                    if (parts[i].match(/^[A-Z][a-z]+,?$/) || parts[i].match(/^[A-Z]{2,}$/)) {
                                        locationParts.unshift(parts[i].replace(/,$/, ''));
                                    } else if (locationParts.length > 0) {
                                        break;
                                    }
                                }
                                
                                if (locationParts.length > 0) {
                                    data.location = locationParts.join(', ');
                                    data.company = parts.slice(0, parts.length - locationParts.length).join(' ').trim();
                                } else {
                                    data.company = companyLocationText;
                                    data.location = null;
                                }
                            } else {
                                data.company = companyLocationText;
                                data.location = null;
                            }
                        }
                        
                        // Extract job description - target specific eFinancialCareers structure
                        let description_html = null;
                        
                        // Target the efc-job-description component specifically
                        const jobDescElem = $('efc-job-description div[_ngcontent-ng-c3589833976]').first();
                        
                        if (jobDescElem.length > 0) {
                            description_html = jobDescElem.html();
                        } else {
                            // Fallback: look for content with job-related keywords
                            const possibleDescriptions = [];
                            $('div').each((_, el) => {
                                const elem = $(el);
                                const text = elem.text();
                                const html = elem.html();
                                const children = elem.children().length;
                                
                                // Look for elements with substantial content but not too many nested elements
                                if (text.length > 300 && text.length < 20000 && html && html.length > 400 && children < 50) {
                                    if (text.match(/responsibilities|requirements|qualifications|experience|skills|benefits|description/i)) {
                                        // Exclude navigation, headers, sidebars
                                        if (!text.match(/recommended jobs|boost your career|sign in|apply now/i)) {
                                            possibleDescriptions.push({ text, html, score: text.length });
                                        }
                                    }
                                }
                            });
                            
                            if (possibleDescriptions.length > 0) {
                                possibleDescriptions.sort((a, b) => b.score - a.score);
                                description_html = possibleDescriptions[0].html;
                            }
                        }
                        
                        if (description_html) {
                            description_html = cleanDescriptionHtml(description_html);
                        }
                        
                        data.description_html = description_html;
                        data.description_text = description_html ? cleanText(description_html) : null;
                        
                        // Extract date posted, job type, salary, and job ID
                        let date_posted = null;
                        let job_type = null;
                        let salary = null;
                        let job_id = null;
                        
                        // Extract job ID from URL
                        const urlMatch = request.url.match(/\.id(\d+)/);
                        if (urlMatch) {
                            job_id = urlMatch[1];
                        }
                        
                        // Look for date posted
                        $('*').each((_, el) => {
                            const text = $(el).text().trim();
                            
                            // Check for date patterns
                            if (!date_posted && (text.includes('Posted') || text.includes('ago'))) {
                                const match = text.match(/Posted\s+(.+?)(?:ago|$)/i) || 
                                             text.match(/(\d+\s+(?:hour|day|week|month)s?\s+ago)/i) ||
                                             text.match(/Posted\s+(\d+\s+(?:hour|day|week|month)s?)/i);
                                if (match) {
                                    date_posted = match[1].trim();
                                    if (!date_posted.includes('ago')) date_posted += ' ago';
                                }
                            }
                            
                            // Check for job type (Permanent, Contract, Full time, Part time, etc.)
                            if (!job_type && text.match(/^(Permanent|Contract|Full time|Part time|Temporary|Freelance|Internship)$/i)) {
                                job_type = text;
                            }
                            
                            // Check for salary patterns
                            if (!salary && text.match(/\$[\d,]+|£[\d,]+|€[\d,]+|Competitive/i)) {
                                const salaryMatch = text.match(/([\$£€][\d,]+(?:\s*-\s*[\$£€][\d,]+)?(?:\s*(?:per year|annual|yearly|pa|k|K))?|Competitive)/i);
                                if (salaryMatch) {
                                    salary = salaryMatch[1].trim();
                                }
                            }
                        });
                        
                        data.date_posted = date_posted;
                        data.job_type = job_type;
                        data.salary = salary;
                        data.job_id = job_id;

                        const item = {
                            job_id: data.job_id || null,
                            title: data.title || null,
                            company: data.company || null,
                            category: category || null,
                            location: data.location || null,
                            job_type: data.job_type || null,
                            salary: data.salary || null,
                            date_posted: data.date_posted || null,
                            description_html: data.description_html || null,
                            description_text: data.description_text || null,
                            url: request.url,
                        };

                        await Dataset.pushData(item);
                        saved++;
                        crawlerLog.info(`Saved job #${saved}: ${data.title || 'Unknown'} at ${data.company || 'Unknown'}`);
                    } catch (err) { 
                        crawlerLog.error(`DETAIL ${request.url} failed: ${err.message}`, { stack: err.stack }); 
                    }
                }
            }
        });

        await crawler.run(initial.map(u => ({ url: u, userData: { label: 'LIST', pageNo: 1 } })));
        log.info(`Finished. Saved ${saved} items`);
    } finally {
        await Actor.exit();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
