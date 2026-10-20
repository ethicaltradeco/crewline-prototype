const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const id = () => crypto.randomUUID();

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
