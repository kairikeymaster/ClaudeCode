//LOCAL JAVASCRIPT FILE ON GAIA-PRIME IS OUT-OF-DATE BY DEFAULT; UP-TO-DATE VERSION IS ON CLOUDFLARE
const ALLOWED_ORIGIN = '*';

//secrets in env (API keys/client secrets) are defined at https://dash.cloudflare.com/771ad0cb4551c1bd907f406f9d65be58/workers/services/view/clover-backend/production/settings#variables
import { env } from "cloudflare:workers";

const ANTHROPIC_KEY = env.ANTHROPIC_KEY;
const OPENAI_KEY = env.OPENAI_KEY;
const ELEVENLABS_KEY = env.ELEVENLABS_KEY;
const GITHUB_KEY = env.GITHUB_KEY;
const OBSIDIAN_KEY = env.OBSIDIAN_KEY; //note: this is specifically the key for the Local REST API plugin; works for HTTP and HTTPS
const TICKTICK_TOKEN = env.TICKTICK_TOKEN;
const TICKTICK_CLIENT_ID = env.TICKTICK_CLIENT_ID;
const TICKTICK_CLIENT_SECRET = env.TICKTICK_CLIENT_SECRET;

const OBSIDIAN_URL = 'https://obsidian.annasedlacek.com';
const TICKTICK_PROJECTS = {
  INBOX:    'inbox113737974',
  TK:       '6a052e798a76f5418c5e8e04',  // Tasks — real commitments
  BK:       '6a080b618a76f5418c5e969d',  // Blockers — no due date, must happen soon
  FM:       '6a052e858a76f5418c5e8e1e',  // Force-Multipliers — optional but high-leverage
  GH:       '6a0288b4ebcdfa000000059b',  // Good Habits — recurring/routine
  PL:       '6a028782ebcdfa00000004fd',  // Planning — fetched only in Planning Mode
  FT:       '64c32fff2874c8ee865fe138',  // Family Tasks — read-only for execution
};

const TRIAGE_SCHEMA = {
  // Human-readable nickname → API ID for the project the task belongs to.
  projects: {
    'IN': TICKTICK_PROJECTS.INBOX,
    'TK': TICKTICK_PROJECTS.TK,
    'BK': TICKTICK_PROJECTS.BK,
    'FM': TICKTICK_PROJECTS.FM,
    'GH': TICKTICK_PROJECTS.GH,
    'PL': TICKTICK_PROJECTS.PL,
    'FT': TICKTICK_PROJECTS.FT,
  },
  // Human-readable tag → API tag string.
  tags: {
    'HE':  'he',   // high energy
    'LCL': 'lcl',  // low cognitive load
    'HCL': 'hcl',  // high cognitive load
    'd0':  'd0',   // can't start until day of due date
    'd1':  'd1',   // can't start until day before due date
  },
  // Priority nickname → TickTick numeric priority.
  priority: { 'p0': 0, 'p1': 1, 'p3': 3, 'p5': 5 },
  // Obsidian folder names — unchanged from before.
  obsidian: { capture: 'CAPTURE', archive: '_archive' },
};

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return cors();
    }

    const url = new URL(request.url);
    const path = url.pathname;



// ── Waterfall helper ─────────────────────────────────────────────────────────
// Computes the 9-step priority waterfall over a flat list of tasks.
// Returns: array of { stepIndex, label, tasks } objects, one per non-empty bucket, in order.
function computeWaterfall(allTasks) {
  const PACIFIC = 'America/Los_Angeles';
  const oneDayMs = 24 * 60 * 60 * 1000;
  const localDateKey = (d, tz = PACIFIC) => d.toLocaleDateString('en-CA', { timeZone: tz });
  const todayKey = localDateKey(new Date());
  const todayAnchor = new Date(todayKey + 'T12:00:00Z');
  const dayKeyOffset = (days) => localDateKey(new Date(todayAnchor.getTime() + days * oneDayMs));

  const dueDateKey = (t) => {
    if (!t.dueDate) return null;
    const d = new Date(t.dueDate);
    if (t.isAllDay) return localDateKey(new Date(d.getTime() - 1000));
    return localDateKey(d);
  };
  const projOf = (t) => t.projectId;
  const isTK = (t) => projOf(t) === TICKTICK_PROJECTS.TK;
  const isFT = (t) => projOf(t) === TICKTICK_PROJECTS.FT;
  const isBK = (t) => projOf(t) === TICKTICK_PROJECTS.BK;
  const isFM = (t) => projOf(t) === TICKTICK_PROJECTS.FM;
  const isGH = (t) => projOf(t) === TICKTICK_PROJECTS.GH;
  const hasTag = (t, tag) => Array.isArray(t.tags) && t.tags.includes(tag);
  const prio = (t) => t.priority || 0;
  const isOverdue = (t) => { const k = dueDateKey(t); return k !== null && k < todayKey; };
  const isDueToday = (t) => dueDateKey(t) === todayKey;
  const isDueTomorrow = (t) => dueDateKey(t) === dayKeyOffset(1);
  const isDueWithin = (t, days) => {
    const k = dueDateKey(t);
    if (k === null) return null;
    if (k < todayKey) return false;
    for (let i = 0; i <= days; i++) if (k === dayKeyOffset(i)) return true;
    return false;
  };

  const tiebreak = (a, b) => {
    const ak = dueDateKey(a), bk = dueDateKey(b);
    if (ak !== null && bk !== null) return ak < bk ? -1 : ak > bk ? 1 : 0;
    if (ak !== null) return -1;
    if (bk !== null) return 1;
    return (new Date(a.createdTime || 0)) - (new Date(b.createdTime || 0));
  };
  const byPrioThenTie = (arr) => arr.slice().sort((a, b) => prio(b) - prio(a) || tiebreak(a, b));
  const byDueThenPrio = (arr) => arr.slice().sort((a, b) => tiebreak(a, b) || prio(b) - prio(a));

  const steps = [
    { label: '1. Overdue Tasks/Family Tasks', test: (t) => (isTK(t) || isFT(t)) && isOverdue(t), sort: byDueThenPrio },
    { label: '2. Due today: Tasks/Family Tasks/Good Habits', test: (t) => (isTK(t) || isFT(t) || isGH(t)) && isDueToday(t), sort: byPrioThenTie },
    { label: '3. Blockers p5', test: (t) => isBK(t) && prio(t) === 5, sort: byPrioThenTie },
    { label: '4. Tasks #d1 due tomorrow', test: (t) => isTK(t) && hasTag(t, 'd1') && isDueTomorrow(t), sort: byPrioThenTie },
    { label: '5. Blockers p3', test: (t) => isBK(t) && prio(t) === 3, sort: byPrioThenTie },
    { label: '6. Force-Multipliers p5/p3', test: (t) => isFM(t) && (prio(t) === 5 || prio(t) === 3), sort: byPrioThenTie },
    { label: '7. Tasks/Family Tasks p5/p3 within 5d (excl. d0/d1)', test: (t) => (isTK(t) || isFT(t)) && (prio(t) === 5 || prio(t) === 3) && !hasTag(t, 'd0') && !hasTag(t, 'd1') && isDueWithin(t, 5) && !isDueToday(t), sort: byDueThenPrio },
    { label: '8. Tasks (catch-all, excl. d0/d1)', test: (t) => isTK(t) && !hasTag(t, 'd0') && !hasTag(t, 'd1'), sort: byPrioThenTie },
    { label: '9. Force-Multipliers (catch-all)', test: (t) => isFM(t), sort: byPrioThenTie },
  ];

  const seen = new Set();
  const buckets = [];
  for (let i = 0; i < steps.length; i++) {
    const matched = allTasks.filter(t => !seen.has(t.id) && steps[i].test(t));
    if (matched.length === 0) continue;
    const sorted = steps[i].sort(matched);
    for (const t of sorted) seen.add(t.id);
    buckets.push({ stepIndex: i + 1, label: steps[i].label, tasks: sorted });
  }
  return buckets;
}




