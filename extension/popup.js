const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.className = isErr ? 'err' : '';
}

$('run').addEventListener('click', async () => {
  const btn = $('run');
  btn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/i.test(tab.url || '')) {
      setStatus('Open an exam-answers page (http/https) first.', true);
      return;
    }
    const target = { tabId: tab.id };
    setStatus('Working... keep this popup open for about 5 seconds.');

    // Optional: if you put SheetJS at vendor/xlsx.full.min.js it will be used for the .xlsx.
    try {
      await chrome.scripting.executeScript({ target, files: ['vendor/xlsx.full.min.js'] });
    } catch (e) { /* not bundled - built-in writer is used */ }

    await chrome.scripting.executeScript({
      target,
      files: ['lib/scraper-core.js', 'lib/xlsx-writer.js', 'lib/content.js'],
    });

    const opts = {
      includeImages: $('optImages').checked,
      downloadTxt: $('optTxt').checked,
      downloadXlsx: $('optXlsx').checked,
    };
    const [{ result }] = await chrome.scripting.executeScript({
      target,
      func: (o) => window.__examScraperRun(o),
      args: [opts],
    });

    if (!result || !result.ok) {
      setStatus((result && result.message) || 'Nothing extracted.', true);
      return;
    }
    const s = result.stats;
    const lines = ['Extracted ' + result.count + ' questions.'];
    if (s.skippedImage) lines.push('Skipped ' + s.skippedImage + ' that need an image (tick "Include image questions" to keep them).');
    if (s.skippedNoImage) lines.push('Skipped ' + s.skippedNoImage + ' image questions with no image URL found.');
    if (s.skippedNoQuestion) lines.push('Skipped ' + s.skippedNoQuestion + ' with no question text found above the answers.');
    const im = result.imageStats;
    if (im && im.withImage) {
      lines.push(im.withImage + ' with an image (' + im.distinct + ' different).');
      if (im.withImage >= 5 && im.distinct === 1) lines.push('WARNING: every image is the same file - please check the Image Link column.');
    }
    if (s.withExplanation) lines.push(s.withExplanation + ' have an Answer explanation.');
    if (result.truncated) lines.push(result.truncated + ' had more than 5 options; extras were cut (Quizizz limit).');
    if (result.dropped) lines.push('Skipped ' + result.dropped + ' with correct answers beyond option 5 (Quizizz limit).');
    if (result.files && result.files.length) lines.push('Downloaded: ' + result.files.join(', '));
    setStatus(lines.join('\n'));
  } catch (err) {
    setStatus('Error: ' + (err && err.message ? err.message : err), true);
  } finally {
    btn.disabled = false;
  }
});
