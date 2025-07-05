/* server.js  –  Fulton County owner-lookup API */
const express    = require('express');
const puppeteer  = require('puppeteer-core');

const app = express();
app.use(express.json());

/* ----------
   helper: normalise the street address
   (simple version – works for 99 % of GA addresses;
    you can paste your longer n8n function later)
---------- */
function normalizeAddress(address) {
  return address.toUpperCase()
    .replace(/[.,#]/g, '')
    .replace(/\s+GA\s*\d{5}(-\d{4})?$/, '')   // strip city / GA / ZIP
    .trim();
}

/* ----------
   core scraper – connects to your Browserless
---------- */
async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT   // Railway injects it
  });

  const page = await browser.newPage();
  try {
    // 1. Fulton search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    // 2. Accept T&C if it appears
    const agreeBtn = await page.$('input[value*="agree" i]');
    if (agreeBtn) { await agreeBtn.click(); }

    // 3. Fill search box
    await page.waitForSelector('#SearchTextBox', { timeout: 10000 });
    const street = normalizeAddress(address);
    await page.type('#SearchTextBox', street);
    await page.keyboard.press('Enter');

    // 4. Wait for first result row
    await page.waitForSelector('table.searchResultsGrid a', { timeout: 15000 });
    await page.click('table.searchResultsGrid a');   // open parcel page

    // 5. Wait for owner section
    await page.waitForSelector('td:contains("Most Current Owner")', { timeout: 15000 });

    // 6. Extract owner & mailing address
    const data = await page.evaluate(() => {
      function clean(t) { return t.replace(/\s+/g,' ').trim(); }
      let owner   = 'Not found';
      let mailing = 'Not found';

      // owner name is usually in the next <td> after the label
      const label = [...document.querySelectorAll('td')]
        .find(td => /Most Current Owner/i.test(td.textContent));
      if (label && label.nextElementSibling) {
        owner = clean(label.nextElementSibling.textContent);
      }

      // mailing address usually in “Mailing Address” row
      const mailLabel = [...document.querySelectorAll('td')]
        .find(td => /Mailing Address/i.test(td.textContent));
      if (mailLabel && mailLabel.nextElementSibling) {
        mailing = clean(mailLabel.nextElementSibling.textContent);
      }
      return { owner, mailing };
    });

    return { success: true, owner_name: data.owner, mailing_address: data.mailing };
  } finally {
    await browser.close();
  }
}

/* ----------
   POST /fulton-property-search
---------- */
app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ success:false, error:'address field required' });

  try {
    const result = await fetchOwnerData(address);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, error: err.message });
  }
});

/* simple landing + health route so the root URL doesn’t 404 */
app.get('/',      (_,res)=>res.send('Fulton Scraper API running'));
app.get('/health',(_,res)=>res.json({ ok:true, ts:Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=>console.log('API listening on',PORT));
