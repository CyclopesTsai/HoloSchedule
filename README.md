# HoloSchedule — hololive 直播節目表（非官方）

把 [ホロジュール（schedule.hololive.tv）](https://schedule.hololive.tv/) 的直播排程整理成靜態網頁，由 GitHub Actions 定期抓取並部署到 GitHub Pages。

網站：<https://cyclopestsai.github.io/HoloSchedule/>

> **非官方。** 與 COVER 株式会社、hololive production 無關；資料可能有誤，請以原站為準。節目資料的版權屬原站與各權利人，請勿商用。

## 架構

```
schedule.hololive.tv/lives/{hololive,holostars,holostars_english,mekpark,cover}
        │  GitHub Actions（每 15 分鐘、手動、push main）
        ▼
scripts/scrape.py ──► public/data.json + titles.json（標題經 Holodex／YouTube oEmbed）
        │  （選用）Holodex API：直播狀態與標題
        │
scripts/stamp_assets.py（CSS/JS 加版本參數）──► upload-pages-artifact ──► deploy-pages
                                                                              │
                              public/index.html + app.js 讀取 data.json ◄─────┘
```

```
.
├── .github/workflows/
│   ├── update.yml       # 測試 → 抓取 → 加版本參數 → 部署 Pages
│   └── keepalive.yml    # 每月重新啟用排程，避免 60 天無活動被 GitHub 停用
├── public/              # 靜態網站（不需 build）
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   ├── apple-touch-icon.png  # iPhone 主畫面圖示（與網頁 favicon 同設計）
│   ├── data.json        # 由 scrape.py 產生，不進版控
│   └── titles.json      # 標題快取，由 scrape.py 產生，不進版控
├── scripts/
│   ├── scrape.py        # 抓取與解析原站、取得標題、輸出 JSON
│   └── stamp_assets.py  # 替 index.html 的 CSS/JS 網址加上內容雜湊
├── tests/               # pytest；fixtures/ 為原站 HTML 樣本（第三方內容）
├── requirements.txt
└── LICENSE
```

## 資料

`scripts/scrape.py`（requests + BeautifulSoup）依序抓取五個團體分頁，從 HTML 取出每筆直播：

- 日期標題、時間（Asia/Tokyo）、成員、YouTube 連結與縮圖；團體由分頁網址決定。
- 「直播中」對應原站卡片的紅框（`border: 3px red`）。
- 標題由 YouTube oEmbed 取得（不需 API key），快取在 `titles.json`，每次只查新出現或過期的影片。
- （選用）設定 `HOLODEX_API_KEY` 時，另外向 [Holodex API](https://docs.holodex.net/) 查詢同一時段 hololive production 的直播，依影片 ID 補上狀態（`upcoming`／`live`／`past`）、標題，以及直播中的觀看人數；有 Holodex 標題的影片不再查 oEmbed。節目清單、時間與成員仍以ホロジュール為準，Holodex 沒有的影片狀態為 `null`。Holodex 的 `live`／`past` 會覆寫原站的紅框判斷；Holodex 查詢失敗不影響這次更新。
- 抓取或解析失敗時以非零狀態結束、不覆寫資料，Pages 保留上一次成功的版本。

`data.json` 格式：

```json
{
  "generated_at": "2026-10-04T04:52:07Z",
  "source": "https://schedule.hololive.tv/",
  "status_source": "https://holodex.net/",
  "items": [
    {
      "id": "FCM3tqdSVH8",
      "member": "アステル・レダ",
      "group": "HOLOSTARS",
      "start": "2026-10-03T00:02:00+09:00",
      "url": "https://www.youtube.com/watch?v=FCM3tqdSVH8",
      "thumbnail": "https://img.youtube.com/vi/FCM3tqdSVH8/mqdefault.jpg",
      "is_live": false,
      "title": "【妹に運転を教える】…",
      "status": "past",
      "viewers": null
    }
  ]
}
```

時間一律為 `+09:00`，換成其他時區由前端處理；`title`、`status`、`viewers` 可能為 `null`；`viewers` 只在 `status` 為 `live` 時才有，是抓取當下的同時觀看人數。`status_source` 在有任何 Holodex 狀態時為 Holodex 網址，否則為 `null`。

## 前端

純 HTML／CSS／vanilla JS（`public/`），讀取同目錄的 `data.json`。

- 有 Holodex 狀態時直接用它判斷已結束／直播中；過了開始時間 30 分鐘仍是 `upcoming` 的標成「延後」。直播中的節目在團體旁顯示觀看人數（例如「1.2萬 人」）。沒有狀態時以開始時間推測。頁尾在有 Holodex 資料時標示來源。
- 依日期分組，只顯示今天與之後；今天的順序為已結束 → 直播中 → 已過開始時間但尚未確認 → 「現在」線 → 尚未開始。開頁時自動捲到第一筆直播。
- 團體篩選；齒輪選單可設定時區（台北、東京、瀏覽器本地）、隱藏已結束、要顯示的團體，以及試驗性功能（`app.js` 的 `EXPERIMENTS`，沒有項目時隱藏）。設定記在 localStorage。
- 點擊節目會在右側開啟播放器（影片＋聊天室，手機為全螢幕，寬度可拖曳）；⌘／Ctrl＋點擊在新分頁開 YouTube。行動裝置預設直接開 YouTube（App），電腦可在齒輪選單改成直接在新分頁開 YouTube；兩者都可改回使用播放器。打開時會透過 YouTube IFrame Player API 確認該節目狀態，並在本機暫時更新清單。播放器要沿用 YouTube 登入狀態時，瀏覽器需允許第三方 Cookie。
- 從 iPhone 主畫面開啟（standalone）時，可在頁面頂端下拉重新整理（Safari 在此模式沒有內建手勢）。
- 每分鐘重新讀取資料（內容沒變就不重繪，背景分頁不讀取）；超過 1 小時未更新時，頂欄的更新時間會變色。

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

打開 <http://localhost:8000/>。

## 部署

1. 公開 repo，**Settings → Pages → Source** 選 **GitHub Actions**。
2. （選用）登入 [Holodex](https://holodex.net/)，在 **Account Settings** 取得 API key，加到 repo 的 **Settings → Secrets and variables → Actions**，名稱為 `HOLODEX_API_KEY`。
3. 推送到 `main`，或在 **Actions → Update schedule → Run workflow** 手動執行。

`update.yml` 由排程（`7,22,37,52 * * * *`）、手動觸發與 push 到 `main` 啟動，權限只有 `contents: read`、`pages: write`、`id-token: write`。資料只存在 Pages 部署產物中，不會 commit 回 repo。GitHub 的排程可能延遲或跳過，需要時可手動執行。

## 授權

程式碼以 [GNU AGPL-3.0-or-later](LICENSE) 授權。節目資料與 `tests/fixtures/` 中的原站 HTML 不在授權範圍內，版權屬原站與各權利人。
