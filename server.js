const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ success: false, error: 'Address required' });

  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
    });
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'networkidle2' });
    const title = await page.title();
    await browser.close();

    res.json({ success: true, title });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('API running on port', PORT);
});
