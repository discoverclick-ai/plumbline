import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const OUT = '/tmp/claude-0/demo/shots'
await mkdir(OUT, { recursive: true })
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const browser = await chromium.launch({ executablePath: CHROME })
async function session(email, viewport = { width: 1440, height: 940 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', 'plumbline-demo')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForTimeout(3000)
  return page
}
const pm = await session('pm@ridgeline.test')
console.log('PORTFOLIO', (await pm.locator('body').innerText()).slice(0, 900))
await pm.screenshot({ path: `${OUT}/01-portfolio.png` })
await pm.getByText('Harbor Point Phase II').first().click()
await pm.waitForTimeout(3000)
await pm.screenshot({ path: `${OUT}/02-project.png` })
console.log('PROJECT', (await pm.locator('body').innerText()).slice(0, 700))
await browser.close()
