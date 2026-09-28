/* Edustream course view + HLS player for Codexyt.
   Loaded on demand the first time an Edustream batch is opened; Codexyt batches never touch this file.
   Data comes from the Edustream /api/course-content?id=<courseId> endpoint. The response tree is discovered
   dynamically (subjects / chapters / lectures / PDFs) so it adapts to whatever nesting the API returns. */
(function () {
  if (window.CXEdustream) return;

  var CONTENT_API = "/api/course-content";
  var DIRECT_API = "https://studyapkmod-targetboard.vercel.app/api/course-content";
  var PROGRESS_KEY = "cx-edu-progress";

  /* ---------- tree discovery ---------- */
  var TITLE_KEYS = ["title", "name", "lectureName", "topicName", "subjectName", "chapterName", "label", "fileName"];
  var VIDEO_KEYS = ["hlsUrl", "hls_url", "hlsURL", "hls", "streamUrl", "videoUrl", "playbackUrl", "m3u8Url", "m3u8"];
  var PDF_KEYS = ["pdfUrl", "notesUrl", "fileUrl", "attachmentUrl", "downloadUrl", "file", "document"];
  var GENERIC_KEYS = /^(data|content|contents|course|courseContent|result|results|response|tree|items|children|subjects|chapters|topics|lectures|lessons|modules|sections|folders|files|videos|streams|notes|pdfs|attachments|materials|classes)$/i;

  function str(v) { return typeof v === "string" ? v.trim() : ""; }
  function isVideoUrl(u) { return /\.(m3u8|mp4|webm|m4v)(\?|#|$)/i.test(u) || /m3u8/i.test(u); }
  function isPdfUrl(u) { return /\.pdf(\?|#|$)/i.test(u); }
  function titleOf(o) { for (var i = 0; i < TITLE_KEYS.length; i++) { var t = str(o[TITLE_KEYS[i]]); if (t) return t; } return ""; }

  function videoOf(o) {
    for (var i = 0; i < VIDEO_KEYS.length; i++) { var v = str(o[VIDEO_KEYS[i]]); if (v) return v; }
    var u = str(o.url);
    if (u && (isVideoUrl(u) || /video|lecture|stream/i.test(str(o.type) + " " + str(o.contentType)))) return u;
    return "";
  }
  function pdfOf(o) {
    for (var i = 0; i < PDF_KEYS.length; i++) {
      var v = str(o[PDF_KEYS[i]]);
      if (v && (isPdfUrl(v) || /^(pdfUrl|notesUrl)$/.test(PDF_KEYS[i]))) return v;
    }
    var u = str(o.url);
    if (u && (isPdfUrl(u) || /pdf/i.test(str(o.type) + " " + str(o.mimeType) + " " + str(o.fileType)))) return u;
    return "";
  }

  function isPlain(v) { return v && typeof v === "object" && !Array.isArray(v); }

  // Children of a container object, flattened (anonymous wrappers are transparent).
  function childrenOf(o, seen, depth) {
    var out = [];
    Object.keys(o).forEach(function (key) {
      var v = o[key];
      if (!v || typeof v !== "object") return;
      var sub = walk(v, seen, depth + 1, key);
      if (!sub.length) return;
      var keyedMap = isPlain(v) && !GENERIC_KEYS.test(key) && !titleOf(v) && !videoOf(v) && !pdfOf(v);
      if (!keyedMap) {
        out.push.apply(out, sub);
      } else {
        // keyed map such as { "Physics": { chapters: [...] } } -> group titled by its key
        out.push({ kind: "group", title: key, via: "", children: sub });
      }
    });
    return out;
  }

  function walk(o, seen, depth, key) {
    if (!o || typeof o !== "object" || depth > 10) return [];
    if (seen.indexOf(o) !== -1) return [];
    seen.push(o);
    var result;
    if (Array.isArray(o)) {
      result = [];
      o.forEach(function (x) { result.push.apply(result, walk(x, seen, depth + 1, key)); });
    } else {
      var video = videoOf(o);
      if (video) {
        var pdfs = childrenOf(o, seen, depth).filter(function (n) { return n.kind === "pdf"; });
        result = [{
          kind: "lecture",
          id: str(o._id) || str(o.id) || str(o.streamId) || video,
          title: titleOf(o) || "Lecture",
          video: video,
          teacher: str(o.teacher) || str(o.teacherName),
          when: str(o.startTime) || str(o.date) || str(o.createdAt),
          duration: o.duration || o.videoDuration || "",
          pdfs: pdfs
        }];
      } else {
        var pdf = pdfOf(o);
        if (pdf) result = [{ kind: "pdf", title: titleOf(o) || "Material", url: pdf, fileName: str(o.fileName) }];
        else {
          var kids = childrenOf(o, seen, depth);
          var t = titleOf(o);
          if (!kids.length) result = [];
          else if (t) result = [{ kind: "group", title: t, via: key || "", children: kids }];
          else result = kids;
        }
      }
    }
    return result;
  }

  function unwrap(json) {
    if (Array.isArray(json)) return json[0] || null;
    if (json && (json.success || json.data)) return Array.isArray(json.data) ? json.data[0] : (json.data || json);
    return json;
  }

  function normalize(json, courseName) {
    var root = unwrap(json);
    if (!root || typeof root !== "object") return [];
    var nodes = childrenOf(root, [root], 0);
    if (nodes.length === 1 && nodes[0].kind === "group" && courseName && nodes[0].title === courseName) nodes = nodes[0].children;
    return nodes;
  }

  function count(node, kind) {
    if (node.kind === kind) return 1;
    if (!node.children) return 0;
    return node.children.reduce(function (n, c) { return n + count(c, kind); }, 0);
  }

  /* ---------- helpers ---------- */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; });
  }
  function fmtDur(d) {
    if (d == null || d === "") return "";
    var n = Number(d);
    if (!isFinite(n)) return String(d);
    if (n > 100000) n = n / 1000;
    var h = Math.floor(n / 3600), m = Math.floor(n % 3600 / 60), s = Math.floor(n % 60);
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }
  function fmtDate(v) {
    if (!v) return "";
    var d = new Date(v);
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }
  function readProgress() { try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}"); } catch (e) { return {}; } }
  function saveProgress(id, t, d) {
    try { var p = readProgress(); p[id] = { t: t, d: d, at: Date.now() }; localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (e) {}
  }
  function toast(msg) { if (typeof window.showToast === "function") window.showToast(msg); }

  var ICON = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>'
  };

  /* ---------- styles (Codexyt design tokens only) ---------- */
  function injectStyle() {
    if (document.getElementById("cx-edu-style")) return;
    var css = [
      ".cxe-view{position:fixed;inset:0;z-index:5000;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:inherit;animation:cxe-in .22s ease}",
      "@keyframes cxe-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
      ".cxe-head{display:flex;align-items:center;gap:12px;padding:12px 16px;padding-top:max(12px,env(safe-area-inset-top));border-bottom:1px solid var(--line);background:var(--panel-solid)}",
      ".cxe-back{flex:none;display:grid;place-items:center;width:38px;height:38px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--text);cursor:pointer;transition:transform .15s ease,background .2s ease}",
      ".cxe-back:hover{background:rgba(255,255,255,.1)}.cxe-back:active{transform:scale(.92)}.cxe-back svg{width:18px;height:18px}",
      ".cxe-titles{min-width:0;flex:1}",
      ".cxe-title{margin:0;font:600 17px/1.3 'Space Grotesk',sans-serif;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".cxe-sub{margin:2px 0 0;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".cxe-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:18px 16px calc(28px + env(safe-area-inset-bottom))}",
      ".cxe-wrap{max-width:860px;margin:0 auto}",
      ".cxe-label{margin:18px 2px 10px;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}.cxe-label:first-child{margin-top:0}",
      ".cxe-list{display:grid;gap:10px}",
      ".cxe-row{display:flex;align-items:center;gap:13px;width:100%;padding:13px 14px;text-align:left;font:inherit;color:var(--text);border:1px solid var(--line);border-radius:var(--radius-md);background:var(--panel);cursor:pointer;transition:transform .18s ease,border-color .2s ease,background .2s ease}",
      ".cxe-row:hover{transform:translateY(-2px);border-color:var(--line-strong);background:var(--panel-soft)}.cxe-row:active{transform:scale(.985)}",
      ".cxe-ico{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:12px;color:var(--brand-bright);background:rgba(139,124,255,.12);border:1px solid rgba(139,124,255,.28)}",
      ".cxe-ico svg{width:18px;height:18px}.cxe-row.is-pdf .cxe-ico{color:var(--orange);background:rgba(255,179,107,.1);border-color:rgba(255,179,107,.28)}",
      ".cxe-row.is-lecture .cxe-ico{color:var(--mint);background:rgba(85,221,187,.1);border-color:rgba(85,221,187,.28)}",
      ".cxe-info{min-width:0;flex:1}.cxe-name{display:block;font-size:14px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}",
      ".cxe-meta{display:block;margin-top:3px;font-size:12px;color:var(--muted)}",
      ".cxe-chev{flex:none;color:var(--muted)}.cxe-chev svg{width:16px;height:16px}",
      ".cxe-bar{height:3px;margin-top:8px;border-radius:3px;background:var(--line)}.cxe-bar i{display:block;height:100%;border-radius:3px;background:var(--mint)}",
      ".cxe-state{padding:46px 20px;border:1px dashed var(--line-strong);border-radius:var(--radius-md);color:var(--muted);text-align:center;font-size:14px}",
      ".cxe-state b{display:block;margin-bottom:6px;color:var(--text);font:600 16px 'Space Grotesk',sans-serif}",
      ".cxe-state .btn{margin-top:16px}",
      ".cxe-skel{height:66px;border-radius:var(--radius-md);background:linear-gradient(90deg,var(--panel) 25%,var(--panel-soft) 50%,var(--panel) 75%);background-size:200% 100%;animation:cxe-sh 1.3s infinite}",
      "@keyframes cxe-sh{to{background-position:-200% 0}}",
      ".cxe-player{position:fixed;inset:0;z-index:5100;display:flex;flex-direction:column;background:var(--bg);animation:cxe-in .2s ease}",
      ".cxe-stage{background:#000;width:100%;display:grid;place-items:center;position:relative}",
      ".cxe-video{display:block;width:100%;max-height:min(68vh,calc(100vw*9/16));aspect-ratio:16/9;background:#000;outline:none}",
      ".cxe-perr{display:none;position:absolute;inset:0;place-content:center;gap:12px;padding:20px;text-align:center;background:rgba(0,0,0,.82);color:#fff;font-size:14px}",
      ".cxe-perr.on{display:grid}.cxe-perr .btn{justify-self:center}",
      ".cxe-pbody{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:16px 16px calc(24px + env(safe-area-inset-bottom))}",
      ".cxe-ptitle{margin:0 0 4px;font:600 18px/1.35 'Space Grotesk',sans-serif;overflow-wrap:anywhere}",
      ".cxe-pmeta{margin:0 0 14px;font-size:13px;color:var(--muted)}",
      ".cxe-tools{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}",
      ".cxe-tools .btn,.cxe-tools select{min-height:38px}",
      ".cxe-select{padding:0 12px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--text);font:inherit;font-size:13px}",
      ".cxe-select option{background:var(--panel-solid);color:var(--text)}",
      ".cxe-pdfmodal{position:fixed;inset:0;z-index:5200;display:flex;flex-direction:column;background:var(--bg);animation:cxe-in .2s ease}",
      ".cxe-frame{flex:1;width:100%;border:0;background:#fff}",
      "@media (max-width:560px){.cxe-head{padding:10px 12px}.cxe-body{padding:14px 12px calc(24px + env(safe-area-inset-bottom))}.cxe-row{padding:11px 12px}}",
      "@media (orientation:landscape) and (max-height:480px){.cxe-video{max-height:calc(100vh - 8px);aspect-ratio:auto;height:calc(100vh - 8px)}}"
    ].join("\n");
    var el = document.createElement("style");
    el.id = "cx-edu-style";
    el.textContent = css;
    document.head.appendChild(el);
  }

  /* ---------- state ---------- */
  var S = { view: null, batch: null, tree: [], path: [], player: null, pdf: null, token: 0, hls: null, loading: false, error: "" };
  var cache = {};
  var hlsPromise = null;

  function currentNodes() {
    var nodes = S.tree;
    S.path.forEach(function (g) { nodes = g.children; });
    return nodes;
  }
  function currentTitle() { return S.path.length ? S.path[S.path.length - 1].title : (S.batch && S.batch.name) || "Course"; }

  function labelFor(nodes) {
    var kinds = {};
    nodes.forEach(function (n) { kinds[n.kind] = 1; });
    var out = [];
    if (kinds.group) {
      var via = (nodes.filter(function (n) { return n.kind === "group"; })[0] || {}).via || "";
      var name = /subject/i.test(via) ? "Subjects" : /chapter/i.test(via) ? "Chapters" : /topic/i.test(via) ? "Topics" :
        S.path.length === 0 ? "Subjects" : S.path.length === 1 ? "Chapters" : "Topics";
      out.push(name);
    }
    if (kinds.lecture) out.push("Lectures");
    if (kinds.pdf) out.push("Materials");
    return out;
  }

  /* ---------- content loading ---------- */
  async function fetchContent(id) {
    if (cache[id]) return cache[id];
    var urls = [CONTENT_API + "?id=" + encodeURIComponent(id), DIRECT_API + "?id=" + encodeURIComponent(id)];
    var lastErr = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var res = await fetch(urls[i]);
        if (!res.ok) { lastErr = new Error("Server returned " + res.status); continue; }
        var text = await res.text();
        var json;
        try { json = JSON.parse(text); } catch (e) { lastErr = new Error("Course data was not valid JSON"); continue; }
        if (json && json.error && !json.data) { lastErr = new Error(String(json.error)); continue; }
        cache[id] = json;
        return json;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("Could not reach the course server");
  }

  async function loadCourse() {
    S.loading = true; S.error = ""; S.tree = []; S.path = [];
    render();
    try {
      var json = await fetchContent(S.batch._id);
      S.tree = normalize(json, S.batch.name);
    } catch (e) {
      S.error = (e && e.message) || "Failed to load course content";
    }
    S.loading = false;
    render();
  }

  /* ---------- course view ---------- */
  function ensureView() {
    if (S.view) return;
    injectStyle();
    var v = document.createElement("div");
    v.className = "cxe-view";
    v.setAttribute("role", "dialog");
    v.setAttribute("aria-label", "Course content");
    v.innerHTML = '<div class="cxe-head"><button class="cxe-back" type="button" aria-label="Back">' + ICON.back + '</button>' +
      '<div class="cxe-titles"><h2 class="cxe-title"></h2><p class="cxe-sub"></p></div></div>' +
      '<div class="cxe-body"><div class="cxe-wrap"></div></div>';
    document.body.appendChild(v);
    S.view = v;
    v.querySelector(".cxe-back").addEventListener("click", function () { history.back(); });
    v.querySelector(".cxe-wrap").addEventListener("click", onListClick);
    document.body.classList.add("modal-open");
  }

  function rowHtml(n, i) {
    if (n.kind === "group") {
      var lc = count(n, "lecture"), pc = count(n, "pdf");
      var bits = [];
      if (lc) bits.push(lc + (lc === 1 ? " lecture" : " lectures"));
      if (pc) bits.push(pc + (pc === 1 ? " material" : " materials"));
      return '<button class="cxe-row is-group" type="button" data-i="' + i + '"><span class="cxe-ico">' + ICON.folder + '</span><span class="cxe-info"><span class="cxe-name">' + esc(n.title) + '</span><span class="cxe-meta">' + esc(bits.join(" · ")) + '</span></span><span class="cxe-chev">' + ICON.chev + '</span></button>';
    }
    if (n.kind === "lecture") {
      var prog = readProgress()[n.id];
      var pct = prog && prog.d ? Math.min(100, Math.round(prog.t / prog.d * 100)) : 0;
      var meta = [n.teacher, fmtDate(n.when), fmtDur(n.duration)].filter(Boolean).join(" · ");
      if (n.pdfs.length) meta += (meta ? " · " : "") + n.pdfs.length + " PDF";
      return '<button class="cxe-row is-lecture" type="button" data-i="' + i + '"><span class="cxe-ico">' + ICON.play + '</span><span class="cxe-info"><span class="cxe-name">' + esc(n.title) + '</span>' +
        (meta ? '<span class="cxe-meta">' + esc(meta) + '</span>' : '') + (pct > 1 ? '<span class="cxe-bar"><i style="width:' + pct + '%"></i></span>' : '') + '</span><span class="cxe-chev">' + ICON.chev + '</span></button>';
    }
    return '<button class="cxe-row is-pdf" type="button" data-i="' + i + '"><span class="cxe-ico">' + ICON.pdf + '</span><span class="cxe-info"><span class="cxe-name">' + esc(n.title) + '</span><span class="cxe-meta">PDF material</span></span><span class="cxe-chev">' + ICON.chev + '</span></button>';
  }

  function render() {
    if (!S.view) return;
    S.view.querySelector(".cxe-title").textContent = currentTitle();
    var wrap = S.view.querySelector(".cxe-wrap");
    var sub = S.view.querySelector(".cxe-sub");
    if (S.loading) {
      sub.textContent = "Loading course content…";
      wrap.innerHTML = '<div class="cxe-list">' + '<div class="cxe-skel"></div>'.repeat(6) + '</div>';
      return;
    }
    if (S.error) {
      sub.textContent = "Could not load";
      wrap.innerHTML = '<div class="cxe-state"><b>Course content unavailable</b>' + esc(S.error) + '<br><button class="btn btn-primary" type="button" data-act="retry">Try again</button></div>';
      return;
    }
    var nodes = currentNodes();
    if (!nodes.length) {
      sub.textContent = "Nothing here yet";
      wrap.innerHTML = '<div class="cxe-state"><b>No content found</b>This course has no lectures or materials available right now.</div>';
      return;
    }
    var lc = S.path.length ? count(S.path[S.path.length - 1], "lecture") : S.tree.reduce(function (n, c) { return n + count(c, "lecture"); }, 0);
    sub.textContent = (S.path.length ? S.path.map(function (g) { return g.title; }).slice(0, -1).concat([""]).join(" › ") : "") + lc + (lc === 1 ? " lecture" : " lectures");
    var html = "";
    var order = ["group", "lecture", "pdf"];
    var labels = labelFor(nodes);
    var li = 0;
    order.forEach(function (kind) {
      var items = [];
      nodes.forEach(function (n, i) { if (n.kind === kind) items.push(rowHtml(n, i)); });
      if (!items.length) return;
      html += '<div class="cxe-label">' + esc(labels[li++] || "") + '</div><div class="cxe-list">' + items.join("") + '</div>';
    });
    wrap.innerHTML = html;
    S.view.querySelector(".cxe-body").scrollTop = 0;
  }

  function onListClick(e) {
    var retry = e.target.closest("[data-act='retry']");
    if (retry) { delete cache[S.batch._id]; loadCourse(); return; }
    var row = e.target.closest(".cxe-row");
    if (!row) return;
    var node = currentNodes()[Number(row.dataset.i)];
    if (!node) return;
    if (node.kind === "group") {
      S.path.push(node);
      history.pushState({ cxEdu: true, depth: S.path.length, player: false, pdf: false }, "");
      render();
    } else if (node.kind === "lecture") {
      openPlayer(node);
    } else {
      openPdf(node);
    }
  }

  /* ---------- player ---------- */
  function loadHls() {
    if (window.Hls) return Promise.resolve();
    if (!hlsPromise) {
      hlsPromise = new Promise(function (resolve, reject) {
        var s = document.createElement("script");
        s.src = "assets/hls.js_latest.js";
        s.onload = resolve;
        s.onerror = function () { hlsPromise = null; reject(new Error("video engine failed to load")); };
        document.head.appendChild(s);
      });
    }
    return hlsPromise;
  }

  function destroyHls() { if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; } }

  function openPlayer(lecture) {
    var list = currentNodes().filter(function (n) { return n.kind === "lecture"; });
    var idx = list.indexOf(lecture);
    S.player = { list: list, idx: idx < 0 ? 0 : idx, el: null };
    var p = document.createElement("div");
    p.className = "cxe-player";
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", "Lecture player");
    p.innerHTML = '<div class="cxe-head"><button class="cxe-back" type="button" aria-label="Back to lectures">' + ICON.back + '</button><div class="cxe-titles"><h2 class="cxe-title"></h2><p class="cxe-sub"></p></div></div>' +
      '<div class="cxe-stage"><video class="cxe-video" controls playsinline preload="metadata"></video><div class="cxe-perr"><div class="cxe-perr-msg"></div><button class="btn btn-primary" type="button" data-act="retry">Try again</button></div></div>' +
      '<div class="cxe-pbody"><h3 class="cxe-ptitle"></h3><p class="cxe-pmeta"></p><div class="cxe-tools"></div></div>';
    document.body.appendChild(p);
    S.player.el = p;
    p.querySelector(".cxe-back").addEventListener("click", function () { history.back(); });
    p.querySelector("[data-act='retry']").addEventListener("click", function () { startLecture(); });
    var video = p.querySelector("video");
    var lastSave = 0;
    video.addEventListener("timeupdate", function () {
      var now = Date.now();
      if (now - lastSave < 3000 || !video.duration) return;
      lastSave = now;
      var cur = S.player && S.player.list[S.player.idx];
      if (cur && video.currentTime > 0) saveProgress(cur.id, video.currentTime, video.duration);
    });
    video.addEventListener("ended", function () {
      var cur = S.player && S.player.list[S.player.idx];
      if (cur) saveProgress(cur.id, video.duration, video.duration);
    });
    history.pushState({ cxEdu: true, depth: S.path.length, player: true, pdf: false }, "");
    startLecture();
  }

  function playerError(msg) {
    var p = S.player && S.player.el;
    if (!p) return;
    p.querySelector(".cxe-perr-msg").textContent = msg;
    p.querySelector(".cxe-perr").classList.add("on");
  }

  async function startLecture() {
    var P = S.player;
    if (!P) return;
    var lec = P.list[P.idx];
    var p = P.el;
    var video = p.querySelector("video");
    var token = ++S.token;
    p.querySelector(".cxe-perr").classList.remove("on");
    p.querySelector(".cxe-title").textContent = lec.title;
    p.querySelector(".cxe-sub").textContent = currentTitle();
    p.querySelector(".cxe-ptitle").textContent = lec.title;
    p.querySelector(".cxe-pmeta").textContent = [lec.teacher, fmtDate(lec.when), "Lecture " + (P.idx + 1) + " of " + P.list.length].filter(Boolean).join(" · ");
    renderTools();

    destroyHls();
    video.pause();
    video.removeAttribute("src");
    video.load();

    var saved = readProgress()[lec.id];
    var resumeAt = saved && saved.t > 10 && saved.d && saved.t < saved.d - 10 ? saved.t : 0;
    var started = false;
    function begin() {
      if (started || token !== S.token) return;
      started = true;
      if (resumeAt) { try { video.currentTime = resumeAt; toast("Resumed from " + fmtDur(resumeAt)); } catch (e) {} }
      var pr = video.play();
      if (pr && pr.catch) pr.catch(function () {});
    }

    var url = lec.video;
    var isHls = /m3u8/i.test(url);
    var nativeHls = video.canPlayType("application/vnd.apple.mpegurl");
    if (isHls && !nativeHls) {
      try { await loadHls(); } catch (e) { if (token === S.token) playerError("The video engine could not be loaded. Check your connection and try again."); return; }
      if (token !== S.token) return;
      if (!window.Hls || !window.Hls.isSupported()) { playerError("This browser cannot play this stream."); return; }
      var hls = new window.Hls();
      S.hls = hls;
      var recovered = false;
      hls.on(window.Hls.Events.MANIFEST_PARSED, begin);
      hls.on(window.Hls.Events.ERROR, function (ev, data) {
        if (!data || !data.fatal || token !== S.token) return;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && !recovered) { recovered = true; hls.startLoad(); return; }
        playerError("This lecture could not be played. The stream may have expired or be blocked.");
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.onerror = function () { if (token === S.token) playerError("This lecture could not be played. The stream may have expired or be blocked."); };
      video.addEventListener("loadedmetadata", begin, { once: true });
      video.src = url;
    }
  }

  function renderTools() {
    var P = S.player;
    var lec = P.list[P.idx];
    var box = P.el.querySelector(".cxe-tools");
    var speed = P.speed || "1";
    var html = "";
    if (P.idx > 0) html += '<button class="btn btn-quiet" type="button" data-act="prev">Previous</button>';
    if (P.idx < P.list.length - 1) html += '<button class="btn btn-primary" type="button" data-act="next">Next lecture</button>';
    html += '<select class="cxe-select" data-act="speed" aria-label="Playback speed">' +
      ["0.5", "0.75", "1", "1.25", "1.5", "2"].map(function (s) { return '<option value="' + s + '"' + (s === speed ? " selected" : "") + '>' + s + 'x</option>'; }).join("") + '</select>';
    lec.pdfs.forEach(function (pdf, i) { html += '<button class="btn btn-quiet" type="button" data-pdf="' + i + '">' + ICON.pdf + esc(pdf.title.length > 28 ? pdf.title.slice(0, 27) + "…" : pdf.title) + '</button>'; });
    box.innerHTML = html;
    var video = P.el.querySelector("video");
    video.playbackRate = Number(speed);
    box.onclick = function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "prev" && P.idx > 0) { P.idx--; startLecture(); }
      else if (b.dataset.act === "next" && P.idx < P.list.length - 1) { P.idx++; startLecture(); }
      else if (b.dataset.pdf != null) openPdf(lec.pdfs[Number(b.dataset.pdf)]);
    };
    box.onchange = function (e) {
      if (e.target.dataset.act === "speed") { P.speed = e.target.value; video.playbackRate = Number(P.speed); }
    };
  }

  function closePlayer() {
    S.token++;
    destroyHls();
    if (S.player && S.player.el) {
      var v = S.player.el.querySelector("video");
      try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) {}
      S.player.el.remove();
    }
    S.player = null;
    render();
  }

  /* ---------- PDF viewer ---------- */
  function openPdf(pdf) {
    var m = document.createElement("div");
    m.className = "cxe-pdfmodal";
    m.setAttribute("role", "dialog");
    m.setAttribute("aria-label", "PDF viewer");
    m.innerHTML = '<div class="cxe-head"><button class="cxe-back" type="button" aria-label="Close PDF">' + ICON.back + '</button><div class="cxe-titles"><h2 class="cxe-title">' + esc(pdf.title) + '</h2><p class="cxe-sub">PDF material</p></div>' +
      '<a class="btn btn-quiet" href="' + esc(pdf.url) + '" target="_blank" rel="noopener" download="' + esc(pdf.fileName || "material.pdf") + '">' + ICON.dl + 'Download</a></div>' +
      '<iframe class="cxe-frame" src="' + esc(pdf.url) + '" title="' + esc(pdf.title) + '"></iframe>';
    document.body.appendChild(m);
    S.pdf = m;
    m.querySelector(".cxe-back").addEventListener("click", function () { history.back(); });
    history.pushState({ cxEdu: true, depth: S.path.length, player: !!S.player, pdf: true }, "");
  }
  function closePdf() { if (S.pdf) { S.pdf.remove(); S.pdf = null; } }

  /* ---------- open / close / history ---------- */
  function closeAll() {
    closePdf();
    if (S.player) { closePlayer(); }
    if (S.view) { S.view.remove(); S.view = null; }
    document.body.classList.remove("modal-open");
    S.batch = null; S.tree = []; S.path = [];
  }

  window.addEventListener("popstate", function (e) {
    if (!S.view) return;
    var st = e.state;
    if (!st || !st.cxEdu) { closeAll(); return; }
    if (!st.pdf) closePdf();
    if (!st.player && S.player) closePlayer();
    if (st.depth < S.path.length) { S.path.length = st.depth; render(); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && S.view) history.back();
  });

  function open(batch) {
    if (!batch || !batch._id) return;
    if (S.view) closeAll();
    S.batch = batch;
    ensureView();
    history.pushState({ cxEdu: true, depth: 0, player: false, pdf: false }, "");
    loadCourse();
  }

  window.CXEdustream = { open: open, _normalize: normalize };
})();
