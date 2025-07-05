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
    console.log('Step 1: Navigating to search page...');
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&PageType=Search',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );

    console.log('Step 2: Current URL:', page.url());
    
    // Check if we need to accept terms
    const pageContent = await page.content();
    if (pageContent.includes('Agree') || pageContent.includes('Accept')) {
      console.log('Step 3: Found terms, accepting...');
      try {
        await page.click('input[value*="Agree"]');
        await page.waitForTimeout(3000);
        console.log('Terms accepted, new URL:', page.url());
      } catch (e) {
        console.log('Could not click agree button');
      }
    }

    // Debug: Check what's on the page
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type="text"]')).map(input => ({
        id: input.id,
        name: input.name,
        placeholder: input.placeholder,
        visible: window.getComputedStyle(input).display !== 'none'
      }));
    });
    console.log('Available text inputs:', JSON.stringify(inputs, null, 2));

    // Try different ways to find the address input
    let addressInput = null;
    
    // Method 1: Direct ID
    try {
      addressInput = await page.$('#ctlBodyPane_ctl01_ctl01_txtAddress');
      if (addressInput) console.log('Found input by ID');
    } catch (e) {}

    // Method 2: Find by placeholder
    if (!addressInput) {
      addressInput = await page.evaluateHandle(() => {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const input of inputs) {
          if (input.placeholder && input.placeholder.toLowerCase().includes('address')) {
            return input;
          }
        }
        return null;
      });
      if (addressInput) console.log('Found input by placeholder');
    }

    if (!addressInput) {
      throw new Error('Could not find address input field');
    }

    // Type the address
    const norm = normalizeAddress(address);
    console.log('Typing address:', norm);
    
    await page.evaluate((input, text) => {
      input.focus();
      input.value = text;
    }, addressInput, norm);

    // Trigger search
    await page.keyboard.press('Enter');
    
    console.log('Waiting for results...');
    await page.waitForTimeout(5000);

    // Check if we're on results page or property page
    const currentUrl = page.url();
    console.log('After search URL:', currentUrl);

    // Try to click first result
    try {
      await page.waitForSelector('table.searchResultsGrid a', { timeout: 5000 });
      console.log('Found results table, clicking first result...');
      await page.click('table.searchResultsGrid tbody tr:first-child a');
      await page.waitForTimeout(3000);
    } catch (e) {
      console.log('No results table found, checking if already on property page');
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

    console.log('Extracted data:', result);

    return {
      success: true,
      owner_name: result.owner,
      mailing_address: result.mailing
    };

  } catch (err) {
    console.error('Error details:', err);
    
    // Get current page state for debugging
    try {
      const debugInfo = {
        url: page.url(),
        title: await page.title()
      };
      console.error('Page debug info:', debugInfo);
    } catch (e) {}
    
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
  console.log(`Searching for address: ${address}`);
  const data = await fetchOwnerData(address);
  res.json(data);
});

app.get('/', (req, res) => res.send('Fulton Scraper API running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
