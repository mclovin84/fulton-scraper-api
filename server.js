// server.js – Fulton County Property Owner Lookup API

const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

function normalizeAddress(address) {
  const ABBREV = {
    'STREET':'ST','AVENUE':'AVE','BOULEVARD':'BLVD','DRIVE':'DR',
    'ROAD':'RD','LANE':'LN','COURT':'CT','CIRCLE':'CIR','PLACE':'PL',
    'PARKWAY':'PKWY','TRAIL':'TRL','TERRACE':'TER','PLAZA':'PLZ',
    'ALLEY':'ALY','BRIDGE':'BRG','BYPASS':'BYP','CAUSEWAY':'CSWY',
    'CENTER':'CTR','CROSSING':'XING','EXPRESSWAY':'EXPY','EXTENSION':'EXT',
    'FREEWAY':'FWY','HEIGHTS':'HTS','HIGHWAY':'HWY','JUNCTION':'JCT',
    'NORTH':'N','SOUTH':'S','EAST':'E','WEST':'W',
    'NORTHEAST':'NE','NORTHWEST':'NW','SOUTHEAST':'SE','SOUTHWEST':'SW',
    'MARTIN LUTHER KING JR':'M L KING JR','MARTIN LUTHER KING':'M L KING','MLK':'M L KING'
  };
  let s = address.toUpperCase().replace(/[.,#]/g,' ');
  for (const [k,v] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  }
  s = s.replace(/\b(ATLANTA|AUGUSTA|COLUMBUS|MACON|SAVANNAH|ATHENS|GA|GEORGIA)\b.*$/,'').trim();
  return s.replace(/\s+/g,' ');
}

async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    // Set viewport and user agent to ensure consistent rendering
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    // 1) Navigate to search page with longer timeout
    console.log('Navigating to Fulton County search page...');
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil: 'networkidle0', timeout: 60000 }
    );

    // 2) Wait a bit for any dynamic content to load
    await page.waitForTimeout(3000);

    // 3) Accept terms if present
    try {
      const agreeBtn = await page.$('input[type="button"][value*="Agree"], input[type="submit"][value*="Agree"]');
      if (agreeBtn) {
        console.log('Accepting terms...');
        await agreeBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log('No terms to accept');
    }

    // 4) Wait for the address input field to be visible and interactable
    console.log('Waiting for address input field...');
    await page.waitForSelector('#ctlBodyPane_ctl01_ctl01_txtAddress', { 
      visible: true, 
      timeout: 20000 
    });

    // Additional wait to ensure JavaScript has initialized
    await page.waitForTimeout(1000);

    // 5) Focus and clear the field first
    await page.focus('#ctlBodyPane_ctl01_ctl01_txtAddress');
    await page.evaluate(() => {
      document.querySelector('#ctlBodyPane_ctl01_ctl01_txtAddress').value = '';
    });

    // 6) Type the normalized address
    const norm = normalizeAddress(address);
    console.log(`Typing normalized address: ${norm}`);
    await page.type('#ctlBodyPane_ctl01_ctl01_txtAddress', norm, { delay: 50 });

    // 7) Small delay to let any autocomplete settle
    await page.waitForTimeout(1000);

    // 8) Click the search button
    console.log('Clicking search button...');
    await page.click('#ctlBodyPane_ctl01_ctl01_btnSearch');

    // 9) Wait for navigation or results to load
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }),
      page.waitForSelector('table.searchResultsGrid', { timeout: 30000 })
    ]);

    // 10) Wait for and click the first result
    console.log('Waiting for search results...');
    await page.waitForSelector('table.searchResultsGrid a', { timeout: 15000 });
    
    // Get the first result link
    const firstResult = await page.$('table.searchResultsGrid tbody tr:first-child a');
    if (!firstResult) {
      throw new Error('No search results found');
    }
    
    await firstResult.click();

    // 11) Wait for property details page
    await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 });

    // 12) Wait for owner information to load
    console.log('Extracting owner information...');
    await page.waitForFunction(
      () => {
        const text = document.body.innerText || '';
        return text.includes('Most Current Owner') || text.includes('Owner Name') || text.includes('Current Owner');
      },
      { timeout: 15000 }
    );

    // 13) Extract owner & mailing address
    const result = await page.evaluate(() => {
      const clean = txt => (txt || '').replace(/\s+/g, ' ').trim();
      let owner = 'Not found';
      let mailing = 'Not found';
      
      // Get all table cells
      const cells = Array.from(document.querySelectorAll('td'));
      
      for (let i = 0; i < cells.length; i++) {
        const cellText = cells[i].textContent || '';
        
        // Look for owner
        if (/Most Current Owner/i.test(cellText)) {
          if (cells[i + 1]) {
            owner = clean(cells[i + 1].textContent);
          } else if (cells[i].nextElementSibling) {
            owner = clean(cells[i].nextElementSibling.textContent);
          }
        }
        
        // Look for mailing address
        if (/Mailing Address/i.test(cellText)) {
          if (cells[i + 1]) {
            mailing = clean(cells[i + 1].textContent);
          } else if (cells[i].nextElementSibling) {
            mailing = clean(cells[i].nextElementSibling.textContent);
          }
        }
      }
      
      return { owner, mailing };
    });

    console.log('Successfully extracted data');
    return {
      success: true,
      owner_name: result.owner,
      mailing_address: result.mailing
    };

  } catch (err) {
    console.error('Scrape error:', err.message);
    
    // Try to get current page URL for debugging
    try {
      const currentUrl = page.url();
      console.error('Current page URL:', currentUrl);
    } catch (e) {
      // Ignore if we can't get URL
    }
    
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// API endpoints
app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ success: false, error: 'address field required' });
  }
  console.log(`Received request for address: ${address}`);
  const data = await fetchOwnerData(address);
  res.json(data);
});

// Root and health routes
app.get('/', (req, res) => res.send('Fulton Scraper API running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
