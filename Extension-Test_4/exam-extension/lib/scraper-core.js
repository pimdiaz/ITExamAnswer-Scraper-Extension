/*
 * scraper-core.js
 * Port of scraper.py (parse_html / clean_question_text / save_output) and
 * convert_to_quizizz.py (parse_txt_to_quizizz) to plain browser DOM code.
 *
 * No chrome.* APIs and no external libraries: it only needs a DOM Document,
 * so it can run in a content script or in any page for testing.
 *
 * Differences from the Python original (deliberate):
 *  - The question stem is found by position in the text flow (any block tag), and
 *    the search never reaches back past the previous list, so a missing stem can
 *    no longer be replaced by the previous question's text.
 *  - "Explain:" / "Explanation:" paragraphs are never used as questions; they are
 *    captured as the explanation of the list they follow.
 */
(function (root) {
  'use strict';

  // ---- Regexes (same patterns as the Python source, plus Explain handling) -----
  const SKIP_PARENT_RE = /(sharedaddy|heateor|menu|widget|nav|comments|sidebar)/i;
  const IMAGE_KEYWORDS_RE = new RegExp(
    '\\b(refer\\s+to\\s+the\\s+(exhibit|diagram|graphic|figure|image|topology)|' +
      'shown\\s+in\\s+the\\s+(exhibit|diagram|figure)|' +
      'based\\s+on\\s+the\\s+(exhibit|diagram|figure))\\b',
    'i'
  );
  const QUESTION_NUMBER_RE = /^\s*(Question\s+\d+[.:\-]?\s*|\d+[.):\-]\s*)/i;
  // Text that can never be a question stem (original list + "Explain:").
  const STEM_NOISE_RE = /^(Explanation|Explain\s*:|How to find|Note:|Advertisements)/i;
  // Label at the start of an explanation paragraph.
  const EXPLAIN_RE = /^\s*(Explanation|Explain)\b\s*[:.\-]?\s*/i;
  const IMG_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'src'];
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'TH', 'DT', 'DD',
    'FIGCAPTION', 'FIGURE', 'PRE', 'SECTION', 'ARTICLE', 'CENTER', 'CAPTION',
  ]);
  const SKIP_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  const POS_PRECEDING = 2; // Node.DOCUMENT_POSITION_PRECEDING
  const POS_FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
  const POS_CONTAINED_BY = 16; // Node.DOCUMENT_POSITION_CONTAINED_BY

  // ---- Helpers --------------------------------------------------------------

  /** "1. foo" / "Question 12: foo" -> "foo" */
  function cleanQuestionText(rawText) {
    return rawText.replace(QUESTION_NUMBER_RE, '').trim();
  }

  /**
   * Equivalent of BeautifulSoup's get_text(" ", strip=True): every text node is
   * trimmed, empty ones dropped, the rest joined with a single space.
   * (script/style text is ignored, as in bs4.)
   */
  function getText(node) {
    const doc = node.ownerDocument || node;
    const walker = doc.createTreeWalker(node, 4 /* SHOW_TEXT */, {
      acceptNode(n) {
        const p = n.parentNode && n.parentNode.nodeName;
        return SKIP_TEXT_PARENTS.has(p) ? 2 /* REJECT */ : 1; /* ACCEPT */
      },
    });
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (t) parts.push(t);
    }
    return parts.join(' ');
  }

  /** find_parent(class_=regex): does any ancestor have a class token matching re? */
  function hasAncestorClassMatching(el, re) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      for (const c of p.classList) if (re.test(c)) return true;
    }
    return false;
  }

  function isCorrectChoice(li) {
    return (
      li.classList.contains('correct_answer') ||
      !!li.querySelector('[class*="correct_answer" i]') ||
      !!li.querySelector('strong, b')
    );
  }

  /**
   * Splits the content into text blocks in document order. A block is the run of
   * text that belongs to one block-level element (p, div, h1-h6, li, ...), no matter
   * how many inline tags (strong, span, a, br) are inside it.
   * Each block: { el, anchor (first text node), text, inLi }
   */
  function collectTextBlocks(rootEl) {
    const doc = rootEl.ownerDocument;
    const walker = doc.createTreeWalker(rootEl, 4 /* SHOW_TEXT */, {
      acceptNode(n) {
        const p = n.parentNode && n.parentNode.nodeName;
        if (SKIP_TEXT_PARENTS.has(p)) return 2; // REJECT
        return n.nodeValue.trim() ? 1 : 3; // ACCEPT / SKIP whitespace-only
      },
    });
    const blocks = [];
    let cur = null;
    let n;
    while ((n = walker.nextNode())) {
      let el = n.parentElement;
      while (el && el !== rootEl && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
      el = el || rootEl;
      const t = n.nodeValue.trim();
      if (cur && cur.el === el) {
        cur.parts.push(t);
      } else {
        cur = { el, anchor: n, parts: [t], inLi: !!(n.parentElement && n.parentElement.closest('li')) };
        blocks.push(cur);
      }
    }
    for (const b of blocks) b.text = b.parts.join(' ');
    return blocks;
  }

  // text node `n` lies before / after (and not inside) element `ul`
  const isBefore = (ul, n) => !!(ul.compareDocumentPosition(n) & POS_PRECEDING);
  const isAfter = (ul, n) => {
    const pos = ul.compareDocumentPosition(n);
    return !!(pos & POS_FOLLOWING) && !(pos & POS_CONTAINED_BY);
  };

  /** Does this paragraph read like a question stem (vs. prose such as a 2nd explanation paragraph)? */
  function looksLikeStem(text) {
    return (
      QUESTION_NUMBER_RE.test(text) ||
      /[?:]\s*$/.test(text) ||
      /\((choose|select)\b/i.test(text) ||
      IMAGE_KEYWORDS_RE.test(text)
    );
  }

  /**
   * The question stem: nearest real text block before the list.
   *  - never reaches back past the previous list (returns null instead);
   *  - once an "Explain:" paragraph sits between the lists, only text that looks like a
   *    stem counts, so the tail of an explanation can't be mistaken for a question.
   */
  function findStem(ul, prevUl, blocks) {
    const zone = []; // block indexes between the previous list and this one, nearest first
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (!isBefore(ul, b.anchor)) continue;
      if (prevUl && (prevUl.contains(b.anchor) || isBefore(prevUl, b.anchor))) break;
      zone.push(i);
    }
    let explainAt = -1;
    for (const i of zone) {
      if (!blocks[i].inLi && EXPLAIN_RE.test(blocks[i].text)) {
        explainAt = i;
        break;
      }
    }
    for (const i of zone) {
      const b = blocks[i];
      if (b.inLi) continue;
      if (b.text.length < 15 || STEM_NOISE_RE.test(b.text)) continue;
      if (explainAt !== -1) {
        if (i <= explainAt) continue; // at or before the explanation: not this list's stem
        if (!looksLikeStem(b.text)) continue; // explanation continuation / other prose
      }
      return b;
    }
    return null;
  }

  /** The "Explain: ..." paragraph right after the list (before the next list), else ''. */
  function findExplanation(ul, nextUl, blocks) {
    let wantNext = false; // label sat alone in its own block
    for (const b of blocks) {
      if (!isAfter(ul, b.anchor)) continue;
      if (nextUl && !isBefore(nextUl, b.anchor)) break;
      if (b.inLi) continue;
      if (wantNext) return b.text.trim();
      const m = EXPLAIN_RE.exec(b.text);
      if (m) {
        const rest = b.text.slice(m[0].length).trim();
        if (rest) return rest;
        wantNext = true;
        continue;
      }
      if (b.text.length < 15 || STEM_NOISE_RE.test(b.text)) continue;
      return ''; // some other prose first: this list has no explanation
    }
    return '';
  }

  /**
   * First usable <img> that belongs to this question: after the stem's own text and
   * before the list (or inside the stem's block, when that block is a small element).
   * It is anchored at the stem TEXT, not at the stem's element: when the question text
   * sits directly in the page's content container, that element is the whole page, and
   * "after the element" would match the first image on the page for every question.
   */
  function findImageUrl(stem, ul, prevUl, rootEl) {
    const blockIsSmall = stem.el !== rootEl && !stem.el.contains(ul);
    for (const img of rootEl.querySelectorAll('img')) {
      if (!(ul.compareDocumentPosition(img) & POS_PRECEDING)) continue; // must be before the list
      if (prevUl && (prevUl.contains(img) || prevUl.compareDocumentPosition(img) & POS_PRECEDING)) continue; // not the previous question's
      const afterStemText = !!(stem.anchor.compareDocumentPosition(img) & POS_FOLLOWING);
      const insideStemBlock = blockIsSmall && stem.el.contains(img);
      if (!afterStemText && !insideStemBlock) continue;
      for (const attr of IMG_ATTRS) {
        const v = (img.getAttribute(attr) || '').trim();
        if (!v || v.startsWith('data:')) continue; // skip lazy-load placeholders
        try {
          return new URL(v, img.ownerDocument.baseURI).href;
        } catch (e) {
          /* try next attribute */
        }
      }
    }
    return '';
  }

  /** nearest earlier / later list in the content that is not nested with `ul` */
  function neighbourList(allUls, k, step) {
    const ul = allUls[k];
    for (let j = k + step; j >= 0 && j < allUls.length; j += step) {
      const u = allUls[j];
      if (!u.contains(ul) && !ul.contains(u)) return u;
    }
    return null;
  }

  // ---- Main parser (parse_html) ------------------------------------------

  /**
   * @param {Document} doc
   * @param {{includeImages?: boolean}} [opts]
   * @returns {{cards: Array, stats: object}}
   *   card = { question, choices: [{text, correct}], imageUrl, explanation }
   */
  function parseDocument(doc, opts) {
    opts = opts || {};
    const stats = {
      listsSeen: 0,
      skippedNoCorrect: 0,
      skippedNoQuestion: 0, // list with correct answer but no question text before it
      skippedImage: 0, // image-dependent question dropped (images option off)
      skippedNoImage: 0, // image-dependent question, but no image URL found
      withExplanation: 0,
      contentFound: true,
    };

    const contentArea =
      doc.querySelector('div.thecontent') ||
      doc.querySelector('div.entry-content') ||
      doc.querySelector('article');

    if (!contentArea) {
      stats.contentFound = false;
      return { cards: [], stats };
    }

    const allUls = Array.from(contentArea.querySelectorAll('ul'));
    const blocks = collectTextBlocks(contentArea);
    const cards = [];

    for (let k = 0; k < allUls.length; k++) {
      const origUl = allUls[k];
      stats.listsSeen++;
      if (hasAncestorClassMatching(origUl, SKIP_PARENT_RE)) continue;

      // Work on a clone so we can drop "copy" buttons without touching the page.
      const ul = origUl.cloneNode(true);
      for (const btn of ul.querySelectorAll('button')) {
        if (Array.from(btn.classList).some((c) => /copy/i.test(c))) btn.remove();
      }

      let hasCorrect = false;
      const choices = [];
      for (const li of Array.from(ul.children)) {
        if (li.tagName !== 'LI') continue; // find_all("li", recursive=False)
        const text = getText(li);
        if (!text) continue;
        const correct = isCorrectChoice(li);
        if (correct) hasCorrect = true;
        choices.push({ text, correct });
      }

      if (!choices.length || !hasCorrect) {
        stats.skippedNoCorrect++;
        continue;
      }

      const prevUl = neighbourList(allUls, k, -1);
      const q = findStem(origUl, prevUl, blocks);
      if (!q) {
        stats.skippedNoQuestion++;
        continue;
      }

      let imageUrl = '';
      if (IMAGE_KEYWORDS_RE.test(q.text)) {
        if (!opts.includeImages) {
          stats.skippedImage++;
          continue;
        }
        imageUrl = findImageUrl(q, origUl, prevUl, contentArea);
        if (!imageUrl) {
          stats.skippedNoImage++;
          continue;
        }
      } else if (opts.includeImages) {
        imageUrl = findImageUrl(q, origUl, prevUl, contentArea);
      }

      const explanation = findExplanation(origUl, neighbourList(allUls, k, 1), blocks);
      if (explanation) stats.withExplanation++;

      cards.push({ question: cleanQuestionText(q.text), choices, imageUrl, explanation });
    }

    return { cards, stats };
  }

  // ---- Output: questions_with_answers.txt (save_output) ------------------

  /**
   * Same layout the Python scraper wrote. [IMAGE: url] and [EXPLAIN: text] are extra
   * single-line tags after the question line (the old convert_to_quizizz.py only
   * knows [IMAGE: ...]).
   */
  function toTxt(cards) {
    let out = '';
    for (const c of cards) {
      out += c.question + '\n';
      if (c.imageUrl) out += '[IMAGE: ' + c.imageUrl + ']\n';
      if (c.explanation) out += '[EXPLAIN: ' + c.explanation.replace(/\s*\n\s*/g, ' ') + ']\n';
      for (const ch of c.choices) out += (ch.correct ? '*' : '') + ch.text + '\n';
      out += '\n';
    }
    return out;
  }

  // ---- Output: Quizizz rows (convert_to_quizizz.py) ----------------------

  const QUIZIZZ_COLUMNS = [
    'Question Text',
    'Question Type',
    'Option 1',
    'Option 2',
    'Option 3',
    'Option 4',
    'Option 5',
    'Correct Answer',
    'Time in seconds',
    'Image Link',
    'Answer explanation',
  ];

  /**
   * @returns {{rows: object[], dropped: number, truncated: number}}
   * Quizizz only has 5 option columns. A question whose correct answer would fall
   * outside them is dropped (and counted); one with extra wrong options just loses
   * the extras (counted in `truncated`).
   */
  function toQuizizzRows(cards, timeSeconds) {
    const rows = [];
    let dropped = 0;
    let truncated = 0;
    for (const c of cards) {
      if (c.choices.length < 2) continue;
      const correctIdx = [];
      c.choices.forEach((ch, i) => ch.correct && correctIdx.push(i + 1));
      if (!correctIdx.length) continue;
      if (correctIdx.some((i) => i > 5)) {
        dropped++;
        continue;
      }
      if (c.choices.length > 5) truncated++;
      const row = {
        'Question Text': c.question,
        'Question Type': correctIdx.length > 1 ? 'Checkbox' : 'Multiple Choice',
      };
      for (let i = 0; i < 5; i++) {
        row['Option ' + (i + 1)] = c.choices[i] ? c.choices[i].text : '';
      }
      row['Correct Answer'] = correctIdx.join(',');
      row['Time in seconds'] = timeSeconds || 45;
      row['Image Link'] = c.imageUrl || '';
      row['Answer explanation'] = c.explanation || '';
      rows.push(row);
    }
    return { rows, dropped, truncated };
  }

  const api = {
    cleanQuestionText,
    getText,
    parseDocument,
    toTxt,
    toQuizizzRows,
    QUIZIZZ_COLUMNS,
  };

  root.ExamScraperCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
