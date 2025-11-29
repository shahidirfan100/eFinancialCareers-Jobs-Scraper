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
                        
                        // Extract job title - multiple strategies
                        data.title = $('h1').first().text().trim() || 
                                   $('efc-job-header-description h1').first().text().trim() ||
                                   $('[data-gtm-category="job-header"] h1').first().text().trim() ||
                                   $('title').text().split('|')[0].trim() ||
                                   null;
                        
                        // Extract company and location - multiple strategies
                        let companyLocationText = '';
                        
                        // Strategy 1: Look in header section spans
                        $('efc-job-header-description span').each((_, el) => {
                            const text = $(el).text().trim();
                            if (text && text.length > 5 && text.length < 150 && !text.includes('Apply') && !companyLocationText) {
                                companyLocationText = text;
                            }
                        });
                        
                        // Strategy 2: Look in h1 parent
                        if (!companyLocationText) {
                            const headerSection = $('h1').parent();
                            headerSection.find('span, p, div').each((_, el) => {
                                const text = $(el).text().trim();
                                if (text && text.length > 5 && text.length < 150 && !text.includes('Apply') && !companyLocationText) {
                                    companyLocationText = text;
                                }
                            });
                        }
                        
                        // Strategy 3: Look for any text after h1
                        if (!companyLocationText) {
                            const headerSection = $('h1').parent();
                            const allText = headerSection.text().replace(data.title || '', '').trim();
                            const lines = allText.split('\n').filter(l => l.trim().length > 5 && l.trim().length < 150);
                            if (lines.length > 0) {
                                companyLocationText = lines[0].trim();
                            }
                        }
                        
                        // Parse company and location
                        if (companyLocationText) {
                            // Pattern 1: "Company City, Country" or "Company City, State"
                            const commaMatch = companyLocationText.match(/^(.+?)\s+([A-Za-z\s]+,\s*[A-Za-z\s]+)$/);
                            if (commaMatch) {
                                data.company = commaMatch[1].trim();
                                data.location = commaMatch[2].trim();
                            } else {
                                // Pattern 2: Split by spaces, last 2-3 words are location
                                const parts = companyLocationText.split(/\s+/);
                                if (parts.length >= 3) {
                                    // Check if last parts look like location (capitalized words)
                                    const lastThree = parts.slice(-3).join(' ');
                                    const lastTwo = parts.slice(-2).join(' ');
                                    
                                    if (lastThree.match(/^[A-Z][a-z]+.*[A-Z][a-z]+/)) {
                                        data.location = lastThree;
                                        data.company = parts.slice(0, -3).join(' ').trim();
                                    } else if (lastTwo.match(/^[A-Z][a-z]+.*[A-Z][a-z]+/)) {
                                        data.location = lastTwo;
                                        data.company = parts.slice(0, -2).join(' ').trim();
                                    } else {
                                        data.company = companyLocationText;
                                        data.location = null;
                                    }
                                } else {
                                    data.company = companyLocationText;
                                    data.location = null;
                                }
                            }
                        } else {
                            data.company = null;
                            data.location = null;
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
                        
                        // Final fallback: if still no description, get all paragraphs
                        if (!description_html) {
                            const paragraphs = [];
                            $('p, ul, ol').each((_, el) => {
                                const text = $(el).text().trim();
                                if (text.length > 50 && !text.match(/recommended jobs|boost your career|sign in|apply now/i)) {
                                    paragraphs.push($(el));
                                }
                            });
                            
                            if (paragraphs.length > 3) {
                                const combined = paragraphs.map(p => p.prop('outerHTML')).join('\n');
                                description_html = cleanDescriptionHtml(combined);
                            }
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
                        
                        // Look for date posted, job type, and salary in efc-job-meta first
                        const jobMeta = $('efc-job-meta').text().trim();
                        
                        if (jobMeta) {
                            // Extract date from meta (e.g., "Posted 5 days ago")
                            const dateMatch = jobMeta.match(/Posted\s+(\d+\s+(?:hour|day|week|month)s?\s+ago)/i) ||
                                            jobMeta.match(/(\d+\s+(?:hour|day|week|month)s?\s+ago)/i);
                            if (dateMatch) {
                                date_posted = dateMatch[1];
                            }
                            
                            // Extract job type from meta
                            const typeMatch = jobMeta.match(/\b(Permanent|Contract|Full time|Part time|Temporary|Freelance|Internship)\b/i);
                            if (typeMatch) {
                                job_type = typeMatch[1];
                            }
                            
                            // Extract salary from meta
                            const salaryMatch = jobMeta.match(/([\$£€][\d,]+(?:\s*-\s*[\$£€][\d,]+)?(?:\s*k|K)?|Competitive)/i);
                            if (salaryMatch) {
                                salary = salaryMatch[1];
                            }
                        }
                        
                        // Fallback: search in all elements if not found in meta
                        if (!date_posted || !job_type || !salary) {
                            $('*').each((_, el) => {
                                const text = $(el).text().trim();
                                
                                // Only process short text elements to avoid garbage
                                if (text.length > 100) return;
                                
                                // Check for date patterns
                                if (!date_posted && text.match(/\d+\s+(?:hour|day|week|month)s?\s+ago/i)) {
                                    const match = text.match(/(\d+\s+(?:hour|day|week|month)s?\s+ago)/i);
                                    if (match) {
                                        date_posted = match[1];
                                    }
                                }
                                
                                // Check for job type
                                if (!job_type && text.match(/^(Permanent|Contract|Full time|Part time|Temporary|Freelance|Internship)$/i)) {
                                    job_type = text;
                                }
                                
                                // Check for salary patterns
                                if (!salary && text.match(/[\$£€][\d,]+|Competitive/i)) {
                                    const salaryMatch = text.match(/([\$£€][\d,]+(?:\s*-\s*[\$£€][\d,]+)?(?:\s*k|K)?|Competitive)/i);
                                    if (salaryMatch) {
                                        salary = salaryMatch[1];
                                    }
                                }
                            });
                        }
                        
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

                        // Log missing fields for debugging
                        const missingFields = [];
                        if (!item.title) missingFields.push('title');
                        if (!item.company) missingFields.push('company');
                        if (!item.location) missingFields.push('location');
                        if (!item.description_html) missingFields.push('description');
                        
                        if (missingFields.length > 0) {
                            crawlerLog.warning(`Job #${saved + 1} missing fields: ${missingFields.join(', ')} - ${request.url}`);
                        }
                        
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
