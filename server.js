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
  
  // Set user agent to appear more like a real browser
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  // Set viewport
  await page.setViewport({ width: 1366, height: 768 });
  
  // Add extra headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  });

  try {
    console.log('Navigating to search page...');
    
    // First, try to visit the main site to get cookies
    await page.goto('https://qpublic.schneidercorp.com/', { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    await page.waitForTimeout(2000);
    
    // Now navigate to the search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&PageType=Search',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );

    console.log('Current URL:', page.url());
    console.log('Page title:', await page.title());
    
    // Check if we're blocked by Cloudflare
    const title = await page.title();
    if (title.includes('Cloudflare') || title.includes('Attention')) {
      console.log('Detected Cloudflare challenge');
      
      // Wait longer for potential auto-redirect
      await page.waitForTimeout(10000);
      
      // Check if we've been redirected
      const newUrl = page.url();
      const newTitle = await page.title();
      console.log('After wait - URL:', newUrl);
      console.log('After wait - Title:', newTitle);
      
      if (newTitle.includes('Cloudflare')) {
        throw new Error('Blocked by Cloudflare bot protection');
      }
    }
    
    // Continue with the search...
    const norm = normalizeAddress(address);
    console.log('Normalized address:', norm);
    
    // Wait for page to fully load
    await page.waitForTimeout(3000);
    
    // Try to find and fill the address input
    const addressInput = await page.$('#ctlBodyPane_ctl01_ctl01_txtAddress');
    if (!addressInput) {
      throw new Error('Address input field not found');
    }
    
    await addressInput.click();
    await page.keyboard.type(norm);
    await page.keyboard.press('Enter');
    
    // Wait for results
    await page.waitForTimeout(5000);
    
    // Check for results
    try {
      await page.waitForSelector('table.searchResultsGrid a', { timeout: 5000 });
      await page.click('table.searchResultsGrid tbody tr:first-child a');
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('No results table found');
    }
    
    // Extract owner info
    const result = await page.evaluate(() => {
      const clean = txt => (txt || '').replace(/\s+/g, ' ').trim();
      let owner = 'Not found';
      let mailing = 'Not found';
      
      const cells = Array.from(document.querySelectorAll('td'));
      
      for (let i = 0; i < cells.length; i++) {
        const cellText = cells[i].textContent || '';
        
        if (/Most Current Owner/i.test(cellText) && cells[i + 1]) {
          owner = clean(cells[i + 1].textContent);
        }
        
        if (/Mailing Address/i.test(cellText) && cells[i + 1]) {
          mailing = clean(cells[i + 1].textContent);
        }
      }
      
      return { owner, mailing };
    });

    return {
      success: true,
      owner_name: result.owner,
      mailing_address: result.mailing
    };

  } catch (err) {
    console.error('Error:', err.message);
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
  const data = await fetchOwnerData(address);
  res.json(data);
});

app.get('/', (req, res) => res.send('Fulton Scraper API running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
