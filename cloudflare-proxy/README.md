# Lensa Market Proxy (Cloudflare Worker)

این پوشه یک Cloudflare Worker مستقل و سبک است که جدا از سایت اصلی دیپلوی می‌شود.
کارش این است که بین مرورگر کاربر و صرافی‌ها (Binance/Bybit/OKX/Coinbase/CoinGecko)
قرار بگیرد تا:

1. هدر CORS رو خودش اضافه کنه (چون Binance/Bybit این هدر رو برای درخواست مستقیم مرورگر نمی‌فرستن).
2. درخواست رو از IP خودِ Cloudflare (نه IP کاربر) بفرسته، پس اگه صرافی IP کاربر
   (مثلاً IP ایران) رو geo-block کرده باشه (Binance 451 / Bybit 403)، این مشکل دور زده می‌شه.

## گام ۱: نصب Wrangler (ابزار CLI کلادفلر)

```bash
npm install -g wrangler
```

## گام ۲: لاگین به اکانت کلادفلر

```bash
wrangler login
```
یه تب مرورگر باز می‌شه، با اکانت Cloudflare‌ت (رایگان کافیه) لاگین کن.

## گام ۳: دیپلوی

```bash
cd cloudflare-proxy
wrangler deploy
```

خروجی یه چیزی شبیه این می‌ده:
```
Deployed lensa-market-proxy triggers
  https://lensa-market-proxy.<your-subdomain>.workers.dev
```

این URL رو نگه دار — همینه که باید توی env var سایت بذاری.

## گام ۴: تست سریع (قبل از وصل کردن به سایت)

```bash
curl "https://lensa-market-proxy.<your-subdomain>.workers.dev/proxy/binance/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=5"
```
اگه یه آرایه‌ی JSON از کندل‌ها برگشت (نه ارور 451/403)، یعنی پروکسی درست کار می‌کنه.

## گام ۵: وصل کردن به سایت (GitHub Actions)

توی ریپوی گیت‌هاب سایت:
`Settings → Secrets and variables → Actions → New repository secret`

- Name: `VITE_MARKET_PROXY_ENDPOINTS`
- Value: `https://lensa-market-proxy.<your-subdomain>.workers.dev`

`deploy.yml` (که توی patch اضافه شده) خودش این secret رو موقع build به Vite پاس می‌ده.
دفعه‌ی بعد که push کنی روی main، سایت با پروکسی جدید build و دیپلوی می‌شه.

برای تست لوکال، یه فایل `.env` (نه `.env.example`) بساز:
```
VITE_MARKET_PROXY_ENDPOINTS=https://lensa-market-proxy.<your-subdomain>.workers.dev
```

---

## چرا وقتی سهمیه‌ی Worker تموم بشه، سایت "منتظر" نمی‌مونه

Cloudflare Workers پلن رایگان روزی ۱۰۰٬۰۰۰ درخواست می‌ده. اگه این سهمیه توی یه روز
تموم بشه، Cloudflare دیگه درخواست رو route نمی‌کنه و یه ریسپانس ارور فوری برمی‌گردونه
(نه این‌که کاربر رو معطل نگه داره).

کد فرانت‌اند (`src/lib/coingecko.js`) دقیقاً برای همین سناریو طراحی شده:
- هر درخواست داده، اول پروکسی(ها) رو امتحان می‌کنه.
- اگه یه پروکسی جواب ارور (یا timeout بعد از ۸ ثانیه) بده، **فوراً** می‌ره سراغ
  پروکسی بعدی (اگه چندتا داری) یا مستقیم fetch از مرورگر — بدون هیچ صبر یا
  backoff طولانی.
- فقط برای ارور ۴۲۹ (rate limit واقعی) یه تلاش دوم و کوتاه (۵۰۰ میلی‌ثانیه) می‌زنه،
  چون این تنها حالتیه که صبر کوتاه واقعاً کمک می‌کنه.

یعنی اگه سهمیه‌ی یک Worker تموم بشه، کاربر حتی متوجه نمی‌شه — به‌صورت خودکار
درخواست بعدی (پروکسی دیگه یا مستقیم) رو امتحان می‌کنه و چارت لود می‌شه.

## می‌تونم روی چند تا اکانت کلادفلر این Worker رو اجرا کنم؟

بله، و این دقیقاً راه‌حل توصیه‌شده برای بالا بردن سقف روزانه‌ست:

1. با یه ایمیل دیگه یه اکانت رایگان Cloudflare جدید بساز.
2. همین پوشه‌ی `cloudflare-proxy/` رو کپی کن (یا فقط دوباره ازش دیپلوی کن)، ولی
   قبلش توی `wrangler.toml` مقدار `name` رو عوض کن (مثلاً `lensa-market-proxy-2`)
   تا با اکانت اول تداخل نکنه.
3. `wrangler login` کن (این بار با اکانت جدید — Wrangler هر بار می‌تونه به
   یه اکانت متفاوت لاگین بشه؛ اگه سشن قبلی کش شده، `wrangler logout` بزن اول).
4. `wrangler deploy`.
5. حالا دو تا URL داری. توی `VITE_MARKET_PROXY_ENDPOINTS` هر دو رو با کاما جدا کن:
   ```
   VITE_MARKET_PROXY_ENDPOINTS=https://lensa-market-proxy.acct1.workers.dev,https://lensa-market-proxy-2.acct2.workers.dev
   ```

هر اکانت سهمیه‌ی روزانه‌ی خودش رو مستقل داره (۱۰۰k جدا از هم)، یعنی با ۲ اکانت
عملاً ۲۰۰k درخواست در روز داری، با ۳ تا ۳۰۰k و همین‌طور. کد فرانت‌اند (`rotateProxies`)
خودش به‌صورت round-robin بین این‌ها می‌چرخه تا فشار به‌طور مساوی پخش بشه، و اگه
یکی‌شون قطع/تموم باشه بقیه رو امتحان می‌کنه.

هیچ محدودیت فنی روی تعداد اکانت نیست — هر چقدر بخوای می‌تونی اضافه کنی، فقط باید
هر بار با ایمیل/اکانت متفاوت لاگین و دیپلوی کنی.

## امنیت

- `ALLOWED_ORIGINS` توی `worker.js` رو حتماً با دامنه‌ی واقعی سایتت (و هر
  دامنه‌ی دیگه‌ای که ازش استفاده می‌کنی، مثل GitHub Pages) پر کن، تا کسی
  دیگه‌ای از سهمیه‌ی Worker تو سوءاستفاده نکنه.
- این Worker هیچ API key یا داده‌ی حساسی نداره؛ فقط یه relay شفافه، پس ریسک
  امنیتی خاصی نداره جز مصرف سهمیه توسط ناشناس، که با محدود کردن origin کنترل می‌شه.
