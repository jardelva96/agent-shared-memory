/** The dashboard shell. */
export function renderDashboardPage(projectName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(projectName)} - Agent Shared Memory</title>
<style>
:root{
  --bg:#0b1020; --panel:#121a2d; --panel-2:#172139; --line:#26324d;
  --text:#e7eaf0; --muted:#9ca6bd; --link:#b9d4ff;
  --ok:#3fb950; --warn:#d29922; --danger:#f85149; --info:#58a6ff; --idle:#6e7681; --accent:#a371f7;
}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg);color:var(--text)}
main{max-width:1400px;margin:0 auto;padding:24px 28px 64px}
h1{margin:0;font-size:22px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:28px 0 12px}
a{color:var(--link)}
header{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.sub{color:var(--muted);font-size:13px;margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--idle)}
.dot.live{background:var(--ok)}
.dot.down{background:var(--danger)}
input[type=search]{background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:8px 12px;font-size:13px;min-width:260px}
input[type=search]:focus{outline:none;border-color:var(--info)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.table-wrap{overflow-x:auto;border-radius:10px}
.table-wrap table{min-width:760px}
@media (max-width:640px){main{padding:16px 16px 48px}input[type=search]{min-width:0;width:100%}}
th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
th{background:var(--panel-2);color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:none}
tr.clash td{background:rgba(248,81,73,.07)}
code{color:var(--link);font-size:12px;word-break:break-word}
.tag{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.03em}
.s-WORKING{background:rgba(210,153,34,.18);color:var(--warn)}
.s-READING{background:rgba(88,166,255,.18);color:var(--info)}
.s-TESTING{background:rgba(163,113,247,.18);color:var(--accent)}
.s-WAITING{background:rgba(248,81,73,.16);color:var(--danger)}
.s-DONE{background:rgba(63,185,80,.16);color:var(--ok)}
.s-ONLINE{background:rgba(63,185,80,.12);color:var(--ok)}
.s-OFFLINE,.s-IDLE{background:rgba(110,118,129,.2);color:var(--idle)}
.banner{border:1px solid rgba(248,81,73,.45);background:rgba(248,81,73,.08);border-radius:10px;padding:12px 14px;margin-top:20px}
.banner strong{color:var(--danger)}
.banner ul{margin:8px 0 0;padding-left:18px;color:var(--muted);font-size:13px}
.banner li{margin:3px 0}
.feed{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line);border-radius:10px}
.feed li{display:flex;gap:10px;align-items:baseline;padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px;flex-wrap:wrap}
.feed li:last-child{border-bottom:none}
.when{color:var(--muted);font-size:11px;min-width:64px}
.who{font-weight:600;min-width:82px}
.empty{color:var(--muted);padding:16px;font-size:13px}
.unread{color:var(--info);font-size:12px;font-weight:600}
.s-MESSAGE,.s-TASK{background:rgba(88,166,255,.18);color:var(--info)}
.s-OPEN{background:rgba(210,153,34,.18);color:var(--warn)}
.s-CLAIMED{background:rgba(163,113,247,.18);color:var(--accent)}
.s-FAILED,.s-CANCELLED{background:rgba(248,81,73,.16);color:var(--danger)}
.s-OBSERVED{background:rgba(110,118,129,.2);color:var(--idle)}
.s-REGISTERED,.s-UNREGISTERED{background:rgba(110,118,129,.2);color:var(--idle)}
.s-INTENT{background:rgba(210,153,34,.18);color:var(--warn)}
.s-CHANGED,.s-CREATED{background:rgba(63,185,80,.16);color:var(--ok)}
.s-FOUND,.s-NOTE{background:rgba(163,113,247,.18);color:var(--accent)}
.muted{color:var(--muted)}
.hint{color:var(--muted);font-size:12px}
</style>
</head>
<body><main>
<header>
  <h1>Agent Shared Memory</h1>
  <span class="pill"><span class="dot" id="conn-dot"></span><span id="conn-text">connecting</span></span>
</header>
<div class="sub">
  <span id="project">${escapeHtml(projectName)}</span>
  <span>&middot;</span>
  <span id="updated">waiting for first update</span>
  <span>&middot;</span>
  <a href="/api/memory">raw shared memory</a>
  <a href="/api/snapshot">json</a>
</div>

<div id="banner"></div>

