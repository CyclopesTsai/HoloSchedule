# HoloSchedule — hololive 直播節目表（非官方）

把 [ホロジュール（schedule.hololive.tv）](https://schedule.hololive.tv/) 的直播排程整理成一個輕量的靜態網頁，透過 GitHub Actions 每 15 分鐘抓取一次並部署到 GitHub Pages。

> **非官方。** 本專案與 COVER 株式会社、hololive production 無關；資料可能有誤，請以原站為準。程式碼以 [AGPL-3.0](LICENSE) 授權；節目資料的版權屬原站與各權利人，不在授權範圍內，請勿商用。

網站：<https://cyclopestsai.github.io/HoloSchedule/>

## 架構

```
schedule.hololive.tv/lives/{hololive,holostars,holostars_english,mekpark,cover}
        │  (GitHub Actions，每 15 分鐘，逐頁抓取)
        ▼
scripts/scrape.py ──► public/data.json + titles.json（標題經 YouTube oEmbed）
        │
scripts/stamp_assets.py（CSS/JS 加版本參數）──► upload-pages-artifact ──► deploy-pages
                                                                              │
                              public/index.html + app.js 讀取 data.json ◄─────┘
```

```
.
├── .github/workflows/
│   ├── update.yml       # 測試 → 抓取 → 加版本參數 → 部署 Pages（cron / 手動 / push main）
│   └── keepalive.yml    # 每月一次，避免排程因 60 天無活動被停用
├── public/              # 靜態網站（不需 build）
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── data.json        # 由 scrape.py 產生，不進版控
│   └── titles.json      # 標題快取，由 scrape.py 產生，不進版控
├── scripts/
│   ├── scrape.py        # requests + BeautifulSoup 抓取與解析、oEmbed 取標題
│   └── stamp_assets.py  # 部署時替 CSS/JS 網址加上內容雜湊（避免舊快取）
├── tests/
│   ├── fixtures/        # 2026-10-04 存下的原站 HTML 樣本（第三方內容，見該目錄 README）
│   ├── conftest.py
│   ├── test_scrape.py
│   └── test_stamp_assets.py
├── pytest.ini
├── requirements.txt
└── LICENSE              # AGPL-3.0
```

### 資料來源的解析方式

研究原站 HTML 後的結論（2026-10 時的結構）：

| 資訊 | 原站中的位置 |
| --- | --- |
| 日期標題 | `<div class="holodule navbar-text">10/03 (土)</div>`，之後的卡片都屬於該日 |
| 每筆直播 | `<a class="thumbnail" href="https://www.youtube.com/watch?v=…">`（內含 `.datetime` 才算，排除同 class 的輪播廣告） |
| 時間 | 卡片內 `.datetime` 的 `HH:MM`（Asia/Tokyo） |
| 成員 | 卡片內 `.name` |
| 縮圖 | 卡片內 `img.youtube.com/vi/<id>/mqdefault.jpg` |
| 直播中 | 卡片 `<a>` 的 inline style 有 `border: 3px red solid`（一般為 `border: 0`） |
| 團體 | 卡片本身沒有標示；改抓 `/lives/<group>` 各分頁，分頁網址即團體 |

- 五個團體分頁（hololive／HOLOSTARS／HOLOSTARS English／mekPark／COVER）合起來與 `/lives/all` 完全一致（已比對 video id），所以不必再抓總表。`/simple` 雖然比較輕，但無法得知團體，因此沒有採用。
- 原站可用 cookie 切換時區；我們不送 cookie，並會檢查頁面選取的時區必須是 Tokyo，否則視為異常。
- 標題沒有年份：取「離現在（東京日期）最近」的年份，因此 12 月抓到 1/1、或 1 月抓到 12/31 都會正確跨年。
- 輸出時間一律為 `+09:00` 的 ISO 8601；轉成台北或本地時間由前端處理。

### `data.json` 格式

```json
{
  "generated_at": "2026-10-04T04:52:07Z",
  "source": "https://schedule.hololive.tv/",
  "items": [
    {
      "id": "FCM3tqdSVH8",
      "member": "アステル・レダ",
      "group": "HOLOSTARS",
      "start": "2026-10-03T00:02:00+09:00",
      "url": "https://www.youtube.com/watch?v=FCM3tqdSVH8",
      "thumbnail": "https://img.youtube.com/vi/FCM3tqdSVH8/mqdefault.jpg",
      "is_live": false,
      "title": "【妹に運転を教える】…"
    }
  ]
}
```

`title` 可能為 `null`（例如會員限定、私人或已刪除的影片，或尚未查到）。

### 直播標題

原站不提供標題，所以改由 YouTube 公開的 [oEmbed](https://oembed.com/) 端點（`https://www.youtube.com/oembed`）取得，**不需要 API key**。

- 標題快取在 `titles.json`（與 `data.json` 一起部署到 Pages）。每次執行會先讀上一次部署的 `titles.json`，只查詢新出現或超過 3 小時未更新的影片；平常一次只需要幾個請求，沒有快取時（第一次）約 130 個。
- 請求依序送出、間隔 0.2 秒，每次最多 150 個；直播中與時間最接近的節目優先。
- 查詢失敗（網路錯誤、429、5xx）時保留舊標題，**不會讓整次更新失敗**；401／403／404（會員限定、私人、已刪除）記為 `null`。

### 穩健性

- 每個請求 timeout（連線 10 秒／讀取 30 秒），連線錯誤、HTTP 429、5xx 最多重試 3 次（2、4、8 秒退避）；其他 4xx 直接失敗。
- 網路失敗、HTML 結構不符（找不到 `.holodule`、卡片出現在日期標題之前、缺時間或成員、時區不是 Tokyo）或總筆數為 0 時，以非零狀態碼結束，**不會**寫入 `data.json`（寫檔採暫存檔 + `os.replace`）。在 Actions 上，這會讓該次 run 在部署前失敗，Pages 上維持上一次成功的版本。
- 以 YouTube video id 去重。

### 對來源的禮貌

- 每次執行只抓 5 個團體頁面，依序請求、每頁之間間隔 1.5 秒，不平行請求。
- User-Agent：`HoloSchedule/1.0 (personal non-commercial schedule viewer; +https://github.com/CyclopesTsai/HoloSchedule)`。
- robots.txt（撰寫時）為 `Disallow:`（未限制）。
- 15 分鐘一次 × 5 頁 ≈ 每天 480 個請求。若原站表示不歡迎，請立即停用 workflow。

## 前端功能

- 清單式顯示，一筆直播一行（時間・縮圖・成員・團體・直播標題・狀態）；手機上狀態標記移到時間下方，讓名稱與標題有更多空間。
- 依日期分組（以所選時區的日期計算），標示「今天／明天／後天」；**不顯示過去的日期**，但今天已結束的節目仍會保留（淡化顯示）。
- 今天的清單順序為：已結束 → 所有直播中的節目（連成一塊，依開始時間排序）→ 已過開始時間、但資料無法確認狀態的節目（標示「即將開始」或「待確認」）→「現在」分隔線 → 尚未開始。直播中以紅色底色與 LIVE 標記顯示；前一天開始、仍在直播的節目也併入今天的直播區塊，並在時間上方標出日期。1 小時內開始的節目標示「N 分鐘後」。
- 清單中有一條「現在 HH:MM」分隔線；開啟頁面（以及切換時區、團體、隱藏已結束）時會自動捲動到直播中的第一筆（緊貼頂欄下方）；沒有直播時改為捲到「現在」線，位於畫面約 40% 處。自動重新整理不會移動捲動位置。
- 團體篩選為單列、可橫向滑動。齒輪選單可勾選要顯示的團體；未勾選的團體完全不顯示（「全部」也不含，也沒有篩選按鈕）。預設不顯示 HOLOSTARS 與 HOLOSTARS English。
- 標題、最後更新時間與團體篩選固定在畫面頂端，自動捲動後也看得到。時區（台北〔預設〕、東京、瀏覽器本地）、「隱藏已結束的節目」與要顯示的團體都在齒輪選單中。以上偏好都會記在 localStorage。
- **試驗性功能**：齒輪選單底部的「試驗性功能」區塊會列出正在試驗的功能開關（定義在 `app.js` 的 `EXPERIMENTS`，預設關閉、記在 localStorage）；目前沒有試驗中的功能，所以區塊隱藏。
- **播放器**：點擊節目時清單往左讓出空間，右側上方播放影片（`youtube.com/embed`）、下方嵌入聊天室（`youtube.com/live_chat?embed_domain=<網站網域>`）；手機上改為全螢幕。
  - ⌘／Ctrl＋點擊或中鍵仍在新分頁開 YouTube（連結為 `target="_blank" rel="noopener noreferrer"`）；Esc 或 ✕ 關閉。
  - 寬度可拖曳左側邊緣調整（聚焦後也可用左右鍵，Shift 加大步幅；雙擊還原預設），記在 localStorage；清單至少保留 420px。
  - 打開時會用 YouTube IFrame Player API 確認該節目目前的狀態，頂部顯示「YouTube 狀態：直播中／已結束／尚未開始」。與資料不同時，只在這個瀏覽器暫時更新清單（判斷為直播中且原本沒嵌入聊天室時會補上）；新的 `data.json` 產生後或 6 小時後改回以伺服器資料為準。判斷用的是 YouTube 未公開文件的欄位（`getVideoData().isLive`／`isManifestless` 與影片長度），連續兩次一致才採用，判斷不出來就不改；YouTube 若改變這些欄位，此功能可能失效。
  - YouTube 回報無法播放時（`isPlayable: false` 或播放器錯誤 101／150；未加入會員時的會員限定直播、年齡限制、禁止嵌入都屬此類），頂部提示「可能為會員限定或不允許嵌入」並強調「YouTube ↗」按鈕，清單狀態不變。
  - 限制：已結束的直播沒有可嵌入的聊天室。播放器與聊天室要沿用 YouTube 登入狀態（Premium、在聊天室發言），瀏覽器必須允許第三方 Cookie；Safari 沒有單站例外，需關閉「設定 → 隱私權 → 防止跨網站追蹤」（影響所有網站；已實測關閉後為登入狀態）。
- 顯示最後更新時間；`generated_at` 超過 1 小時，頂欄右上的更新時間會改為橘色粗體（滑鼠移上去有「可能已過期」的說明）。
- 頁面開著時每 5 分鐘重新讀取 `data.json`（附 `?t=` cache-busting），每分鐘更新相對時間標示。
- 縮圖 `loading="lazy"`，容器固定寬度與 16:9 比例避免版面跳動；手機優先 RWD。
- 固定色系：深棕色頂欄、米色點紋背景、羊皮紙內容區，風格參考 [FFXIVTools](https://cyclopestsai.github.io/FFXIVTools/)，不提供深淺色切換。

### 效能

- 傳輸量：頁面＋CSS＋JS 約 18 KB（gzip），`data.json` 約 10 KB（gzip），每 5 分鐘一次；縮圖約 17 KB／張，延遲載入。YouTube IFrame API 只在第一次打開播放器時載入。
- 每列的 DOM 節點只在內容（連結、縮圖、成員、標題）改變時才重建；每分鐘的更新與切換時區／篩選只改時間、狀態等文字，縮圖 `<img>` 不會被重建（舊版每分鐘重建所有列，造成縮圖閃爍）。
- `Intl.DateTimeFormat` 依時區與格式快取重用；一次重繪約 5–7 ms（桌機 Chrome，約 50 列）。
- 分頁在背景時不重新抓資料也不重繪，切回前景時才補上；頂欄為實色背景，不使用 `backdrop-filter`，捲動時不需持續重繪模糊效果。
- 播放器切換或關閉時會銷毀舊的 YouTube 播放器、移除 iframe 並停止狀態檢查（實測連續切換 20 次，頁面上最多同時 2 個 iframe，關閉後為 0，計時器不累積）。
- 快取：GitHub Pages 對所有檔案固定送 `Cache-Control: max-age=600`，且無法自訂 header。部署時 `scripts/stamp_assets.py` 會把 `index.html` 裡的 `style.css`、`app.js` 改成 `?v=<內容雜湊>`，檔案一改網址就變，瀏覽器會立刻抓新版；`index.html` 本身最多仍可能被快取 10 分鐘。

## 本機執行

```bash
python3 -m venv .venv
```

```bash
.venv/bin/pip install -r requirements.txt
```

```bash
.venv/bin/python -m pytest
```

```bash
.venv/bin/python scripts/scrape.py && .venv/bin/python -m http.server -d public
```

然後打開 <http://localhost:8000/>。（若已啟用 venv，指令即為 `python scripts/scrape.py && python -m http.server -d public`。）

本機的 `index.html` 引用的是沒有版本參數的 `style.css`／`app.js`（版本參數只在部署時加上），修改後若畫面沒變，請強制重新整理（⌘⇧R）。

## 部署

1. 建立公開 repo 並推送（本 repo：`CyclopesTsai/HoloSchedule`）。
2. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
   - 使用 gh CLI 的話：`gh api --method POST repos/CyclopesTsai/HoloSchedule/pages -f build_type=workflow`（已啟用過則改用 `--method PUT`）。
3. **Actions → Update schedule → Run workflow** 手動觸發一次（或 `gh workflow run update.yml`）。
4. 成功後網址為 `https://cyclopestsai.github.io/HoloSchedule/`。
5. 建議也手動執行一次 **Keepalive**，確認它有權限呼叫 enable API。

`update.yml` 的觸發條件為每 15 分鐘的 cron（`7,22,37,52 * * * *`，刻意避開整點與每刻鐘的尖峰，GitHub 官方建議如此以減少延遲或被略過）、手動 `workflow_dispatch`、push 到 `main`。排程沒跑時，可到 **Actions → Update schedule → Run workflow** 手動更新。權限只有 `contents: read`、`pages: write`、`id-token: write`，並用 `concurrency: pages`（不取消進行中的 run）避免部署互相覆蓋。`data.json` 只存在於 Pages 部署產物中，不會 commit 回 repo。

使用的官方 actions（2026-10-04 查證的最新穩定版）：`actions/checkout@v7`、`actions/setup-python@v7`、`actions/upload-pages-artifact@v5`、`actions/deploy-pages@v5`。

### 60 天無活動會停用排程

GitHub 官方文件：「In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days.」文件沒有明確定義哪些事件算 "repository activity"（commit／push 一定算）。

本專案的做法：`keepalive.yml` 每月 1 日以 `GITHUB_TOKEN`（`actions: write`）呼叫官方 REST API [`PUT /repos/{owner}/{repo}/actions/workflows/{id}/enable`](https://docs.github.com/en/rest/actions/workflows#enable-a-workflow) 重新啟用 `update.yml` 與自己。這個呼叫不產生 commit、對已啟用的 workflow 沒有副作用。

**限制（請注意）**：GitHub 沒有文件保證這個 API 呼叫會重置 60 天計時，所以這是「盡力而為」。另外一旦被停用，keepalive 自己的排程也會一起停用，無法自救。若發現網站的「最後更新」停在很久以前：

- 到 **Actions → Update schedule**，若看到停用提示，按 **Enable workflow**（Keepalive 也一樣）；或
- `gh workflow enable update.yml && gh workflow enable keepalive.yml`；或
- 任意 push 一個 commit 到 `main`（一定算活動，也會順便觸發部署）。

## 已知限制與風險

- **依賴原站 HTML 結構。** 原站改版就可能解析失敗；此時 workflow 會失敗並保留上一版，需要更新 `scrape.py` 與 fixtures。
- **GitHub Actions 的 cron 不準時**，高負載時可能延遲數分鐘到數十分鐘，甚至跳過；因此網頁上的資料可能落後 15 分鐘以上，「直播中」狀態也會有延遲。本 repo 建立後，排程約 9.5 小時才第一次觸發（2026-10-04 14:26 UTC），之後仍有時段被跳過；期間只能靠 push 或手動 `workflow_dispatch` 更新。
- 「已結束」是推測：以資料抓取時間（`generated_at`）為準，抓取時已開始超過 30 分鐘且不在直播中才算已結束；資料過期時，開始時間在抓取之後的節目會標「待確認」而不是已結束。原站沒有提供結束時間。
- 只收錄 YouTube 連結；若原站出現其他平台的節目會被略過（log 會記錄）。
- 直播標題最多可能落後約 3 小時（快取期限）；會員限定或私人影片拿不到標題。oEmbed 沒有正式的用量上限說明，若 YouTube 開始拒絕請求，只會少了標題，節目表照常更新。
- 原站的 IP 封鎖或流量限制可能讓 GitHub runner 抓取失敗；不會嘗試任何繞過手段。
- Pages 部署失敗或排程停用時，網頁會顯示舊資料，超過 1 小時頂欄的更新時間會變成橘色。

## 合理使用提醒

- 資料版權屬於原站與各權利人。本專案只做個人瀏覽用途的整理；**請勿將資料用於商業用途**，也請勿大量轉載。（這是對資料與原站的使用提醒，不是程式碼授權的附加條件；AGPL 本身不限制商用。）
- 請維持低頻率請求，不要調高抓取頻率或平行抓取。
- 網頁頁尾已標示資料來源並連回 schedule.hololive.tv，並註明非官方。若 fork 使用，請保留這些標示並把 User-Agent 中的 repo 網址改成你自己的。

## 授權

- 本專案的程式碼（`scripts/`、`public/` 的 HTML／CSS／JS、`tests/` 中的測試程式、workflow）以 **GNU Affero General Public License v3.0 or later**（`AGPL-3.0-or-later`）授權，全文見 [LICENSE](LICENSE)。
- AGPL 第 13 條：若你修改後架設成網站讓他人使用，必須讓使用者取得你修改後的原始碼。本站頁尾已附原始碼連結；fork 時請改成你自己的 repo 網址。
- **不在授權範圍內**：
  - 節目資料（`data.json` 內容、成員名稱、縮圖等）屬原站與各權利人。
  - `tests/fixtures/` 是從 schedule.hololive.tv 存下的原始 HTML，版權屬原站，只供解析測試使用（詳見該目錄的 README）。
- 相依套件：requests（Apache-2.0）、beautifulsoup4（MIT）、pytest（MIT），皆與 AGPL-3.0 相容；它們不隨本專案散布，由 pip 另行安裝。
