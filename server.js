// server.js – Complete Fulton County Property Owner Lookup API

const express = require('express');
const { connect } = require('puppeteer-real-browser');

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
  let browser = null;
  
  try {
    // Use puppeteer-real-browser to bypass Cloudflare
    const response = await connect({
      headless: 'auto',
      fingerprint: true,
      turnstile: true,
      tf: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    browser = response.browser;
    const page = response.page;

    console.log('Navigating to Fulton County search page...');
    
    // Navigate to the search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&PageType=Search',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );

    // Check if Cloudflare blocked us
    const title = await page.title();
    console.log('Page title:', title);
    
    if (title.includes('Cloudflare') || title.includes('Attention')) {
      throw new Error('Still blocked by Cloudflare - may need proxy or different approach');
    }

    // Normalize the address
    const norm = normalizeAddress(address);
    console.log('Searching for normalized address:', norm);
    
    // Wait for page to load completely
    await page.waitForTimeout(3000);
    
    // Try multiple selectors for the address input
    let addressInput = null;
    
    // Try common input selectors
    const selectors = [
      'input[placeholder*="address"]',
      'input[name="txtSearchText"]', 
      'input[type="text"]',
      '#ctlBodyPane_ctl01_ctl01_txtAddress'
    ];
    
    for (const selector of selectors) {
      try {
        addressInput = await page.$(selector);
        if (addressInput) {
          console.log(`Found input using selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!addressInput) {
      throw new Error('Could not find address input field on the page');
    }
    
    // Clear and fill the address input
    await addressInput.click({ clickCount: 3 });
    await addressInput.type(norm);
    
    // Submit the form
    await page.keyboard.press('Enter');
    
    // Wait for results
    await page.waitForTimeout(5000);
    
    // Try to click on the first search result
    try {
      await page.waitForSelector('table.searchResultsGrid a', { timeout: 10000 });
      await page.click('table.searchResultsGrid tbody tr:first-child a');
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('No search results table found or no results');
    }
    
    // Extract owner information
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

  } catch (error) {
    console.error('Error in fetchOwnerData:', error.message);
    return {
      success: false,
      error: error.message
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// API endpoints
app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({
      success: false,
      error: 'address field required'
    });
  }
  
  console.log('Searching for address:', address);
  const data = await fetchOwnerData(address);
  res.json(data);
});

app.get('/', (req, res) => res.send('Fulton Scraper API running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
