/*
 * content.js  (injected on demand by popup.js, after scraper-core.js and xlsx-writer.js)
 * Replaces the Playwright part of scraper.py: instead of launching a headless
 * browser it scrolls the tab you are already looking at to trigger lazy loading,
 * parses the live DOM, then downloads the results.
 */
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- tiny on-page status toast (so you can see progress if the popup closes) --
  function toast(msg) {
    let el = document.getElementById('__exam_scraper_toast');
    if (!el) {
      el = document.createElement('div');
      el.id = '__exam_scraper_toast';
      el.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 14px;' +
        'background:#1f2937;color:#fff;font:13px/1.3 system-ui,sans-serif;border-radius:8px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.3);max-width:320px';
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    return el;
  }

  // ---- scrolling (same cadence as the Python version) ---------------------------
  async function scrollToTriggerLazyLoad() {
    const startY = window.scrollY;
    for (let i = 0; i < 10; i++) {
      toast('Scrolling to load questions... ' + (i + 1) + '/10');
      window.scrollBy(0, document.body.scrollHeight / 10);
      await sleep(500);
    }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(2000);
    window.scrollTo(0, startY); // put the reader back where they were
  }

  // ---- download helpers ------------------------------------------------------------
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 15000);
  }

  function slugFromLocation() {
    const last = location.pathname.split('/').filter(Boolean).pop() || location.hostname;
    return last.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80) || 'exam';
  }

  /** pandas.DataFrame.to_excel -> SheetJS if you dropped it in vendor/, else our own writer. */
  function buildXlsxBytes(rows, columns) {
    if (typeof XLSX !== 'undefined' && XLSX.utils && XLSX.write) {
      const ws = XLSX.utils.json_to_sheet(rows, { header: columns });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      return new Uint8Array(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
    }
    return ExamXlsx.build(rows, columns, 'Sheet1');
  }

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // ---- entry point called by the popup -----------------------------------------------
  window.__examScraperRun = async function (opts) {
    opts = Object.assign({ includeImages: false, scroll: true, downloadTxt: true, downloadXlsx: true }, opts);
    try {
      if (opts.scroll) await scrollToTriggerLazyLoad();
      toast('Parsing questions...');

      const { cards, stats } = ExamScraperCore.parseDocument(document, { includeImages: opts.includeImages });
      if (!cards.length) {
        toast('No questions found.');
        setTimeout(() => document.getElementById('__exam_scraper_toast')?.remove(), 4000);
        return { ok: false, count: 0, stats, message: stats.contentFound ? 'No questions with marked correct answers were found.' : 'Could not locate the content area on this page.' };
      }

      const imgUrls = cards.map((c) => c.imageUrl).filter(Boolean);
      const imageStats = { withImage: imgUrls.length, distinct: new Set(imgUrls).size };

      const slug = slugFromLocation();
      const files = [];
      let dropped = 0;
      let truncated = 0;

      if (opts.downloadTxt) {
        const name = slug + '_questions_with_answers.txt';
        downloadBlob(new Blob([ExamScraperCore.toTxt(cards)], { type: 'text/plain;charset=utf-8' }), name);
        files.push(name);
      }
      let quizizzCount = 0;
      if (opts.downloadXlsx) {
        const q = ExamScraperCore.toQuizizzRows(cards, 45);
        dropped = q.dropped;
        truncated = q.truncated;
        quizizzCount = q.rows.length;
        const name = 'quizizz_import_' + slug + '.xlsx';
        downloadBlob(new Blob([buildXlsxBytes(q.rows, ExamScraperCore.QUIZIZZ_COLUMNS)], { type: XLSX_MIME }), name);
        files.push(name);
      }

      toast('Done: ' + cards.length + ' questions');
      setTimeout(() => document.getElementById('__exam_scraper_toast')?.remove(), 4000);
      return { ok: true, count: cards.length, quizizzCount, dropped, truncated, imageStats, stats, files };
    } catch (err) {
      toast('Error: ' + (err && err.message));
      return { ok: false, count: 0, message: String(err && err.stack || err) };
    }
  };
})();
