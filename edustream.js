/* Edustream course view + HLS player for Codexyt.
   Loaded on demand the first time an Edustream batch is opened; Codexyt batches never touch this file.
   Data comes from the Edustream /api/course-content?id=<courseId> endpoint. The response tree is discovered
   dynamically (subjects / chapters / lectures / PDFs) so it adapts to whatever nesting the API returns. */
(function () {
  if (window.CXEdustream) return;

  var CONTENT_API = "/api/course-content";
  var DIRECT_API = "https://studyapkmod-targetboard.vercel.app/api/course-content";
  var PROGRESS_KEY = "cx-edu-progress";

  /* ---------- debug (console only, never shown in the UI) ---------- */
  // Enable with  ?edudebug=1  in the URL, or  localStorage.setItem("cx-edu-debug","1")  ("raw" also prints full values).
  function debugLevel() {
    try {
      var q = new URLSearchParams(location.search).get("edudebug");
      if (q) return q === "raw" ? "raw" : "1";
      var v = localStorage.getItem("cx-edu-debug");
      return v === "raw" ? "raw" : v ? "1" : "";
    } catch (e) { return ""; }
  }
  function urlHost(v) { try { return new URL(v).host; } catch (e) { return ""; } }
  // Structure only: keys, types, array lengths. Strings are reduced to their length; URLs to their host.
  function shape(v, depth) {
    if (v === null) return "null";
    if (Array.isArray(v)) {
      if (depth > 7) return "array(" + v.length + ")";
      var merged = {};
      v.slice(0, 5).forEach(function (x) {
        if (x && typeof x === "object" && !Array.isArray(x)) Object.keys(x).forEach(function (k) { if (!(k in merged)) merged[k] = shape(x[k], depth + 1); });
      });
      return { "__array": v.length, "__item": v.length ? (Object.keys(merged).length ? merged : shape(v[0], depth + 1)) : null };
    }
    if (typeof v === "object") {
      if (depth > 7) return "object";
      var o = {};
      Object.keys(v).slice(0, 60).forEach(function (k) { o[k] = shape(v[k], depth + 1); });
      return o;
    }
    if (typeof v === "string") { var h = /^https?:\/\//i.test(v) ? urlHost(v) : ""; return h ? "string(url:" + h + ")" : "string(" + v.length + ")"; }
    return typeof v;
  }
  function debugLog(label, payload) {
    var level = debugLevel();
    if (!level || typeof console === "undefined") return;
    try { console.groupCollapsed("[CXEdustream] " + label); console.log(payload); console.groupEnd(); } catch (e) {}
  }
  function warn(msg, extra) {
    if (typeof console === "undefined") return;
    try { if (extra !== undefined) console.warn("[CXEdustream] " + msg, extra); else console.warn("[CXEdustream] " + msg); } catch (e) {}
  }

  /* ---------- field helpers ---------- */
  var stats = null;
  function freshStats() { return { malformed: false, usedFallback: false, invalidHls: 0, contentsWithoutPdf: 0, subjects: 0, chapters: 0, lectures: 0, pdfs: 0 }; }

  function str(v) { return typeof v === "string" ? v.trim() : ""; }
  function isPlain(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function validUrl(u) { return /^https?:\/\/[^\s]+$/i.test(u); }

  var TITLE_KEYS = ["title", "name", "lectureName", "topicName", "subjectName", "chapterName", "label", "fileName"];
  function titleOf(o) {
    if (!isPlain(o)) return "";
    for (var i = 0; i < TITLE_KEYS.length; i++) { var t = str(o[TITLE_KEYS[i]]); if (t) return t; }
    return "";
  }

  // Structural key names. The first entry is the documented Edustream one; the rest are safe synonyms.
  var K = {
    subjects: ["subjects", "subjectList"],
    chapters: ["chapters", "chapterList", "topics", "units", "modules", "sections"],
    streams: ["streams", "lectures", "videos", "classes"],
    lessons: ["lessons"],
    contents: ["contents", "content", "attachments", "materials", "resources", "notes", "pdfs", "files"]
  };
  var HLS_KEYS = ["hlsUrl", "hlsURL", "hls_url"];
  var PDF_URL_KEYS = ["url", "pdfUrl", "fileUrl", "link", "downloadUrl", "file"];

  // Accepts an array, a single item object, or a keyed map of item objects; never throws, never returns non-objects.
  function toList(v) {
    if (Array.isArray(v)) return v.filter(isPlain);
    if (!isPlain(v)) return [];
    var keys = Object.keys(v);
    if (!keys.length) return [];
    var looksLikeItem = keys.some(function (k) { return HLS_KEYS.indexOf(k) !== -1 || TITLE_KEYS.indexOf(k) !== -1 || PDF_URL_KEYS.indexOf(k) !== -1 || k === "_id"; });
    if (looksLikeItem) return [v];
    var out = [];
    keys.forEach(function (k) {
      var it = v[k];
      if (isPlain(it)) { var copy = {}; Object.keys(it).forEach(function (kk) { copy[kk] = it[kk]; }); copy.__key = k; out.push(copy); }
      else if (Array.isArray(it)) it.forEach(function (x) { if (isPlain(x)) out.push(x); });
    });
    return out;
  }
  function listAt(o, names) {
    var out = [];
    if (!isPlain(o)) return out;
    names.forEach(function (n) { if (n in o) out.push.apply(out, toList(o[n])); });
    return out;
  }
  function groupTitle(o) { return titleOf(o) || str(o.__key) || "Untitled"; }

  function hlsOf(o) {
    var found = false;
    for (var i = 0; i < HLS_KEYS.length; i++) {
      var v = str(o[HLS_KEYS[i]]);
      if (v) { if (validUrl(v)) return v; found = true; }
      else if (o[HLS_KEYS[i]] != null && o[HLS_KEYS[i]] !== "") found = true;
    }
    if (found && stats) stats.invalidHls++;
    return "";
  }
  function isPdfHint(o, url) {
    if (/\.pdf(\?|#|$)/i.test(url)) return true;
    var hint = [o.type, o.contentType, o.mimeType, o.fileType, o.format, o.extension, o.fileName].map(str).join(" ");
    return /pdf/i.test(hint);
  }
  function pdfUrlOf(o) {
    for (var i = 0; i < PDF_URL_KEYS.length; i++) {
      var v = str(o[PDF_URL_KEYS[i]]);
      if (v && validUrl(v) && isPdfHint(o, v)) return v;
    }
    return "";
  }

  function makeLecture(o, hls, pdfs) {
    var realId = str(o._id) || str(o.id);
    return {
      kind: "lecture",
      id: realId,                      // real API id only (may be empty)
      key: realId || hls,              // storage key for resume progress (derived from real data)
      title: titleOf(o) || "Lecture",
      video: hls,
      teacher: str(o.teacher) || str(o.teacherName),
      when: str(o.startTime) || str(o.date) || str(o.createdAt),
      duration: o.duration || o.videoDuration || "",
      pdfs: pdfs || []
    };
  }
  function makePdf(o, url) { return { kind: "pdf", title: titleOf(o) || "Material", url: url, fileName: str(o.fileName) }; }

  function mapContent(c) {
    if (!isPlain(c)) return null;
    var hls = hlsOf(c);
    if (hls) return makeLecture(c, hls, []);
    var u = pdfUrlOf(c);
    if (u) return makePdf(c, u);
    if (stats) stats.contentsWithoutPdf++;
    return null;
  }
  function mapContents(o) { return listAt(o, K.contents).map(mapContent).filter(Boolean); }

  // A stream or lesson: a video when it carries a valid hlsUrl, otherwise a titled folder.
  // Nested `streams` and `lessons` (at any reasonable depth) are inspected recursively; PDFs found in an item's own
  // `contents` stay attached to that item when it is a lecture.
  function mapNested(o, depth) {
    var out = [];
    if (depth > 8) return out;
    listAt(o, K.streams).forEach(function (x) { out.push.apply(out, mapItem(x, "streams", depth + 1)); });
    listAt(o, K.lessons).forEach(function (x) { out.push.apply(out, mapItem(x, "lessons", depth + 1)); });
    return out;
  }
  function mapItem(o, via, depth) {
    if (!isPlain(o)) return [];
    depth = depth || 0;
    var contents = mapContents(o);
    var nested = mapNested(o, depth);
    var hls = hlsOf(o);
    if (hls) {
      return [makeLecture(o, hls, contents.filter(function (c) { return c.kind === "pdf"; }))]
        .concat(contents.filter(function (c) { return c.kind === "lecture"; }), nested);
    }
    var children = nested.concat(contents);
    if (!children.length) return [];
    return [{ kind: "group", title: groupTitle(o), via: via, children: children }];
  }
  function mapContainer(o) {
    var out = [];
    listAt(o, K.streams).forEach(function (x) { out.push.apply(out, mapItem(x, "streams", 0)); });
    listAt(o, K.lessons).forEach(function (x) { out.push.apply(out, mapItem(x, "lessons", 0)); });
    out.push.apply(out, mapContents(o));
    return out;
  }
  function mapGroup(o, via, depth) {
    if (depth > 6) return null;
    var kids = [];
    listAt(o, K.chapters).forEach(function (ch) { var g = mapGroup(ch, "chapters", depth + 1); if (g) kids.push(g); });
    kids.push.apply(kids, mapContainer(o));
    if (!kids.length) return null;
    return { kind: "group", title: groupTitle(o), via: via, children: kids };
  }
  function mapCourse(root) {
    var out = [];
    listAt(root, K.subjects).forEach(function (sub) { var g = mapGroup(sub, "subjects", 0); if (g) out.push(g); });
    out.push.apply(out, mapContainer(root));
    return out;
  }

  /* ---------- fallback parser (used only when the documented fields produce nothing) ---------- */
  var GENERIC_KEYS = /^(data|content|contents|course|courseContent|result|results|response|tree|items|children|subjects|chapters|topics|lectures|lessons|modules|sections|folders|files|videos|streams|notes|pdfs|attachments|materials|classes)$/i;
  var walkBudget = 0;

  // Children of a container object, flattened (anonymous wrappers are transparent).
  function childrenOf(o, seen, depth) {
    var out = [];
    Object.keys(o).forEach(function (key) {
      var v = o[key];
      if (!v || typeof v !== "object") return;
      var sub = walk(v, seen, depth + 1, key);
      if (!sub.length) return;
      var keyedMap = isPlain(v) && !GENERIC_KEYS.test(key) && !titleOf(v) && !hlsOf(v) && !pdfUrlOf(v);
      if (!keyedMap) out.push.apply(out, sub);
      else out.push({ kind: "group", title: key, via: "", children: sub });
    });
    return out;
  }

  function walk(o, seen, depth, key) {
    if (!o || typeof o !== "object" || depth > 10 || walkBudget-- <= 0) return [];
    if (seen.indexOf(o) !== -1) return [];
    seen.push(o);
    var result = [];
    if (Array.isArray(o)) {
      o.forEach(function (x) { result.push.apply(result, walk(x, seen, depth + 1, key)); });
      return result;
    }
    var video = hlsOf(o);
    if (video) {
      var pdfs = childrenOf(o, seen, depth).filter(function (n) { return n.kind === "pdf"; });
      return [makeLecture(o, video, pdfs)];
    }
    var pdf = pdfUrlOf(o);
    if (pdf) return [makePdf(o, pdf)];
    var kids = childrenOf(o, seen, depth);
    if (!kids.length) return [];
    var t = titleOf(o);
    return t ? [{ kind: "group", title: t, via: key || "", children: kids }] : kids;
  }

  function unwrap(json) {
    var d = json;
    if (isPlain(json) && ("data" in json || json.success !== undefined)) d = "data" in json ? json.data : json;
    if (Array.isArray(d)) {
      var objs = d.filter(isPlain);
      if (objs.length === 1) return objs[0];
      return { __rootArray: objs, subjects: objs };
    }
    return d;
  }

  function normalize(json, courseName) {
    stats = freshStats();
    try {
      var root = unwrap(json);
      if (!isPlain(root)) { stats.malformed = true; return []; }
      if (!listAt(root, K.subjects).length && isPlain(root.course)) root = root.course;
      var nodes = mapCourse(root);
      if (root.__rootArray && !nodes.length) {
        // root array of course-like wrappers: map each one's own subjects
        root.__rootArray.forEach(function (el) { nodes.push.apply(nodes, mapCourse(el)); });
      }
      if (!nodes.length) {
        stats.usedFallback = true;
        walkBudget = 20000;
        var src = root.__rootArray || root;
        nodes = Array.isArray(src) ? walk(src, [], 0, "") : childrenOf(src, [src], 0);
        if (nodes.length === 1 && nodes[0].kind === "group" && courseName && nodes[0].title === courseName) nodes = nodes[0].children;
      }
      tally(nodes);
      return nodes;
    } catch (e) {
      stats.malformed = true;
      warn("normalize failed: " + (e && e.message));
      return [];
    }
  }
  function tally(nodes) {
    nodes.forEach(function (n) {
      if (n.kind === "lecture") stats.lectures++;
      else if (n.kind === "pdf") stats.pdfs++;
      else if (n.kind === "group") {
        if (n.via === "subjects") stats.subjects++; else if (n.via === "chapters") stats.chapters++;
        tally(n.children);
      }
    });
  }

  function count(node, kind) {
    if (node.kind === kind) return 1;
    if (!node.children) return 0;
    return node.children.reduce(function (n, c) { return n + count(c, kind); }, 0);
  }

  /* ---------- presentation structure: keep videos and materials apart ---------- */
  // Classification uses each item's real type (valid hlsUrl -> lecture, valid PDF url -> pdf), never the array it came from.
  function isStructural(g) {
    return g.via === "subjects" || g.via === "chapters" || g.children.some(function (c) { return c.kind === "group"; });
  }
  // Drops repeated items among siblings, keyed by real _id or URL.
  function dedupe(nodes) {
    var ids = {}, urls = {};
    return nodes.filter(function (n) {
      if (n.kind === "lecture") {
        if ((n.id && ids["l" + n.id]) || urls["v" + n.video]) return false;
        if (n.id) ids["l" + n.id] = 1;
        urls["v" + n.video] = 1;
      } else if (n.kind === "pdf") {
        if (urls["p" + n.url]) return false;
        urls["p" + n.url] = 1;
      }
      return true;
    });
  }
  function signature(n) {
    if (n.kind === "lecture") return "l:" + (n.id || n.video);
    if (n.kind === "pdf") return "p:" + n.url;
    return "g:" + n.section + ":" + n.title + "[" + (n.children || []).map(signature).join("|") + "]";
  }
  // Removes repeated identical folders (same section, title and contents) among siblings.
  function dropRepeatedGroups(nodes) {
    var seen = {};
    return nodes.filter(function (n) {
      if (n.kind !== "group") return true;
      var sig = signature(n);
      if (seen[sig]) return false;
      seen[sig] = 1;
      return true;
    });
  }
  // Course-wide lecture dedupe: a lecture is the same lecture when it shares a real _id or the same hlsUrl, wherever it appears.
  // The first occurrence wins; attachments of later copies are merged into it. Groups left empty are pruned.
  function dedupeLectures(nodes) {
    var byId = {}, byUrl = {};
    function walkNodes(list) {
      var out = [];
      list.forEach(function (n) {
        if (n.kind === "lecture") {
          var first = (n.id && byId[n.id]) || byUrl[n.video];
          if (first) {
            (n.pdfs || []).forEach(function (p) { if (!first.pdfs.some(function (q) { return q.url === p.url; })) first.pdfs.push(p); });
            return;
          }
          n.pdfs = n.pdfs || [];
          if (n.id) byId[n.id] = n;
          byUrl[n.video] = n;
          out.push(n);
        } else if (n.kind === "group") {
          var kids = walkNodes(n.children || []);
          if (kids.length) out.push({ kind: "group", title: n.title, via: n.via, children: kids });
        } else out.push(n);
      });
      return out;
    }
    return walkNodes(nodes || []);
  }
  function organize(nodes) {
    return organizeNodes(dedupeLectures(nodes));
  }
  function organizeNodes(nodes) {
    return dropRepeatedGroups(organizeLevel(nodes));
  }
  function organizeLevel(nodes) {
    var out = [];
    dedupe(nodes || []).forEach(function (n) {
      if (n.kind === "lecture") {
        var seen = {};
        n.pdfs = (n.pdfs || []).filter(function (p) { if (seen[p.url]) return false; seen[p.url] = 1; return true; });
        out.push(n);
        return;
      }
      if (n.kind !== "group") { out.push(n); return; }
      if (isStructural(n)) {
        // Subject / chapter style container: keep as one navigation card, organise what is inside it.
        var inner = organizeNodes(n.children);
        if (inner.length) out.push({ kind: "group", title: n.title, via: n.via, section: "structure", children: inner });
        return;
      }
      // Leaf topic/folder: split by the real type of its items so videos and PDFs never share a card.
      var mats = organizeNodes(n.children.filter(function (c) { return c.kind === "pdf"; }));
      var lecs = organizeNodes(n.children.filter(function (c) { return c.kind === "lecture"; }));
      if (mats.length) out.push({ kind: "group", title: n.title, via: n.via, section: "material", children: mats });
      if (lecs.length) out.push({ kind: "group", title: n.title, via: n.via, section: "lecture", children: lecs });
    });
    return out;
  }
  // Splits one level into its three display sections (arrays of indexes into `nodes`).
  function sectionize(nodes) {
    var sec = { structure: [], materials: [], lectures: [] };
    nodes.forEach(function (n, i) {
      if (n.kind === "pdf") sec.materials.push(i);
      else if (n.kind === "lecture") sec.lectures.push(i);
      else if (n.section === "material") sec.materials.push(i);
      else if (n.section === "lecture") sec.lectures.push(i);
      else sec.structure.push(i);
    });
    return sec;
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
      ".cxe-stage{background:#000;width:100%;position:relative}",
      ".cxe-video{display:block;width:100%;max-height:min(68vh,calc(100vw*9/16));aspect-ratio:16/9;background:#000;outline:none}",
      ".cxe-perr{display:none;position:absolute;left:0;right:0;top:0;bottom:56px;place-content:center;gap:12px;padding:20px;text-align:center;background:rgba(0,0,0,.82);color:#fff;font-size:14px}",
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
      ".cxe-ctrl{width:100%;padding:8px 12px 10px;background:#0b0d13;color:#fff}",
      ".cxe-seek{width:100%;margin:0 0 6px;height:22px;accent-color:var(--brand);cursor:pointer;background:transparent}",
      ".cxe-crow{display:flex;align-items:center;gap:4px}.cxe-crow .sp{flex:1}",
      ".cxe-cb{flex:none;display:grid;place-items:center;width:38px;height:38px;border:0;border-radius:10px;background:transparent;color:#fff;cursor:pointer;transition:background .15s ease,transform .12s ease;position:relative}",
      ".cxe-cb:hover{background:rgba(255,255,255,.12)}.cxe-cb:active{transform:scale(.9)}.cxe-cb svg{width:20px;height:20px}",
      ".cxe-cb small{position:absolute;bottom:3px;font-size:8px;font-weight:800;pointer-events:none}",
      ".cxe-vol{width:70px;accent-color:var(--brand);cursor:pointer}",
      ".cxe-time{font-size:12px;color:#c9cfdc;font-variant-numeric:tabular-nums;padding:0 6px;white-space:nowrap}",
      ".cxe-cspeed{height:32px;padding:0 6px;border-radius:9px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#fff;font:inherit;font-size:12px}.cxe-cspeed option{background:#11151f;color:#fff}",
      ".cxe-bigplay{position:absolute;left:50%;top:calc(50% - 30px);transform:translate(-50%,-50%);display:grid;place-items:center;width:64px;height:64px;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;backdrop-filter:blur(4px)}",
      ".cxe-bigplay svg{width:28px;height:28px}.cxe-bigplay.hide{display:none}",
      ".cxe-stage{display:flex;flex-direction:column;align-items:stretch}",
      ".cxe-stage:fullscreen{background:#000}.cxe-stage:fullscreen .cxe-video{flex:1;min-height:0;max-height:none;aspect-ratio:auto;height:auto}",
      ".cxe-stage:-webkit-full-screen{background:#000}.cxe-stage:-webkit-full-screen .cxe-video{flex:1;min-height:0;max-height:none;aspect-ratio:auto;height:auto}",
      "@media (max-width:560px){.cxe-vol{display:none}.cxe-cb{width:34px;height:34px}.cxe-time{padding:0 2px;font-size:11px}}",
      "@media (max-width:560px){.cxe-head{padding:10px 12px}.cxe-body{padding:14px 12px calc(24px + env(safe-area-inset-bottom))}.cxe-row{padding:11px 12px}}",
      "@media (orientation:landscape) and (max-height:480px){.cxe-video{max-height:calc(100vh - 120px);aspect-ratio:auto;height:calc(100vh - 120px)}}"
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

  // Heading for the navigation cards (subjects / chapters / folders) at the current level.
  function structureLabel(groups) {
    var via = (groups[0] && groups[0].via) || "";
    return /subject/i.test(via) ? "Subjects" : /chapter/i.test(via) ? "Chapters" : /topic/i.test(via) ? "Topics" :
      S.path.length === 0 ? "Subjects" : S.path.length === 1 ? "Chapters" : "Folders";
  }

  /* ---------- content loading ---------- */
  function fetchWithTimeout(url, ms) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : null;
    return fetch(url, ctl ? { signal: ctl.signal, cache: "no-store" } : { cache: "no-store" }).then(
      function (r) { if (timer) clearTimeout(timer); return r; },
      function (e) { if (timer) clearTimeout(timer); throw e; }
    );
  }

  async function fetchContent(id) {
    id = String(id == null ? "" : id).trim();
    if (!id) throw new Error("This course has no ID.");
    if (cache[id]) return cache[id];
    var q = "?id=" + encodeURIComponent(id);
    var urls = [CONTENT_API + q, DIRECT_API + q];
    var lastErr = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var res = await fetchWithTimeout(urls[i], 20000);
        if (!res.ok) { lastErr = new Error(res.status === 404 ? "Course content was not found (HTTP 404)." : "The course server returned HTTP " + res.status + "."); continue; }
        var text = await res.text();
        if (!text || !text.trim()) { lastErr = new Error("The course server returned an empty response."); continue; }
        if (text.trim().charAt(0) === "<") { lastErr = new Error("The course server returned a web page instead of course data."); continue; }
        var json;
        try { json = JSON.parse(text); } catch (e) { lastErr = new Error("Course data was not valid JSON."); continue; }
        if (json === null || typeof json !== "object") { lastErr = new Error("Course data was empty or in an unexpected format."); continue; }
        if (isPlain(json) && json.error && !json.data) { lastErr = new Error(typeof json.error === "string" ? json.error : "The course server reported an error."); continue; }
        cache[id] = json;
        return json;
      } catch (e) {
        lastErr = e && e.name === "AbortError" ? new Error("The course server took too long to respond.") : new Error("Could not reach the course server. Check your connection.");
      }
    }
    throw lastErr || new Error("Could not reach the course server.");
  }

  async function loadCourse() {
    var batch = S.batch;
    S.loading = true; S.error = ""; S.tree = []; S.path = [];
    render();
    try {
      var json = await fetchContent(batch._id);
      if (S.batch !== batch || !S.view) return;   // closed or switched to another course while loading
      var level = debugLevel();
      if (level) {
        debugLog("course-content structure (id=" + S.batch._id + ")", shape(json, 0));
        if (level === "raw") debugLog("course-content RAW response", json);
      }
      S.tree = organize(normalize(json, batch.name));
      var st = stats;
      if (st.malformed) S.error = "The course data was in an unexpected format.";
      if (st.usedFallback && S.tree.length) warn("explicit mapping (subjects/chapters/streams/lessons/contents) found nothing; used fallback parser. Enable debug (?edudebug=1) to see the response structure.");
      if (!S.tree.length) warn("mapped 0 lectures/PDFs from this response. Enable debug (?edudebug=1) and check the logged structure.", { invalidHlsUrl: st.invalidHls, contentsWithoutValidPdfUrl: st.contentsWithoutPdf, malformed: st.malformed });
      if (level) debugLog("mapped summary", { subjects: st.subjects, chapters: st.chapters, lectures: st.lectures, pdfs: st.pdfs, usedFallback: st.usedFallback, skippedInvalidHls: st.invalidHls, skippedContentsWithoutPdfUrl: st.contentsWithoutPdf });
    } catch (e) {
      if (S.batch !== batch || !S.view) return;
      S.error = (e && e.message) || "Failed to load course content.";
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
      // Lecture topics show only lecture counts and material topics only material counts; navigation cards show both.
      if (lc && n.section !== "material") bits.push(lc + (lc === 1 ? " lecture" : " lectures"));
      if (pc && n.section !== "lecture") bits.push(pc + (pc === 1 ? " material" : " materials"));
      var cls = n.section === "lecture" ? " is-lecture" : n.section === "material" ? " is-pdf" : "";
      var ico = n.section === "lecture" ? ICON.play : ICON.folder;
      return '<button class="cxe-row is-group' + cls + '" type="button" data-i="' + i + '"><span class="cxe-ico">' + ico + '</span><span class="cxe-info"><span class="cxe-name">' + esc(n.title) + '</span><span class="cxe-meta">' + esc(bits.join(" · ")) + '</span></span><span class="cxe-chev">' + ICON.chev + '</span></button>';
    }
    if (n.kind === "lecture") {
      var prog = readProgress()[n.key];
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
    var sec = sectionize(nodes);
    function block(label, idxs) {
      if (!idxs.length) return;
      html += '<div class="cxe-label">' + esc(label) + '</div><div class="cxe-list">' + idxs.map(function (i) { return rowHtml(nodes[i], i); }).join("") + '</div>';
    }
    block(structureLabel(sec.structure.map(function (i) { return nodes[i]; })), sec.structure);
    block("Topics / Materials", sec.materials);
    block("Lectures", sec.lectures);
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

  var CI = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    back10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg><small>10</small>',
    fwd10: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg><small>10</small>',
    vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
    pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor"/></svg>',
    full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>'
  };

  function clock(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }

  function openPlayer(lecture) {
    var list = currentNodes().filter(function (n) { return n.kind === "lecture"; });
    var idx = list.indexOf(lecture);
    S.player = { list: list, idx: idx < 0 ? 0 : idx, el: null, speed: "1" };
    var p = document.createElement("div");
    p.className = "cxe-player";
    p.setAttribute("role", "dialog");
    p.setAttribute("aria-label", "Lecture player");
    p.innerHTML = '<div class="cxe-head"><button class="cxe-back" type="button" aria-label="Back to lectures">' + ICON.back + '</button><div class="cxe-titles"><h2 class="cxe-title"></h2><p class="cxe-sub"></p></div></div>' +
      '<div class="cxe-stage"><video class="cxe-video" playsinline preload="metadata"></video>' +
      '<button class="cxe-bigplay" type="button" aria-label="Play">' + CI.play + '</button>' +
      '<div class="cxe-perr"><div class="cxe-perr-msg"></div><div><button class="btn btn-primary" type="button" data-act="retry">Try again</button></div></div>' +
      '<div class="cxe-ctrl"><input class="cxe-seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek">' +
      '<div class="cxe-crow">' +
      '<button class="cxe-cb" type="button" data-c="play" aria-label="Play or pause">' + CI.play + '</button>' +
      '<button class="cxe-cb" type="button" data-c="back" aria-label="Back 10 seconds">' + CI.back10 + '</button>' +
      '<button class="cxe-cb" type="button" data-c="fwd" aria-label="Forward 10 seconds">' + CI.fwd10 + '</button>' +
      '<button class="cxe-cb" type="button" data-c="mute" aria-label="Mute">' + CI.vol + '</button>' +
      '<input class="cxe-vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">' +
      '<span class="cxe-time">0:00 / 0:00</span><span class="sp"></span>' +
      '<select class="cxe-cspeed" aria-label="Playback speed">' + ["0.5", "0.75", "1", "1.25", "1.5", "2"].map(function (x) { return '<option value="' + x + '"' + (x === "1" ? " selected" : "") + '>' + x + 'x</option>'; }).join("") + '</select>' +
      '<button class="cxe-cb" type="button" data-c="pip" aria-label="Picture in picture">' + CI.pip + '</button>' +
      '<button class="cxe-cb" type="button" data-c="full" aria-label="Fullscreen">' + CI.full + '</button>' +
      '</div></div></div>' +
      '<div class="cxe-pbody"><h3 class="cxe-ptitle"></h3><p class="cxe-pmeta"></p><div class="cxe-tools"></div></div>';
    document.body.appendChild(p);
    S.player.el = p;
    bindControls(S.player);
    history.pushState({ cxEdu: true, depth: S.path.length, player: true, pdf: false }, "");
    startLecture();
  }

  function bindControls(P) {
    var p = P.el;
    var video = p.querySelector("video");
    var stage = p.querySelector(".cxe-stage");
    var seek = p.querySelector(".cxe-seek");
    var vol = p.querySelector(".cxe-vol");
    var time = p.querySelector(".cxe-time");
    var big = p.querySelector(".cxe-bigplay");
    var playBtn = p.querySelector("[data-c='play']");
    var muteBtn = p.querySelector("[data-c='mute']");
    var pipBtn = p.querySelector("[data-c='pip']");
    var dragging = false;
    var lastSave = 0;

    p.querySelector(".cxe-back").addEventListener("click", function () { history.back(); });
    p.querySelector("[data-act='retry']").addEventListener("click", function () { startLecture(); });

    function toggle() { if (video.paused) { var pr = video.play(); if (pr && pr.catch) pr.catch(function () {}); } else video.pause(); }
    function skip(d) { var dur = video.duration || 0; video.currentTime = Math.max(0, Math.min(dur || Infinity, video.currentTime + d)); }
    function fullscreen() {
      var fe = document.fullscreenElement || document.webkitFullscreenElement;
      if (fe) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
      if (stage.requestFullscreen) stage.requestFullscreen().catch(function () {});
      else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    }
    function pip() {
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(function () {});
      else if (video.requestPictureInPicture) video.requestPictureInPicture().catch(function () { toast("Picture in picture is not available for this video"); });
      else if (video.webkitSetPresentationMode) video.webkitSetPresentationMode("picture-in-picture");
    }
    P.api = { toggle: toggle, skip: skip, fullscreen: fullscreen, mute: function () { video.muted = !video.muted; syncVol(); } };

    function syncPlay() {
      var playing = !video.paused;
      playBtn.innerHTML = playing ? CI.pause : CI.play;
      big.innerHTML = CI.play;
      big.classList.toggle("hide", playing);
    }
    function syncVol() { muteBtn.innerHTML = video.muted || video.volume === 0 ? CI.mute : CI.vol; vol.value = video.muted ? 0 : video.volume; }
    function syncTime() {
      var dur = video.duration || 0, cur = video.currentTime || 0;
      time.textContent = clock(cur) + " / " + clock(dur);
      if (!dragging && dur) seek.value = Math.round(cur / dur * 1000);
    }

    if (!(document.pictureInPictureEnabled || video.webkitSetPresentationMode)) pipBtn.style.display = "none";

    p.querySelector(".cxe-crow").addEventListener("click", function (e) {
      var b = e.target.closest("[data-c]");
      if (!b) return;
      var c = b.dataset.c;
      if (c === "play") toggle(); else if (c === "back") skip(-10); else if (c === "fwd") skip(10);
      else if (c === "mute") P.api.mute(); else if (c === "pip") pip(); else if (c === "full") fullscreen();
    });
    p.querySelector(".cxe-cspeed").addEventListener("change", function (e) { P.speed = e.target.value; video.playbackRate = Number(P.speed); });
    big.addEventListener("click", toggle);
    video.addEventListener("click", toggle);
    vol.addEventListener("input", function () { video.volume = Number(vol.value); video.muted = Number(vol.value) === 0; syncVol(); });
    seek.addEventListener("input", function () { dragging = true; var dur = video.duration || 0; time.textContent = clock(seek.value / 1000 * dur) + " / " + clock(dur); });
    seek.addEventListener("change", function () { var dur = video.duration || 0; if (dur) video.currentTime = seek.value / 1000 * dur; dragging = false; });
    video.addEventListener("play", syncPlay);
    video.addEventListener("pause", syncPlay);
    video.addEventListener("volumechange", syncVol);
    video.addEventListener("loadedmetadata", syncTime);
    video.addEventListener("timeupdate", function () {
      syncTime();
      var now = Date.now();
      if (now - lastSave < 3000 || !video.duration) return;
      lastSave = now;
      var cur = P.list[P.idx];
      if (cur && video.currentTime > 0) saveProgress(cur.key, video.currentTime, video.duration);
    });
    video.addEventListener("ended", function () {
      var cur = P.list[P.idx];
      if (cur) saveProgress(cur.key, video.duration, video.duration);
      syncPlay();
    });
    P.sync = function () { syncPlay(); syncVol(); syncTime(); };
    P.sync();
  }

  function playerError(msg) {
    var p = S.player && S.player.el;
    if (!p) return;
    p.querySelector(".cxe-perr-msg").textContent = msg;
    p.querySelector(".cxe-perr").classList.add("on");
    p.querySelector(".cxe-bigplay").classList.add("hide");
  }

  function streamErrorMessage(code) {
    if (code === 404 || code === 410) return "This lecture's stream was not found (HTTP " + code + "). It may have been removed, or its live link has expired.";
    if (code === 401 || code === 403) return "Access to this stream was denied (HTTP " + code + "). The link may have expired or is restricted.";
    if (code >= 500) return "The stream server is having problems (HTTP " + code + "). Please try again in a moment.";
    if (code) return "This lecture could not be loaded (HTTP " + code + ").";
    return "This lecture could not be played. The stream may be offline, expired, or blocked by the server.";
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
    video.onerror = null;
    video.removeAttribute("src");
    video.load();
    P.sync();

    var saved = readProgress()[lec.key];
    var resumeAt = saved && saved.t > 10 && saved.d && saved.t < saved.d - 10 ? saved.t : 0;
    var started = false;
    function begin() {
      if (started || token !== S.token) return;
      started = true;
      video.playbackRate = Number(P.speed || "1");
      if (resumeAt) { try { video.currentTime = resumeAt; toast("Resumed from " + clock(resumeAt)); } catch (e) {} }
      var pr = video.play();
      if (pr && pr.catch) pr.catch(function () { P.sync(); });
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
        var code = data.response && data.response.code;
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); return; }
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && !code && !recovered) { recovered = true; hls.startLoad(); return; }
        playerError(streamErrorMessage(code));
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.onerror = function () {
        if (token !== S.token) return;
        var e = video.error;
        playerError(e && e.code === 4 ? "This lecture's stream could not be loaded. It may be missing (404), expired or blocked." : streamErrorMessage(0));
      };
      video.addEventListener("loadedmetadata", begin, { once: true });
      video.src = url;
    }
  }

  function renderTools() {
    var P = S.player;
    var lec = P.list[P.idx];
    var box = P.el.querySelector(".cxe-tools");
    var html = "";
    if (P.idx > 0) html += '<button class="btn btn-quiet" type="button" data-act="prev">Previous</button>';
    if (P.idx < P.list.length - 1) html += '<button class="btn btn-primary" type="button" data-act="next">Next lecture</button>';
    lec.pdfs.forEach(function (pdf, i) { html += '<button class="btn btn-quiet" type="button" data-pdf="' + i + '">' + ICON.pdf + esc(pdf.title.length > 28 ? pdf.title.slice(0, 27) + "…" : pdf.title) + '</button>'; });
    box.innerHTML = html;
    box.onclick = function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "prev" && P.idx > 0) { P.idx--; startLecture(); }
      else if (b.dataset.act === "next" && P.idx < P.list.length - 1) { P.idx++; startLecture(); }
      else if (b.dataset.pdf != null) openPdf(lec.pdfs[Number(b.dataset.pdf)]);
    };
  }

  function closePlayer() {
    S.token++;
    destroyHls();
    var fe = document.fullscreenElement || document.webkitFullscreenElement;
    if (fe) { try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {} }
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
    if (!S.view) return;
    var tag = (document.activeElement && document.activeElement.tagName || "").toLowerCase();
    if (e.key === "Escape") {
      if (document.fullscreenElement || document.webkitFullscreenElement) return;
      history.back();
      return;
    }
    if (!S.player || S.pdf || tag === "input" || tag === "select" || tag === "textarea") return;
    var api = S.player.api;
    if (!api) return;
    var k = e.key.toLowerCase();
    if (k === " " || k === "k") { e.preventDefault(); api.toggle(); }
    else if (k === "arrowleft") { e.preventDefault(); api.skip(-10); }
    else if (k === "arrowright") { e.preventDefault(); api.skip(10); }
    else if (k === "m") api.mute();
    else if (k === "f") api.fullscreen();
  });

  function open(batch) {
    if (!batch || !batch._id) return;
    if (S.view) closeAll();
    S.batch = batch;
    ensureView();
    history.pushState({ cxEdu: true, depth: 0, player: false, pdf: false }, "");
    loadCourse();
  }

  window.CXEdustream = {
    open: open,
    // debug(true|"raw"|false): toggles console-only logging of the course-content structure for the next opened course.
    debug: function (on) { try { if (on) localStorage.setItem("cx-edu-debug", on === "raw" ? "raw" : "1"); else localStorage.removeItem("cx-edu-debug"); } catch (e) {} return debugLevel() || "off"; },
    _normalize: normalize,
    _organize: organize,
    _sectionize: sectionize,
    _rowHtml: rowHtml,
    _stats: function () { return stats; },
    _fetchContent: fetchContent
  };
})();