if (path === '/anthropic' && request.method === 'POST') {
  try {
    const body = await request.json();
    // Auto-enable prompt caching for large system prompts (saves input tokens on repeated calls).
    // Wraps a system string into a content block array marked for ephemeral caching.
    if (typeof body.system === 'string' && body.system.length > 5000) {
      body.system = [
        { type: 'text', text: body.system, cache_control: { type: 'ephemeral' } }
      ];
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    return respond(data);
  } catch(e) {
    return respond({ error: e.message }, 500);
  }
}

    if (path === '/gist' && request.method === 'GET') {
      try {
        const id = url.searchParams.get('id');
        const r = await fetch(`https://gist.githubusercontent.com/kairikeymaster/${id}/raw`);
        const text = await r.text();
        return new Response(text, {
          headers: {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN
          }
        });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/elevenlabs' && request.method === 'POST') {
      try {
        const body = await request.json();
        const voiceId = body.voiceId || 'Rachel';
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_KEY
          },
          body: JSON.stringify({ text: body.text, model_id: 'eleven_monolingual_v1' })
        });
        const audio = await r.arrayBuffer();
        return new Response(audio, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN
          }
        });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }


    if (path === '/openai-tts' && request.method === 'POST') {
      try {
        const { text, voice } = await request.json();
        const r = await fetch('https://api.openai.com/v1/audio/speech', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_KEY}`
          },
          body: JSON.stringify({ model: 'tts-1', voice: voice || 'echo', input: text })
        });
        if (!r.ok) {
          const errText = await r.text();
          return respond({ error: `OpenAI TTS ${r.status}: ${errText}` }, 500);
        }
        return new Response(r.body, {
          headers: {
            'Content-Type': 'audio/mpeg',
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN
          }
        });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/whoami' && request.method === 'GET') {
      return new Response(JSON.stringify({
        openai_key_prefix: OPENAI_KEY?.slice(0, 12),
        openai_key_suffix: OPENAI_KEY?.slice(-6),
        openai_key_length: OPENAI_KEY?.length
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    
    if (path === '/feedback' && request.method === 'POST') {
      try {
        const { id, filename, content } = await request.json();
        const r = await fetch(`https://api.github.com/gists/${id}`, {
          method: 'PATCH',
          headers: {
            Authorization: `token ${GITHUB_KEY}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Clover-Backend'
          },
          body: JSON.stringify({ files: { [filename]: { content } } })
        });
        const data = await r.json();
        return respond({ ok: r.ok, data });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }


    if (path === '/append-feedback' && request.method === 'POST') {
  try {
    const { feedback } = await request.json();
    const FEEDBACK_GIST_ID = 'de9628558a0af0334318eb3a4bd53f93';
    
    // Fetch current content via authenticated API
    const currentRes = await fetch(`https://api.github.com/gists/${FEEDBACK_GIST_ID}`, {
      headers: {
        'Authorization': `token ${GITHUB_KEY}`,
        'User-Agent': 'Clover-Backend',
        'Accept': 'application/vnd.github+json'
      }
    });
    
    if (!currentRes.ok) {
      const errBody = await currentRes.text();
      return respond({ ok: false, step: 'fetch', status: currentRes.status, details: errBody }, 500);
    }
    
    const gistData = await currentRes.json();
    const currentContent = gistData.files?.['feedback.md']?.content || '';
    
    const updatedContent = currentContent + `\n- ${feedback}`;
    
    const patchRes = await fetch(`https://api.github.com/gists/${FEEDBACK_GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GITHUB_KEY}`,
        'User-Agent': 'Clover-Backend',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json'
      },
      body: JSON.stringify({ files: { 'feedback.md': { content: updatedContent } } })
    });
    
    if (!patchRes.ok) {
      const errBody = await patchRes.text();
      return respond({ ok: false, step: 'patch', status: patchRes.status, details: errBody }, 500);
    }
    
    return respond({ ok: true, appended: feedback });
  } catch(e) {
    return respond({ error: e.message }, 500);
  }
}

    // Append one JSONL line to the corrections-log gist. Body: { record: {...} }.
    // record is logged verbatim (already shaped on the client) so the schema lives in one place: the HTML.
    // Pre-call webhook for ElevenLabs Conversation Initiation.
    // ElevenLabs calls this at the start of every conversation; we fetch the live context
    // gist and return it as the {{CONTEXT}} dynamic variable, so edits to the gist
    // propagate to the next conversation automatically (no re-pasting needed).
    //
    // NOTE: The exact response shape ElevenLabs expects may need a small tweak after
    // testing. If the agent reports "{{CONTEXT}} unresolved" or similar, check what
    // shape their dashboard validates against and adjust the JSON keys here.
    if (path === '/clover-init' && (request.method === 'POST' || request.method === 'GET')) {
      try {
        const CONTEXT_GIST_ID = 'd5a46abda4e74f893c3801c2445197e8';
        const r = await fetch(`https://gist.githubusercontent.com/kairikeymaster/${CONTEXT_GIST_ID}/raw`);
        if (!r.ok) {
          return respond({ ok: false, step: 'fetch-gist', status: r.status }, 500);
        }
        const contextText = await r.text();
        return respond({
          dynamic_variables: { CONTEXT: contextText }
        });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/append-correction' && request.method === 'POST') {
      try {
        const { record } = await request.json();
        const CORRECTIONS_GIST_ID = 'b3f1560bac6c82c5407bea764385bf56';  // create a new gist with file `corrections.jsonl`
        const FILENAME = 'corrections.jsonl';

        const currentRes = await fetch(`https://api.github.com/gists/${CORRECTIONS_GIST_ID}`, {
          headers: { 'Authorization': `token ${GITHUB_KEY}`, 'User-Agent': 'Clover-Backend', 'Accept': 'application/vnd.github+json' }
        });
        if (!currentRes.ok) {
          const errBody = await currentRes.text();
          return respond({ ok: false, step: 'fetch', status: currentRes.status, details: errBody }, 500);
        }
        const gistData = await currentRes.json();
        const currentContent = gistData.files?.[FILENAME]?.content || '';
        const updatedContent = currentContent + JSON.stringify(record) + '\n';

        const patchRes = await fetch(`https://api.github.com/gists/${CORRECTIONS_GIST_ID}`, {
          method: 'PATCH',
          headers: { 'Authorization': `token ${GITHUB_KEY}`, 'User-Agent': 'Clover-Backend', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: { [FILENAME]: { content: updatedContent } } })
        });
        if (!patchRes.ok) {
          const errBody = await patchRes.text();
          return respond({ ok: false, step: 'patch', status: patchRes.status, details: errBody }, 500);
        }
        return respond({ ok: true });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    // Same pattern, different gist — for items where Anna deleted Clover's flag entirely (rejections).
    if (path === '/append-rejection' && request.method === 'POST') {
      try {
        const { record } = await request.json();
        const REJECTIONS_GIST_ID = 'f84db4fa647c69f3a90d51a012d4e2cc';  // create a new gist with file `rejections.jsonl`
        const FILENAME = 'rejections.jsonl';

        const currentRes = await fetch(`https://api.github.com/gists/${REJECTIONS_GIST_ID}`, {
          headers: { 'Authorization': `token ${GITHUB_KEY}`, 'User-Agent': 'Clover-Backend', 'Accept': 'application/vnd.github+json' }
        });
        if (!currentRes.ok) {
          const errBody = await currentRes.text();
          return respond({ ok: false, step: 'fetch', status: currentRes.status, details: errBody }, 500);
        }
        const gistData = await currentRes.json();
        const currentContent = gistData.files?.[FILENAME]?.content || '';
        const updatedContent = currentContent + JSON.stringify(record) + '\n';

        const patchRes = await fetch(`https://api.github.com/gists/${REJECTIONS_GIST_ID}`, {
          method: 'PATCH',
          headers: { 'Authorization': `token ${GITHUB_KEY}`, 'User-Agent': 'Clover-Backend', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ files: { [FILENAME]: { content: updatedContent } } })
        });
        if (!patchRes.ok) {
          const errBody = await patchRes.text();
          return respond({ ok: false, step: 'patch', status: patchRes.status, details: errBody }, 500);
        }
        return respond({ ok: true });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/ticktick/auth' && request.method === 'GET') {
      const authUrl = `https://ticktick.com/oauth/authorize?client_id=${TICKTICK_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent('https://clover-backend.kairikeymaster.workers.dev/ticktick/callback')}&scope=tasks:read tasks:write`;
      return Response.redirect(authUrl, 302);
    }

    if (path === '/ticktick/callback' && request.method === 'GET') {
      try {
        const code = url.searchParams.get('code');
        const credentials = btoa(`${TICKTICK_CLIENT_ID}:${TICKTICK_CLIENT_SECRET}`);
        const r = await fetch('https://ticktick.com/oauth/token', {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: `code=${code}&grant_type=authorization_code&redirect_uri=${encodeURIComponent('https://clover-backend.kairikeymaster.workers.dev/ticktick/callback')}`
        });
        const data = await r.json();
        return respond(data);
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }
    
if (path === '/ticktick/tasks' && request.method === 'GET') {
      try {
        const projectId = url.searchParams.get('projectId');
        const r = await fetch(`https://api.ticktick.com/open/v1/project/${projectId}/tasks`, {
          headers: { Authorization: `Bearer ${TICKTICK_TOKEN}` }
        });
        const text = await r.text();
        return new Response(text, {
          headers: {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': ALLOWED_ORIGIN
          }
        });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    // Returns the next task to work on, plus the rest of the ordered list (capped).
    // The Worker applies the priority waterfall in code so Clover doesn't have to.
    //
    // Query params:
    //   mode=execution (default) — applies the full waterfall, excludes Planning project
    //   mode=planning             — returns only the Planning project's open tasks
    //   limit=N (default 20)      — cap on returned task count
    if (path === '/ticktick/next-tasks' && request.method === 'GET') {
      try {
        const mode = url.searchParams.get('mode') || 'execution';
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);

        // Fetch open tasks from every project we care about, in parallel.
        // Planning mode fetches ONLY Planning; execution mode fetches everything except Planning.
        const projectsToFetch = mode === 'planning'
          ? [TICKTICK_PROJECTS.PL]
          : Object.values(TICKTICK_PROJECTS).filter(id => id !== TICKTICK_PROJECTS.PL);

        const results = await Promise.all(projectsToFetch.map(id =>
          fetch(`https://api.ticktick.com/open/v1/project/${id}/data`, {
            headers: { Authorization: `Bearer ${TICKTICK_TOKEN}` }
          }).then(r => r.json())
        ));

        const allTasks = results.flatMap(r => (r.tasks || []).filter(t => t.status === 0));
        // TickTick returns subtasks (items) in arbitrary order; their actual UI order lives in the sortOrder field.
        // Sort each task's items in place so Clover reads them in the same order Anna sees them in the app.
        for (const t of allTasks) {
          if (Array.isArray(t.items)) {
            t.items.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
          }
        }

        // Pre-format due dates in Anna's local timezone so the voice agent doesn't have to.
        // Uses Intl with the task's stored timezone, which handles DST automatically.
        for (const t of allTasks) {
          if (t.dueDate) {
            const tz = t.timeZone || 'America/Los_Angeles';
            // All-day tasks are stored as 00:00 of the NEXT day in UTC. Subtract 1s so the
            // displayed date reflects the day Anna actually has in mind.
            const d = new Date(new Date(t.dueDate).getTime() - (t.isAllDay ? 1000 : 0));
            t.dueDateLocal = t.isAllDay
              ? d.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
              : d.toLocaleString('en-US', {
                  timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
                  hour: 'numeric', minute: '2-digit', hour12: true
                });
          }
        }

        // Planning mode: simple return, no waterfall.
        if (mode === 'planning') {
          return respond({ mode, count: allTasks.length, tasks: allTasks.slice(0, limit) });
        }

        // ── Waterfall — execution mode ──
        // All date comparisons are made on calendar dates in Anna's local timezone (Pacific),
        // NOT in UTC. Using Intl with the task's stored timezone handles DST automatically,
        // so we never hardcode -7 or -8.
        const PACIFIC = 'America/Los_Angeles';
        const oneDayMs = 24 * 60 * 60 * 1000;

        // Convert any Date/timestamp into a YYYY-MM-DD string as it appears in the given timezone.
        // Two dates that fall on the same calendar day in Pacific will produce the same key.
        const localDateKey = (d, tz = PACIFIC) =>
          d.toLocaleDateString('en-CA', { timeZone: tz });  // en-CA gives YYYY-MM-DD format

        // Today's key in Pacific, computed once per request.
        const todayKey = localDateKey(new Date());

        // For comparing "is the due date N days away?", we need today as a YYYY-MM-DD anchor we can shift.
        // Easiest: parse todayKey back to a Date at noon UTC (avoids edge cases at midnight)
        // and add/subtract days from there to get target keys.
        const todayAnchor = new Date(todayKey + 'T12:00:00Z');
        const dayKeyOffset = (days) => localDateKey(new Date(todayAnchor.getTime() + days * oneDayMs));

        // Returns the YYYY-MM-DD key the task is due on in Pacific, or null if no due date.
        // All-day tasks in TickTick are stored as midnight-of-the-following-day-UTC, so we
        // subtract one second before computing the local key to get the intended date.
        const dueDateKey = (t) => {
          if (!t.dueDate) return null;
          const d = new Date(t.dueDate);
          if (t.isAllDay) {
            return localDateKey(new Date(d.getTime() - 1000));
          }
          return localDateKey(d);
        };

        // Predicates — each checks project membership + tag/priority/due-date conditions.
        const projOf = (t) => t.projectId;
        const isTK = (t) => projOf(t) === TICKTICK_PROJECTS.TK;
        const isFT = (t) => projOf(t) === TICKTICK_PROJECTS.FT;
        const isBK = (t) => projOf(t) === TICKTICK_PROJECTS.BK;
        const isFM = (t) => projOf(t) === TICKTICK_PROJECTS.FM;
        const isGH = (t) => projOf(t) === TICKTICK_PROJECTS.GH;
        const hasTag = (t, tag) => Array.isArray(t.tags) && t.tags.includes(tag);
        const prio = (t) => t.priority || 0;
        const isOverdue = (t) => { const k = dueDateKey(t); return k !== null && k < todayKey; };
        const isDueToday = (t) => dueDateKey(t) === todayKey;
        const isDueTomorrow = (t) => dueDateKey(t) === dayKeyOffset(1);
        const isDueWithin = (t, days) => {
          const k = dueDateKey(t);
          if (k === null) return null;
          if (k < todayKey) return false;
          for (let i = 0; i <= days; i++) if (k === dayKeyOffset(i)) return true;
          return false;
        };

        // Tiebreaker: oldest due date first; if no due date, earliest createdTime first.
        const tiebreak = (a, b) => {
          const ak = dueDateKey(a), bk = dueDateKey(b);
          if (ak !== null && bk !== null) return ak < bk ? -1 : ak > bk ? 1 : 0;
          if (ak !== null) return -1;
          if (bk !== null) return 1;
          return (new Date(a.createdTime || 0)) - (new Date(b.createdTime || 0));
        };

        // Each waterfall step is a function that returns the subset matching that step's conditions,
        // sorted by (priority desc, then tiebreak). Steps are evaluated in order; first non-empty wins.
        // Within the chosen step, the full sorted list is used. Other steps fill the rest of the cap.
        const byPrioThenTie = (arr) => arr.slice().sort((a, b) => prio(b) - prio(a) || tiebreak(a, b));
        const byDueThenPrio = (arr) => arr.slice().sort((a, b) => tiebreak(a, b) || prio(b) - prio(a));

        const steps = [
          // 1. Overdue Tasks or Family Tasks — highest priority first.
          (t) => (isTK(t) || isFT(t)) && isOverdue(t),
          // 2. Tasks, Family Tasks, or Good Habits due today.
          (t) => (isTK(t) || isFT(t) || isGH(t)) && isDueToday(t),
          // 3. Blockers with p5.
          (t) => isBK(t) && prio(t) === 5,
          // 4. Tasks tagged #d1 due tomorrow.
          (t) => isTK(t) && hasTag(t, 'd1') && isDueTomorrow(t),
          // 5. Blockers with p3.
          (t) => isBK(t) && prio(t) === 3,
          // 6. Force-Multipliers with p5 or p3.
          (t) => isFM(t) && (prio(t) === 5 || prio(t) === 3),
          // 7. Tasks/Family Tasks p5/p3 NOT tagged d0/d1, due within 5 days (and not today — that was step 2).
          (t) => (isTK(t) || isFT(t)) && (prio(t) === 5 || prio(t) === 3) && !hasTag(t, 'd0') && !hasTag(t, 'd1') && isDueWithin(t, 5) && !isDueToday(t),
          // 8. Tasks NOT tagged d0/d1 (any priority, any date or none).
          (t) => isTK(t) && !hasTag(t, 'd0') && !hasTag(t, 'd1'),
          // 9. Force-Multipliers (catch-all).
          (t) => isFM(t),
        ];

        // Build ordered list: for each step, take everything matching that step, sorted appropriately,
        // and append to the output. Skip duplicates (a task that matched an earlier step won't be repeated).
        const seen = new Set();
        const ordered = [];
        for (let i = 0; i < steps.length; i++) {
          const matched = allTasks.filter(t => !seen.has(t.id) && steps[i](t));
          // Steps 1 and 7 sort by due date first; the rest sort by priority first.
          const sorted = (i === 0 || i === 6) ? byDueThenPrio(matched) : byPrioThenTie(matched);
          for (const t of sorted) {
            seen.add(t.id);
            ordered.push(t);
          }
        }

        return respond({
          mode,
          count: ordered.length,
          tasks: ordered.slice(0, limit),
        });
      } catch(e) {
        return respond({ error: e.message, stack: e.stack }, 500);
      }
    }

    // Legacy route — kept for backwards compatibility with the HTML's fetchTasks().
    // Returns ALL open tasks unsorted. Phase out once the HTML is migrated.
    if (path === '/ticktick/alltasks' && request.method === 'GET') {
      try {
        const projectIds = Object.values(TICKTICK_PROJECTS);
        const results = await Promise.all(projectIds.map(id =>
          fetch(`https://api.ticktick.com/open/v1/project/${id}/data`, {
            headers: { Authorization: `Bearer ${TICKTICK_TOKEN}` }
          }).then(r => r.json())
        ));
        const tasks = results.flatMap(r => (r.tasks || []).filter(t => t.status === 0));
        return respond(tasks);
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/ticktick/create' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { title, content, dueDate } = body;
        if (!title) return respond({ error: 'title is required' }, 400);

        // Human-readable inputs → API values via TRIAGE_SCHEMA (single source of truth).
        // Defaults: project=TK ("Tasks"), priority=p0, no tags.
        // Inbox is explicitly disallowed as a target (per the context doc: "do NOT add new tasks here").
        const projectKey  = body.project  || 'TK';
        const priorityKey = body.priority || 'p0';
        const tagKeys     = Array.isArray(body.tags) ? body.tags : [];

        if (projectKey === 'IN') return respond({ error: 'cannot create tasks in Inbox — pick a real project' }, 400);
        if (projectKey === 'FT') return respond({ error: 'Family Tasks is read-only — pick a different project' }, 400);

        const projectId = TRIAGE_SCHEMA.projects[projectKey];
        const priority  = TRIAGE_SCHEMA.priority[priorityKey];
        const apiTags   = tagKeys.map(k => TRIAGE_SCHEMA.tags[k]);

        // Surface bad inputs explicitly rather than silently defaulting, so voice mishears are visible.
        if (projectId === undefined) return respond({ error: `unknown project "${projectKey}" — expected one of ${Object.keys(TRIAGE_SCHEMA.projects).filter(k => k !== 'IN' && k !== 'FT').join(', ')}` }, 400);
        if (priority === undefined)  return respond({ error: `unknown priority "${priorityKey}" — expected one of ${Object.keys(TRIAGE_SCHEMA.priority).join(', ')}` }, 400);
        const badTagIdx = apiTags.findIndex(t => t === undefined);
        if (badTagIdx !== -1) return respond({ error: `unknown tag "${tagKeys[badTagIdx]}" — expected one of ${Object.keys(TRIAGE_SCHEMA.tags).join(', ')}` }, 400);

        const taskBody = { title, content: content || '', priority, projectId, tags: apiTags };
        if (dueDate) taskBody.dueDate = dueDate;  // Pass through if Clover supplied one (ISO 8601).

        const taskRes = await fetch('https://api.ticktick.com/open/v1/task', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${TICKTICK_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(taskBody)
        });
        const taskData = await taskRes.json();
        if (!taskRes.ok) return respond({ error: 'TickTick rejected the task', status: taskRes.status, detail: taskData }, 502);

        return respond({ ok: true, created: { title, project: projectKey, priority: priorityKey, tags: tagKeys, dueDate: dueDate || null }, task: taskData });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/ticktick/projects' && request.method === 'GET') {
      try {
        const r = await fetch('https://api.ticktick.com/open/v1/project', {
          headers: { Authorization: `Bearer ${TICKTICK_TOKEN}` }
        });
        const data = await r.json();
        return respond(data);
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/vapi' && request.method === 'POST') {
      try {
        const body = await request.json();
        const messages = body.messages || [];
        const system = messages.find(m => m.role === 'system')?.content || '';
        const convo = messages.filter(m => m.role !== 'system');
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 200,
            system: system,
            messages: convo
          })
        });
        const data = await r.json();
        const text = data.content?.[0]?.text || '';
        const openaiResponse = {
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'claude-sonnet-4-5',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: data.usage?.input_tokens || 0,
            completion_tokens: data.usage?.output_tokens || 0,
            total_tokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0)
          }
        };
        return respond(openaiResponse);
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    
    if (path === '/system-prompt' && (request.method === 'GET' || request.method === 'POST')) {
  try {
    const body = request.method === 'POST' ? (await request.json().catch(()=>({}))) : {};
    const req_time = body.clientTime || null;
    const req_voice = body.voiceMode || false;
    const now = new Date();
    const [context, parts, ...projectData] = await Promise.all([
      fetch(`https://gist.githubusercontent.com/kairikeymaster/d5a46abda4e74f893c3801c2445197e8/raw`).then(r => r.text()),
      fetch(`https://gist.githubusercontent.com/kairikeymaster/37447f4e736f888a718a9e2f0d96c9d6/raw`).then(r => r.text()),
      ...Object.values(TICKTICK_PROJECTS).map(id =>
        fetch(`https://api.ticktick.com/open/v1/project/${id}/data`, { headers: { Authorization: `Bearer ${TICKTICK_TOKEN}` } }).then(r => r.json())
      ),
    ]);
    const allTasks = projectData.flatMap(r => (r.tasks || []).filter(t => t.status === 0));

    // Format due dates locally (so Claude doesn't have to parse them).
    for (const t of allTasks) {
      if (t.dueDate) {
        const tz = t.timeZone || 'America/Los_Angeles';
        const d = new Date(new Date(t.dueDate).getTime() - (t.isAllDay ? 1000 : 0));
        t.dueDateLocal = t.isAllDay
          ? d.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
          : d.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
      }
    }

    // Run waterfall, include only the TOP non-empty bucket's tasks in the prompt.
    // Other buckets are summarized as counts so Claude knows what's queued behind.
  const buckets = computeWaterfall(allTasks);
  const bucketSummary = buckets.length
  ? buckets.map(b => `  ${b.label} — ${b.tasks.length} task${b.tasks.length === 1 ? '' : 's'}`).join('\n')
  : '  (no open tasks match the waterfall)';

  const prompt = context
    .replace('{{PARTS}}', parts)
    + `\nDate/time: ${req_time || now.toISOString()}.`
    + `\n\nWaterfall bucket summary (counts only — to see the actual tasks in a bucket, use the fetch_bucket tool with that bucket's index):\n${bucketSummary}`
    + (req_voice ? '\n\nVoice mode active. Keep all responses to 1-2 sentences. No lists, no markdown formatting.' : '');
      return new Response(prompt, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
    });
  } catch(e) {
    return respond({ error: e.message }, 500);
  }
}

    
if (path === '/vapi-webhook' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.message?.type === 'assistant-request') {
          const promptRes = await fetch('https://clover-backend.kairikeymaster.workers.dev/system-prompt');
          const systemPrompt = await promptRes.text();
          return respond({
            assistant: {
              model: {
                provider: 'anthropic',
                model: 'claude-sonnet-4-5',
                messages: [{ role: 'system', content: systemPrompt }]
              },
              firstMessage: "What's up, Anna?"
            }
          });
        }
        return respond({ received: true });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }


    if (path === '/obsidian-test' && request.method === 'GET') {
      try {
        const r = await fetch(`${OBSIDIAN_URL}/vault/CAPTURE/2026-05-16.md`, {
          headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` }
        });
        const text = await r.text();
        return new Response(text, {
          headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
        });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/obsidian' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { obsidianPath, method, content } = body;
        const obsidianMethod = method || 'GET';
        const fetchOptions = {
          method: obsidianMethod,
          headers: {
            'Authorization': `Bearer ${OBSIDIAN_KEY}`,
            'Content-Type': 'text/markdown'
          }
        };
        if (content) fetchOptions.body = content;
        const r = await fetch(`${OBSIDIAN_URL}/vault/${obsidianPath}`, fetchOptions);
        const text = await r.text();
        if (r.status === 401) {
          return respond({ error: 'obsidian_auth_failed', message: 'Tunnel URL may have changed — update obsidian-tunnel.md gist with the current cloudflared URL.' }, 401);
        }
        if (!r.ok) {
          return respond({ error: 'obsidian_unreachable', message: 'Cannot reach Obsidian — make sure cloudflared is running and Obsidian is open.' }, 503);
        }
        return new Response(text, {
          headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
        });
      } catch(e) {
        return respond({ error: 'obsidian_unreachable', message: 'Cannot reach Obsidian — make sure cloudflared is running and Obsidian is open.' }, 503);
      }
    }


    if (path === '/obsidian-list' && request.method === 'GET') {
      try {
        const folder = url.searchParams.get('folder') || '';
        const r = await fetch(`${OBSIDIAN_URL}/vault/${folder}`, {
          headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Accept': 'application/json' }
        });
        const data = await r.json();
        return respond(data);
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/obsidian-search' && request.method === 'GET') {
      try {
        const r = await fetch(`${OBSIDIAN_URL}/search/`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${OBSIDIAN_KEY}`,
            'Content-Type': 'application/vnd.olrapi.jsonlogic+json'
          },
          body: JSON.stringify({ "in": ["living-document", { "var": "tags" }] })
        });
        const data = await r.json();
        return respond(data);
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

if (path === '/execute-triage' && request.method === 'POST') {
      try {
        const { noteContent, noteTitle } = await request.json();
        // Fetch living documents for append matching
        const livingRes = await fetch(`${OBSIDIAN_URL}/search/`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'application/vnd.olrapi.jsonlogic+json' },
          body: JSON.stringify({ "in": ["living-document", { "var": "tags" }] })
        });
        const livingDocs = await livingRes.json();
        const livingTitles = livingDocs.map(d => ({ path: d.filename, title: d.filename.split('/').pop().replace('.md','') }));

        // Parse items from annotated note
        const sections = noteContent.split(/^# $/m).map(s => s.trim()).filter(Boolean);
        const results = [];

        for (const section of sections) {
          const lines = section.split('\n');
          const calloutLine = lines.find(l => l.startsWith('> [!info]'));
          if (!calloutLine) continue;
          const itemText = lines.filter(l => !l.startsWith('>')).join('\n').trim();
          const dateStamp = `<span class="date-stamp">${noteTitle}</span>`;

          if (calloutLine.includes('TickTick')) {
            // Parse TickTick callout in the new schema's format.
            // Format: > [!info] TickTick \~ProjectKey \!pN \#TAG \#TAG ...
            // Project is the tilde-prefixed nickname (TK/BK/FM/GH); priority is bang-prefixed (p0/p1/p3/p5);
            // tags are hash-prefixed (HE/LCL/HCL/d0/d1). All are optional except project (defaults to TK).
            const projectMatch  = calloutLine.match(/\\?~(TK|BK|FM|GH)\b/);
            const priorityMatch = calloutLine.match(/\\?!(p0|p1|p3|p5)\b/);
            const tagMatches    = [...calloutLine.matchAll(/\\?#(HE|LCL|HCL|d0|d1)\b/g)];
            const projectKey  = projectMatch  ? projectMatch[1]  : 'TK';
            const priorityKey = priorityMatch ? priorityMatch[1] : 'p0';
            const tagKeys     = tagMatches.map(m => m[1]);
            const projectId = TRIAGE_SCHEMA.projects[projectKey] || TRIAGE_SCHEMA.projects.TK;
            const priority  = TRIAGE_SCHEMA.priority[priorityKey] ?? 0;
            const apiTags   = tagKeys.map(k => TRIAGE_SCHEMA.tags[k]).filter(Boolean);

            const taskRes = await fetch('https://api.ticktick.com/open/v1/task', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${TICKTICK_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: itemText.split('\n')[0], content: itemText.split('\n').slice(1).join('\n'), priority, projectId, tags: apiTags })
            });
            results.push({ type: 'ticktick', title: itemText.split('\n')[0], ok: taskRes.ok });

          } else if (calloutLine.includes('Obsidian')) {
            const pathMatch = calloutLine.match(/Obsidian > (.+?) > ([*+])(.*)$/);
            if (!pathMatch) continue;
            const folderPath = pathMatch[1].replace(/ > /g, '/');
            const action = pathMatch[2];
            const titleHint = pathMatch[3].trim();

            if (action === '*') {
              // Create new note
              let title = titleHint;
              if (!title) {
                // Generate a short title for THIS item via Claude
                const titleRes = await fetch('https://api.anthropic.com/v1/messages', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
                  body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 30,
                    system: 'Summarize the note into a concise 3-5 word title suitable for a filename. Return ONLY the title text — no quotes, punctuation, explanation, or file extension.',
                    messages: [
                      { role: 'user', content: itemText }
                    ] })
                });
                const titleData = await titleRes.json();
                title = titleData.content?.[0]?.text?.trim().replace(/[\\/:*?"<>|]/g, '') || 'Untitled Note';
              }
              const notePath = `${folderPath}/${title}.md`;
              const noteRes = await fetch(`${OBSIDIAN_URL}/vault/${encodeURIComponent(notePath)}`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
                body: `${itemText}\n${dateStamp}`
              });
              results.push({ type: 'obsidian-new', title, path: notePath, ok: noteRes.ok });

            } else if (action === '+') {
              // Append to existing note — fuzzy match
              const searchTitle = titleHint.toLowerCase();
              let match = livingTitles.find(d => d.title.toLowerCase() === searchTitle);
              if (!match) match = livingTitles.find(d => d.title.toLowerCase().includes(searchTitle) || searchTitle.includes(d.title.toLowerCase()));
              
              if (match) {
                const appendRes = await fetch(`${OBSIDIAN_URL}/vault/${encodeURIComponent(match.path)}`, {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
                  body: `\n${itemText}\n${dateStamp}`
                });
                results.push({ type: 'obsidian-append', title: match.title, path: match.path, ok: appendRes.ok });
              } else {
                // No match — create in CAPTURE
                const fallbackTitle = titleHint || 'Unmatched Note';
                const fallbackPath = `${TRIAGE_SCHEMA.obsidian.capture}/${fallbackTitle}.md`;
                const fallbackRes = await fetch(`${OBSIDIAN_URL}/vault/${encodeURIComponent(fallbackPath)}`, {
                  method: 'PUT',
                  headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
                  body: `${itemText}\n${dateStamp}`
                });
                results.push({ type: 'obsidian-fallback', title: fallbackTitle, path: fallbackPath, ok: fallbackRes.ok });
              }
            }
          } else if (calloutLine.includes('archive')) {
            results.push({ type: 'archive', ok: true });
          }
        }

        // Move daily note to _archive
        const originalContent = noteContent;
        const archivePath = `${TRIAGE_SCHEMA.obsidian.archive}/${noteTitle}.md`;
        await fetch(`${OBSIDIAN_URL}/vault/${encodeURIComponent(archivePath)}`, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
          body: originalContent
        });
        await fetch(`${OBSIDIAN_URL}/vault/${encodeURIComponent(`${TRIAGE_SCHEMA.obsidian.capture}/${noteTitle}.md`)}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` }
        });

        return respond({ ok: true, results, archived: archivePath });
      } catch(e) {
        return respond({ error: e.message }, 500);
      }
    }

    if (path === '/voice-assistant' && request.method === 'POST') {
  try {
    const { transcript } = await request.json();
    
    // Fetch Clover's context from Gist
    const contextRes = await fetch(`https://gist.githubusercontent.com/kairikeymaster/d5a46abda4e74f893c3801c2445197e8/raw`);
    const context = await contextRes.text();
    
    // Call Anthropic API
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: context,
        messages: [{ role: 'user', content: transcript }]
      })
    });
    
    const data = await anthropicRes.json();
    
    // Debug: return the full API response to see what's wrong
    if (data.type === 'error' || !data.content) {
      return new Response(JSON.stringify({ error: 'API error', details: data }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN
        }
      });
    }
    
    const responseText = data.content?.[0]?.text || 'Sorry, I didn\'t catch that.';
    
    return new Response(responseText, {
      headers: {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN
      }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, stack: e.stack }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN
      }
    });
  }
}

