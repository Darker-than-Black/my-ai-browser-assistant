// Minimal, dependency-free, XSS-safe Markdown -> HTML renderer.
// Supports: code fences, inline code, headings, bold, italic, links,
// unordered/ordered lists, blockquotes, paragraphs, line breaks.
// Everything is HTML-escaped first, so model output can never inject markup.
(function (global) {
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inline(text) {
    // text is already HTML-escaped
    return text
      // inline code
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      // bold
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      // italic
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/_([^_]+)_/g, "<em>$1</em>")
      // links [text](url) — allow only http/https/mailto
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
        (_, t, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  }

  function render(md) {
    const src = String(md == null ? "" : md);
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let listType = null; // 'ul' | 'ol'

    function closeList() {
      if (listType) { out.push(`</${listType}>`); listType = null; }
    }

    while (i < lines.length) {
      let line = lines[i];

      // Code fence
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        closeList();
        const code = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++; // skip closing fence
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      // Headings
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeList();
        const level = Math.min(h[1].length, 3);
        out.push(`<h${level}>${inline(escapeHtml(h[2]))}</h${level}>`);
        i++;
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        closeList();
        out.push(`<blockquote>${inline(escapeHtml(line.replace(/^>\s?/, "")))}</blockquote>`);
        i++;
        continue;
      }

      // Unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
        out.push(`<li>${inline(escapeHtml(line.replace(/^\s*[-*+]\s+/, "")))}</li>`);
        i++;
        continue;
      }

      // Ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
        out.push(`<li>${inline(escapeHtml(line.replace(/^\s*\d+\.\s+/, "")))}</li>`);
        i++;
        continue;
      }

      // Blank line
      if (/^\s*$/.test(line)) { closeList(); i++; continue; }

      // Paragraph (gather consecutive non-block lines)
      closeList();
      const para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) &&
             !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) &&
             !/^>\s?/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push(`<p>${inline(escapeHtml(para.join("\n"))).replace(/\n/g, "<br>")}</p>`);
    }

    closeList();
    return out.join("\n");
  }

  global.renderMarkdown = render;
})(this);
