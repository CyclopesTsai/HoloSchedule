# HoloSchedule — hololive 直播節目表（非官方）

把 [ホロジュール（schedule.hololive.tv）](https://schedule.hololive.tv/) 的直播排程整理成靜態網頁，由 GitHub Actions 定期抓取並部署到 GitHub Pages。

網站：<https://cyclopestsai.github.io/HoloSchedule/>

> **非官方。** 與 COVER 株式会社、hololive production 無關；資料可能有誤，請以原站為準。節目資料的版權屬原站與各權利人，請勿商用。

## 架構

```
schedule.hololive.tv/lives/{hololive,holostars,holostars_english,mekpark,cover}
        │  GitHub Actions（每 15 分鐘、手動、push main）
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
│   ├── update.yml       # 測試 → 抓取 → 加版本參數 → 部署 Pages
│   └── keepalive.yml    # 每月重新啟用排程，避免 60 天無活動被 GitHub 停用
├── public/              # 靜態網站（不需 build）
│   ├── index.html
│   ├── style.css
│   ├── app.js
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
- 抓取或解析失敗時以非零狀態結束、不覆寫資料，Pages 保留上一次成功的版本。

`data.json` 格式：

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

時間一律為 `+09:00`，換成其他時區由前端處理；`title` 可能為 `null`。

## 前端

純 HTML／CSS／vanilla JS（`public/`），讀取同目錄的 `data.json`。

- 依日期分組，只顯示今天與之後；今天的順序為已結束 → 直播中 → 已過開始時間但尚未確認 → 「現在」線 → 尚未開始。開頁時自動捲到第一筆直播。
- 團體篩選；齒輪選單可設定時區（台北、東京、瀏覽器本地）、隱藏已結束、要顯示的團體，以及試驗性功能（`app.js` 的 `EXPERIMENTS`，沒有項目時隱藏）。設定記在 localStorage。
- 點擊節目會在右側開啟播放器（影片＋聊天室，手機為全螢幕，寬度可拖曳）；⌘／Ctrl＋點擊在新分頁開 YouTube。打開時會透過 YouTube IFrame Player API 確認該節目狀態，並在本機暫時更新清單。播放器要沿用 YouTube 登入狀態時，瀏覽器需允許第三方 Cookie。
- 每 5 分鐘重新讀取資料；超過 1 小時未更新時，頂欄的更新時間會變色。

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
2. 推送到 `main`，或在 **Actions → Update schedule → Run workflow** 手動執行。

`update.yml` 由排程（`7,22,37,52 * * * *`）、手動觸發與 push 到 `main` 啟動，權限只有 `contents: read`、`pages: write`、`id-token: write`。資料只存在 Pages 部署產物中，不會 commit 回 repo。GitHub 的排程可能延遲或跳過，需要時可手動執行。

## 授權

程式碼以 [GNU AGPL-3.0-or-later](LICENSE) 授權。節目資料與 `tests/fixtures/` 中的原站 HTML 不在授權範圍內，版權屬原站與各權利人。