<h2>Agents</h2>
<div class="sub" style="margin-bottom:10px">
  <input type="search" id="filter" placeholder="Filter by agent, demand, file or symbol" autocomplete="off" />
  <span class="hint" id="filter-hint"></span>
</div>
<div class="table-wrap"><table>
  <thead><tr>
    <th>Agent</th><th>Status</th><th>Demand</th><th>Now</th><th>Pointer</th><th>Waiting</th><th>Updated</th>
  </tr></thead>
  <tbody id="agents"><tr><td colspan="7" class="empty">Waiting for data...</td></tr></tbody>
</table></div>

<h2>Work queue</h2>
<ul class="feed" id="queue"><li class="empty">Waiting for data...</li></ul>

<h2>Reserved files</h2>
<ul class="feed" id="reservations"><li class="empty">Waiting for data...</li></ul>

<h2>Project facts</h2>
<ul class="feed" id="facts"><li class="empty">Waiting for data...</li></ul>

<h2>Recent activity</h2>
<ul class="feed" id="feed"><li class="empty">Waiting for data...</li></ul>
</main>
<script>
(function () {
  var snapshot = null;
  var filter = '';

  var connDot = document.getElementById('conn-dot');
  var connText = document.getElementById('conn-text');
  var filterInput = document.getElementById('filter');

  filterInput.addEventListener('input', function () {
    filter = filterInput.value.trim().toLowerCase();
    render();
  });

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function ago(iso) {
    var seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return seconds + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  function clock(iso) {
    var d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0');
  }

  function matches(haystack) {
    if (!filter) return true;
    return haystack.join(' ').toLowerCase().indexOf(filter) >= 0;
  }

  function renderBanner() {
    var host = document.getElementById('banner');
    host.textContent = '';
    if (!snapshot || snapshot.overlaps.length === 0) return;

    var box = el('div', 'banner');
    box.appendChild(el('strong', null, snapshot.overlaps.length + ' active overlap(s)'));
    box.appendChild(document.createTextNode(' \\u2014 shared awareness, not a lock. Coordinate before editing.'));
    var list = el('ul');
    snapshot.overlaps.forEach(function (pair) {
      var item = el('li');
      item.appendChild(el('strong', null, pair.agents[0] + ' \\u2194 ' + pair.agents[1]));
      item.appendChild(document.createTextNode(' \\u00b7 ' + (pair.exact ? 'EXACT' : 'RELATED') + ' \\u00b7 '));
      item.appendChild(el('code', null, pair.pointers[0].file +
        (pair.pointers[0].symbol ? ' -> ' + pair.pointers[0].symbol : '')));
      list.appendChild(item);
    });
    box.appendChild(list);
    host.appendChild(box);
  }

  function renderAgents() {
    var body = document.getElementById('agents');
    body.textContent = '';
    if (!snapshot) return;

    var rows = snapshot.agents.filter(function (a) {
      return matches([a.id, a.role || '', a.task || '', a.description, a.pointer]);
    });

    document.getElementById('filter-hint').textContent =
      filter ? rows.length + ' of ' + snapshot.agents.length + ' agents' : '';

    if (rows.length === 0) {
      var empty = el('tr');
      var cell = el('td', 'empty', snapshot.agents.length === 0 ? 'No agents registered.' : 'No agent matches the filter.');
      cell.colSpan = 7;
      empty.appendChild(cell);
      body.appendChild(empty);
      return;
    }

    rows.forEach(function (agent) {
      var tr = el('tr', agent.overlapsWith.length > 0 ? 'clash' : null);

      var first = el('td');
      first.appendChild(el('strong', null, agent.id));
      if (agent.role) first.appendChild(el('div', 'muted', agent.role));
      if (agent.overlapsWith.length > 0) {
        first.appendChild(el('div', 'muted', 'overlaps: ' + agent.overlapsWith.join(', ')));
      }
      if (agent.unread > 0) {
        first.appendChild(el('div', 'unread', agent.unread + ' unread message(s)'));
      }
      tr.appendChild(first);

      var statusCell = el('td');
      statusCell.appendChild(el('span', 'tag s-' + agent.status, agent.status));
      tr.appendChild(statusCell);

      tr.appendChild(el('td', null, agent.task || '-'));

      var now = el('td');
      now.appendChild(el('div', null, agent.description));
      if (agent.reason) now.appendChild(el('div', 'muted', 'why: ' + agent.reason));
      tr.appendChild(now);

      var pointer = el('td');
      pointer.appendChild(el('code', null, agent.pointer));
      tr.appendChild(pointer);

      tr.appendChild(el('td', null, agent.waitingFor || '-'));
      tr.appendChild(el('td', 'muted', ago(agent.updatedAt)));
      body.appendChild(tr);
    });
  }

  function renderQueue() {
    var host = document.getElementById('queue');
    host.textContent = '';
    if (!snapshot) return;

    var tasks = (snapshot.tasks || []).filter(function (t) {
      return matches([t.id, t.title, t.createdBy, t.owner, t.pointer]);
    });

    if (tasks.length === 0) {
      host.appendChild(el('li', 'empty', 'No open work.'));
      return;
    }

    tasks.forEach(function (task) {
      var item = el('li');
      item.appendChild(el('span', 'when', task.id));
      item.appendChild(el('span', 'tag s-' + task.status, task.status));
      item.appendChild(el('span', null, task.title));
      if (task.owner) item.appendChild(el('span', 'muted', task.owner));
      item.appendChild(el('span', 'muted', 'by ' + task.createdBy));
      if (task.depth > 0) item.appendChild(el('span', 'muted', 'depth ' + task.depth));
      if (task.pointer && task.pointer !== '-') item.appendChild(el('code', null, task.pointer));
      host.appendChild(item);
    });
  }

  function renderReservations() {
    var host = document.getElementById('reservations');
    host.textContent = '';
    if (!snapshot) return;
    var held = (snapshot.reservations || []).filter(function (r) {
      return matches([r.pattern, r.agentId, r.reason]);
    });
    if (held.length === 0) {
      host.appendChild(el('li', 'empty', 'No files reserved.'));
      return;
    }
    held.forEach(function (r) {
      var item = el('li');
      item.appendChild(el('code', null, r.pattern));
      item.appendChild(el('span', 'who', r.agentId));
      item.appendChild(el('span', 'tag', r.exclusive ? 'exclusive' : 'shared'));
      item.appendChild(el('span', 'muted', 'until ' + clock(r.expiresAt)));
      if (r.reason) item.appendChild(el('span', null, r.reason));
      host.appendChild(item);
    });
  }

  function renderFacts() {
    var host = document.getElementById('facts');
    host.textContent = '';
    if (!snapshot) return;
    var facts = snapshot.facts || [];
    if (facts.length === 0) {
      host.appendChild(el('li', 'empty', 'No project facts yet.'));
      return;
    }
    facts.forEach(function (f) {
      host.appendChild(el('li', null, f.text));
    });
  }

  function renderFeed() {
    var feed = document.getElementById('feed');
    feed.textContent = '';
    if (!snapshot) return;

    var events = snapshot.events.filter(function (e) {
      return matches([e.agentId, e.type, e.description, e.pointer]);
    });

    if (events.length === 0) {
      feed.appendChild(el('li', 'empty', 'No activity yet.'));
      return;
    }

    events.forEach(function (event) {
      var item = el('li');
      item.appendChild(el('span', 'when', clock(event.timestamp)));
      item.appendChild(el('span', 'who', event.agentId));
      item.appendChild(el('span', 'tag s-' + event.type, event.type));
      item.appendChild(el('span', null, event.description));
      if (event.pointer && event.pointer !== '-') {
        item.appendChild(el('code', null, event.pointer));
      }
      feed.appendChild(item);
    });
  }

  function render() {
    if (!snapshot) return;
    document.getElementById('project').textContent = snapshot.project;
    document.getElementById('updated').textContent = 'updated ' + ago(snapshot.generatedAt);
    document.title = snapshot.project + ' - Agent Shared Memory';
    renderBanner();
    renderAgents();
    renderQueue();
    renderReservations();
    renderFacts();
    renderFeed();
  }

  function connection(live, text) {
    connDot.className = 'dot ' + (live ? 'live' : 'down');
    connText.textContent = text;
  }

  var source = new EventSource('/events');
  source.addEventListener('open', function () { connection(true, 'live'); });
  source.addEventListener('error', function () { connection(false, 'reconnecting'); });
  source.addEventListener('message', function (event) {
    snapshot = JSON.parse(event.data);
    connection(true, 'live');
    render();
  });

  // Refresh the relative timestamps between pushes.
  setInterval(render, 1000);
})();
</script>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[char] ?? char);
}