if (path === '/append-transcript' && request.method === 'POST') {
  try {
    const { source, user, assistant, timestamp } = await request.json();
    const TRANSCRIPT_GIST_ID = '9b7438e2bb0678cbf6d8b05fbabf6354';

    const currentRes = await fetch(`https://api.github.com/gists/${TRANSCRIPT_GIST_ID}`, {
      headers: {
        'Authorization': `token ${GITHUB_KEY}`,
        'User-Agent': 'Clover-Backend',
        'Accept': 'application/vnd.github+json'
      }
    });

    if (!currentRes.ok) {
      const errBody = await currentRes.text();
      return respond({ ok: false, step: 'fetch', status: currentRes.status, details: errBody }, 500);
    }

    const gistData = await currentRes.json();
    const currentContent = gistData.files?.['transcript.csv']?.content || 'timestamp,source,user,assistant';

    const ts = timestamp || new Date().toISOString().slice(0, 16).replace('T', ' ');

    const csvEscape = (s) => {
      if (s == null) return '';
      const str = String(s);
      return (str.includes('"') || str.includes(',') || str.includes('\n'))
        ? '"' + str.replace(/"/g, '""') + '"'
        : str;
    };

    const newRow = `${ts},${source},${csvEscape(user)},${csvEscape(assistant)}`;
    const updatedContent = currentContent + '\n' + newRow;

    const patchRes = await fetch(`https://api.github.com/gists/${TRANSCRIPT_GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GITHUB_KEY}`,
        'User-Agent': 'Clover-Backend',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json'
      },
      body: JSON.stringify({ files: { 'transcript.csv': { content: updatedContent } } })
    });

    if (!patchRes.ok) {
      const errBody = await patchRes.text();
      return respond({ ok: false, step: 'patch', status: patchRes.status, details: errBody }, 500);
    }

    return respond({ ok: true });
  } catch(e) {
    return respond({ error: e.message }, 500);
  }
}


