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
            
            // Remove all custom Angular/web components
            $('*').each((_, el) => {
                const tagName = el.name || '';
                if (tagName.includes('-') || tagName.startsWith('efc')) {
                    // Keep the content but remove the tag
                    $(el).replaceWith($(el).html() || '');
                }
            });
            
            // Remove unwanted elements
            $('script, style, noscript, iframe, svg, img, button, form, input, select, textarea, nav, header, footer, aside, a[role="button"]').remove();
            
            // Remove all attributes
            $('*').each((_, el) => {
                const attrs = Object.keys(el.attribs || {});
                attrs.forEach(attr => {
                    $(el).removeAttr(attr);
                });
            });
            
            // Get cleaned HTML
            let cleaned = $.html();
            
            // Remove the wrapper div
            cleaned = cleaned.replace(/^<div>|<\/div>$/g, '');
            
            // Clean up empty tags (multiple passes)
            for (let i = 0; i < 3; i++) {
                cleaned = cleaned.replace(/<(\w+)>\s*<\/\1>/g, '');
            }
            
            // Remove excessive whitespace
            cleaned = cleaned.replace(/\s+/g, ' ').trim();
            
            return cleaned || null;
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
            maxRequestRetries: 3,
            useSessionPool: true,
            persistCookiesPerSession: true,
            maxConcurrency: 10,
            minConcurrency: 5,
            requestHandlerTimeoutSecs: 60,
            navigationTimeoutSecs: 45,
            // Session rotation
            sessionPoolOptions: {
                maxPoolSize: 50,
                sessionOptions: {
                    maxUsageCount: 50,
                    maxErrorScore: 5,
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
                };
            }],
            async requestHandler({ request, $, enqueueLinks, log: crawlerLog, crawler: crawlerInstance }) {
                const label = request.userData?.label || 'LIST';
                const pageNo = request.userData?.pageNo || 1;

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
                        
                        // Extract job description - multiple strategies
                        let description_html = null;
                        
                        // Strategy 1: Target efc-job-description with any Angular attribute
                        let jobDescElem = $('efc-job-description').find('div').first();
                        if (jobDescElem.length > 0 && jobDescElem.text().length > 200) {
                            description_html = jobDescElem.html();
                        }
                        
                        // Strategy 2: Look for divs inside efc-job-description
                        if (!description_html) {
                            $('efc-job-description div').each((_, el) => {
                                const text = $(el).text();
                                if (text.length > 300 && text.match(/responsibilities|requirements|qualifications/i)) {
                                    description_html = $(el).html();
                                    return false;
                                }
                            });
                        }
                        
                        // Strategy 3: Find the largest text block with job keywords
                        if (!description_html) {
                            let maxScore = 0;
                            let bestElem = null;
                            
                            $('div').each((_, el) => {
                                const elem = $(el);
                                const text = elem.text();
                                const html = elem.html();
                                
                                if (text.length > 300 && text.length < 15000 && html) {
                                    // Check if contains job description keywords
                                    const hasKeywords = text.match(/responsibilities|requirements|qualifications|experience|skills/i);
                                    // Exclude unwanted sections
                                    const isUnwanted = text.match(/recommended jobs|boost your career|sign in|apply now|more jobs|matching jobs/i);
                                    
                                    if (hasKeywords && !isUnwanted) {
                                        // Score based on length and keyword density
                                        const keywordCount = (text.match(/responsibilities|requirements|qualifications|experience|skills|benefits/gi) || []).length;
                                        const score = text.length + (keywordCount * 100);
                                        
                                        if (score > maxScore) {
                                            maxScore = score;
                                            bestElem = elem;
                                        }
                                    }
                                }
                            });
                            
                            if (bestElem) {
                                description_html = bestElem.html();
                            }
                        }
                        
                        // Clean the extracted HTML
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
