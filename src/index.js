const json = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders }
});

const id = () => crypto.randomUUID();
const SESSION_COOKIE = 'crewline_session';
const SESSION_DAYS = 90;
const bytesToHex = (bytes) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
async function hashText(value) { return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
function randomToken(bytes = 32) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return btoa(String.fromCharCode(...values)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function randomCode() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(values[0] % 1000000).padStart(6, '0');
}
function cookieValue(request, name) {
  const cookieHeader = request.headers.get('cookie') || '';
  return cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}
function cookieHeader(token, maxAge = SESSION_DAYS * 86400) { return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`; }
async function currentUser(request, db) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await hashText(token);
  return db.prepare(`SELECT u.id, u.email, u.person_id, om.organization_id, om.role
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN organization_members om ON om.user_id = u.id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')
      AND u.status = 'active' AND om.status = 'active' LIMIT 1`).bind(tokenHash).first();
}
async function authApi(request, env, url) {
  if (url.pathname === '/api/auth/request-code' && request.method === 'POST') {
    const payload = await request.json();
    const email = String(payload.email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return json({ error: 'Enter a valid email address.' }, 400);
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").bind(email).first();
    if (user) {
      const code = randomCode();
      await env.DB.batch([
        env.DB.prepare("UPDATE auth_codes SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").bind(user.id),
        env.DB.prepare("INSERT INTO auth_codes (id, user_id, code_hash, expires_at) VALUES (?, ?, ?, datetime('now', '+10 minutes'))").bind(id(), user.id, await hashText(code))
      ]);
      if (env.AUTH_DEV_MODE === 'true') return json({ ok: true, dev_code: code });
    }
    return json({ ok: true, message: 'If that email belongs to Crewline, a verification code is on its way.' });
  }
  if (url.pathname === '/api/auth/verify-code' && request.method === 'POST') {
    const payload = await request.json();
    const email = String(payload.email || '').trim().toLowerCase();
    const code = String(payload.code || '').trim();
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = ? AND status = 'active'").bind(email).first();
    if (!user || !/^\d{6}$/.test(code)) return json({ error: 'Invalid or expired verification code.' }, 401);
    const authCode = await env.DB.prepare("SELECT id, code_hash FROM auth_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY created_at DESC LIMIT 1").bind(user.id).first();
    if (!authCode || (await hashText(code)) !== authCode.code_hash) return json({ error: 'Invalid or expired verification code.' }, 401);
    const token = randomToken();
    await env.DB.batch([
      env.DB.prepare("UPDATE auth_codes SET used_at = datetime('now') WHERE id = ?").bind(authCode.id),
      env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, last_seen_at) VALUES (?, ?, ?, datetime('now', '+90 days'), datetime('now'))").bind(id(), user.id, await hashText(token)),
      env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").bind(user.id)
    ]);
    const sessionUser = await currentUser(new Request(request.url, { headers: { cookie: cookieHeader(token) } }), env.DB);
    return json({ ok: true, user: sessionUser }, 200, { 'set-cookie': cookieHeader(token) });
  }
  if (url.pathname === '/api/auth/me' && request.method === 'GET') return json({ user: await currentUser(request, env.DB) });
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) await env.DB.prepare("UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ?").bind(await hashText(token)).run();
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
  }
  return null;
}

async function bootstrap(db) {
  const [org, people, roles, events, opportunities, availability, timesheets] = await Promise.all([
    db.prepare('SELECT * FROM organizations ORDER BY created_at LIMIT 1').first(),
    db.prepare(`SELECT p.*, GROUP_CONCAT(r.name, '||') AS role_names
      FROM people p LEFT JOIN person_roles pr ON pr.person_id = p.id
      LEFT JOIN roles r ON r.id = pr.role_id WHERE p.status = 'active'
      GROUP BY p.id ORDER BY p.last_name, p.first_name`).all(),
    db.prepare('SELECT * FROM roles WHERE active = 1 ORDER BY name').all(),
    db.prepare(`SELECT e.*, GROUP_CONCAT(a.person_id, '||') AS crew_ids,
      GROUP_CONCAT(DISTINCT r.name) AS event_roles
      FROM events e LEFT JOIN assignments a ON a.event_id = e.id
      LEFT JOIN event_role_requirements er ON er.event_id = e.id
      LEFT JOIN roles r ON r.id = er.role_id GROUP BY e.id ORDER BY e.date, e.start_time`).all(),
    db.prepare(`SELECT o.*, e.name AS event_name, e.date, e.start_time, e.end_time,
      r.name AS role_name FROM opportunities o JOIN events e ON e.id = o.event_id
      JOIN roles r ON r.id = o.role_id WHERE o.status = 'open' ORDER BY e.date, e.start_time`).all(),
    db.prepare('SELECT * FROM availability_blocks ORDER BY start_date').all(),
    db.prepare(`SELECT t.*, p.first_name || ' ' || p.last_name AS person_name,
      e.name AS event_name, r.name AS role_name FROM timesheets t
      JOIN people p ON p.id = t.person_id JOIN events e ON e.id = t.event_id
      JOIN roles r ON r.id = t.role_id ORDER BY t.event_date DESC`).all()
  ]);

  return {
    organization: org,
    people: people.results.map((p) => ({ ...p, initials: `${p.first_name[0]}${p.last_name[0]}`, name: `${p.first_name} ${p.last_name}`, roles: p.role_names ? p.role_names.split('||') : [], rate: p.default_rate_cents / 100, type: p.person_type, status: 'Active' })),
    roles: roles.results,
    events: events.results.map((e) => ({ ...e, number: e.job_number, start: e.start_time, end: e.end_time, location: e.location_name, address: e.street_address, role: e.event_roles?.split('||')[0] || 'Unassigned', status: e.status, notes: e.instructions, pay: 0, crew: e.crew_ids ? e.crew_ids.split('||') : [] })),
    opportunities: opportunities.results.map((o) => ({ id: o.id, eventId: o.event_id, role: o.role_name, required: o.positions_required, filled: o.positions_filled, hours: o.estimated_hours, rate: o.rate_cents / 100 })),
    availability: { unavailable: availability.results.filter((a) => a.status === 'unavailable').map((a) => a.start_date), tentative: availability.results.filter((a) => a.status === 'tentative').map((a) => a.start_date) },
    timesheets: timesheets.results.map((t) => ({ id: t.id, event: t.event_name, person: t.person_name, date: t.event_date, hours: t.approved_hours || t.actual_hours || '0.00', rate: t.hourly_rate_cents / 100, pay: (t.approved_hours || t.actual_hours || 0) * (t.hourly_rate_cents / 100), status: t.status }))
  };
}

async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: 'D1 binding is not configured.' }, 503);
  if (url.pathname === '/api/health') return json({ ok: true, service: 'crewline-api', database: 'd1' });
  if (url.pathname.startsWith('/api/auth/')) return (await authApi(request, env, url)) || json({ error: 'Not found' }, 404);
  if (url.pathname === '/api/bootstrap' && request.method === 'GET') return json(await bootstrap(env.DB));

  const opportunityMatch = url.pathname.match(/^\/api\/opportunities\/([^/]+)\/respond$/);
  if (opportunityMatch && request.method === 'POST') {
    const payload = await request.json();
    const opportunityId = opportunityMatch[1];
    const responseId = id();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO opportunity_responses (id, opportunity_id, person_id, response, responded_at)
        VALUES (?, ?, ?, ?, datetime('now'))`).bind(responseId, opportunityId, payload.person_id || 'p1', payload.response || 'interested'),
      env.DB.prepare(`UPDATE opportunities SET positions_filled = MIN(positions_required, positions_filled + CASE WHEN ? = 'interested' THEN 1 ELSE 0 END), updated_at = datetime('now') WHERE id = ?`).bind(payload.response || 'interested', opportunityId)
    ]);
    return json({ ok: true, response_id: responseId });
  }

  if (url.pathname === '/api/availability' && request.method === 'POST') {
    const payload = await request.json();
    const blockId = id();
    await env.DB.prepare(`INSERT INTO availability_blocks (id, person_id, start_date, end_date, start_time, end_time, status, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(blockId, payload.person_id || 'p1', payload.start_date, payload.end_date || payload.start_date, payload.start_time || null, payload.end_time || null, payload.status || 'unavailable', payload.note || null).run();
    return json({ ok: true, id: blockId }, 201);
  }

  if (url.pathname === '/api/timesheets' && request.method === 'POST') {
    const payload = await request.json();
    const timesheetId = id();
    await env.DB.prepare(`INSERT INTO timesheets (id, event_id, person_id, role_id, event_date, scheduled_start, scheduled_end, actual_start, actual_end, break_minutes, hourly_rate_cents, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted')`).bind(timesheetId, payload.event_id, payload.person_id || 'p1', payload.role_id, payload.event_date, payload.scheduled_start, payload.scheduled_end, payload.actual_start || null, payload.actual_end || null, payload.break_minutes || 0, payload.hourly_rate_cents || 0).run();
    return json({ ok: true, id: timesheetId }, 201);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ event: 'request_error', path: url.pathname, message: error instanceof Error ? error.message : String(error) }));
      return json({ error: 'Unexpected server error' }, 500);
    }
  }
};