if (path === '/' && request.method === 'GET') {
  try {
    const r = await fetch(`https://api.github.com/gists/16ba50a2a0072b8071c010fa6ed4030e`, {
      headers: {
        'Authorization': `token ${GITHUB_KEY}`,
        'User-Agent': 'Clover-Backend',
        'Accept': 'application/vnd.github+json'
      }
    });
    const gistData = await r.json();
    const file = gistData.files?.['clover_chat.html'];
    const html = file?.content;
    
    if (!html) {
      return new Response(JSON.stringify({
        gistApiStatus: r.status,
        gistApiOk: r.ok,
        availableFiles: Object.keys(gistData.files || {}),
        fileFound: !!file,
        fileTruncated: file?.truncated,
        fileSize: file?.size,
        fileRawUrl: file?.raw_url,
        contentLength: file?.content?.length,
        errorMessage: gistData.message
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN
      }
    });
  } catch(e) {
    return respond({ error: e.message, stack: e.stack }, 500);
  }
}


if (path === '/ticktick/bucket' && request.method === 'GET') {
  try {
    const index = parseInt(url.searchParams.get('index') || '0', 10);
    if (index < 1 || index > 9) {
      return respond({ error: 'index must be between 1 and 9' }, 400);
    }

    // Fetch all open tasks (excludes Planning, matches execution mode).
    const projectsToFetch = Object.values(TICKTICK_PROJECTS).filter(id => id !== TICKTICK_PROJECTS.PL);
    const results = await Promise.all(projectsToFetch.map(id =>
      fetch(`https://api.ticktick.com/open/v1/project/${id}/data`, {
        headers: { Authorization: `Bearer ${TICKTICK_TOKEN}` }
      }).then(r => r.json())
    ));
    const allTasks = results.flatMap(r => (r.tasks || []).filter(t => t.status === 0));

    // Format due dates locally (same logic as elsewhere).
    for (const t of allTasks) {
      if (t.dueDate) {
        const tz = t.timeZone || 'America/Los_Angeles';
        const d = new Date(new Date(t.dueDate).getTime() - (t.isAllDay ? 1000 : 0));
        t.dueDateLocal = t.isAllDay
          ? d.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' })
          : d.toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
      }
    }

    const buckets = computeWaterfall(allTasks);
    const bucket = buckets.find(b => b.stepIndex === index);
    if (!bucket) {
      return respond({ index, label: null, tasks: [], note: 'No tasks in this bucket.' });
    }
    return respond({ index, label: bucket.label, tasks: bucket.tasks });
  } catch(e) {
    return respond({ error: e.message, stack: e.stack }, 500);
  }
}


    return respond({ debug: 'no route matched', path, method: request.method }, 200);

  }
};

function respond(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN
    }
  });
}

function cors() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}