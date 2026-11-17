import { createHash } from 'node:crypto';
import db from '../db.js';
import { canActFor } from '../lib/intake.js';
import { parseRecordedTime } from './temporalPolicy.js';

const metricColumns = 'id,type,value,value2,unit,recorded_at,source,measurement_condition,created_at,revision';
const profileColumns = 'id,category,memory_key,content,status,confirmed_at,valid_until,updated_at,actor_user_id';
const planColumns = 'id,intervention_id,target_metrics,status,confirmed_at,baseline_start,baseline_end,outcome_start,outcome_end,followup_id,revision';
const logColumns = 'l.id,l.execution_log_id,l.performed,l.performed_at,l.data_source,l.user_note,l.skip_reason,l.supersedes_log_id';
const MAX_ROWS = 2000;
const iso = time => new Date(time).toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const self = (actor, subject) => Number(actor.id) === Number(subject.id);

export const temporalEnabled = () => process.env.AGENT_TEMPORAL_MEMORY_V3 === '1';

function authorized(actor, subject, scope, resource) {
  if (scope === 'self') return self(actor, subject);
  if (self(actor, subject)) return true;
  const access = canActFor(subject.id, actor.id, 'use_agent', { resource });
  return access.allowed && access.scopes.includes(scope);
}

export function temporalScope(kind) {
  if (kind === 'profile' || kind === 'adjustment' || kind === 'draft') return 'self';
  if (kind === 'feedback') return 'view_interventions';
  return 'view_trends';
}

export function temporalPermissions(actor, subject, mode) {
  const allowed = authorized(actor, subject, temporalScope(mode), 'temporal-memory-query');
  return { allowed, measurements: allowed && (temporalScope(mode) === 'view_trends' ||
    authorized(actor, subject, 'view_trends', 'temporal-memory-linked-measurements')) };
}

export function getTemporalMeasurements(subjectId, metric, window, now) {
  // SQLite accepts existing ISO and legacy local timestamps. Give local records the same +08:00 boundary as the parser.
  const time = "julianday(CASE WHEN substr(recorded_at,-1) IN ('Z','z') OR substr(recorded_at,-6,1) IN ('+','-') THEN recorded_at ELSE recorded_at||'+08:00' END)";
  const rows = db.prepare(`SELECT ${metricColumns} FROM metrics WHERE user_id=? AND type=?
    AND ${time}>=julianday(?) AND ${time}<julianday(?) AND ${time}<=julianday(?)
    ORDER BY ${time} DESC,id DESC LIMIT ?`).all(subjectId, metric, iso(window.from), iso(window.to), iso(now), MAX_ROWS + 1);
  return { rows: rows.slice(0, MAX_ROWS), overflow: rows.length > MAX_ROWS };
}

export function getTemporalProfiles(subjectId, now) {
  return db.prepare(`SELECT ${profileColumns} FROM agent_memories
    WHERE subject_user_id=? AND actor_user_id=? AND status='confirmed' ORDER BY id DESC LIMIT 100`).all(subjectId, subjectId)
    .filter(row => {
      const at = parseRecordedTime(row.confirmed_at);
      const expiry = row.valid_until == null ? Infinity : parseRecordedTime(row.valid_until);
      return Number.isFinite(at) && at <= now && expiry > now;
    });
}

export function getTemporalFeedback(subjectId, metric, windows, now) {
  const before = Math.max(...windows.map(row => row.to));
  const after = Math.min(...windows.map(row => row.from));
  const rows = db.prepare(`SELECT ${planColumns} FROM interventions WHERE subject_user_id=?
    AND confirmed_at IS NOT NULL AND status NOT IN ('cancelled','safety_stopped')
    AND julianday(confirmed_at)<julianday(?) AND julianday(outcome_end)>=julianday(?)
    ORDER BY confirmed_at DESC,id DESC LIMIT 26`).all(subjectId, iso(Math.min(now, before)), iso(after));
  if (rows.length > 25) return { items: [], overflow: true };
  const selectable = rows.filter(row => !metric || JSON.parse(row.target_metrics).includes(metric));
  const items = selectable.map(plan => {
    const logs = db.prepare(`SELECT ${logColumns} FROM intervention_execution_logs l
      WHERE l.intervention_db_id=? AND julianday(l.performed_at)>=julianday(?) AND julianday(l.performed_at)<julianday(?)
      AND NOT EXISTS(SELECT 1 FROM intervention_execution_logs newer WHERE newer.supersedes_log_id=l.id)
      ORDER BY julianday(l.performed_at) DESC,l.id DESC LIMIT 201`).all(plan.id, iso(after), iso(Math.min(now + 1, before)));
    return { plan, logs: logs.filter(log => windows.some(window => {
      const time = parseRecordedTime(log.performed_at);
      return time >= window.from && time < window.to;
    })), overflow: logs.length > 200 };
  });
  return { items, overflow: items.some(row => row.overflow) };
}

export const makeReference = (kind, row) => ({ kind, id: row.id, fingerprint: hash(row) });

export function saveMemoryRevisions(subjectId, items, now) {
  const latest = db.prepare('SELECT * FROM temporal_memory_revisions WHERE subject_user_id=? AND memory_key=? ORDER BY id DESC LIMIT 1');
  const insert = db.prepare(`INSERT INTO temporal_memory_revisions
    (subject_user_id,memory_key,kind,metric,event_at,valid_from,valid_until,quality_status,source_refs,source_fingerprint,supersedes_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  return db.transaction(() => items.filter(item => item.refs.length).map(item => {
    const refs = item.refs.sort((a, b) => a.kind.localeCompare(b.kind, 'en') || a.id - b.id);
    const fingerprint = hash({ refs, kind: item.kind, quality: item.status, from: item.at, to: item.end, expiry: item.expires });
    const prior = latest.get(subjectId, item.id);
    const id = prior?.source_fingerprint === fingerprint ? prior.id : Number(insert.run(subjectId, item.id, item.kind,
      item.metric || null, iso(item.eventAt ?? item.at), iso(item.at), item.end != null ? iso(item.end) : item.expires ? iso(item.expires) : null,
      item.status || 'supported', JSON.stringify(refs), fingerprint, prior?.id ?? null, iso(now)).lastInsertRowid);
    return { ...item, revisionId: id };
  })).immediate();
}

function readReference(subjectId, ref) {
  switch (ref.kind) {
    case 'measurement':
      return db.prepare(`SELECT ${metricColumns} FROM metrics WHERE user_id=? AND id=?`).get(subjectId, ref.id);
    case 'profile':
      return db.prepare(`SELECT ${profileColumns} FROM agent_memories WHERE subject_user_id=? AND id=? AND status='confirmed'`).get(subjectId, ref.id);
    case 'plan':
      return db.prepare(`SELECT ${planColumns} FROM interventions WHERE subject_user_id=? AND id=?`).get(subjectId, ref.id);
    case 'feedback':
      return db.prepare(`SELECT ${logColumns} FROM intervention_execution_logs l JOIN interventions p ON p.id=l.intervention_db_id
        WHERE p.subject_user_id=? AND l.id=? AND NOT EXISTS(SELECT 1 FROM intervention_execution_logs newer WHERE newer.supersedes_log_id=l.id)`).get(subjectId, ref.id);
  }
  return null;
}

export function getTemporalSource(actor, subject, id, now = Date.now()) {
  const row = db.prepare('SELECT * FROM temporal_memory_revisions WHERE id=? AND subject_user_id=?').get(id, subject.id);
  if (!row || !authorized(actor, subject, temporalScope(row.kind), 'temporal-memory-source')) return null;
  const { source_refs, source_fingerprint, memory_key, ...metadata } = row;
  const newest = db.prepare('SELECT id FROM temporal_memory_revisions WHERE subject_user_id=? AND memory_key=? ORDER BY id DESC LIMIT 1').get(subject.id, memory_key);
  if (newest.id !== row.id) return { ...metadata, status: 'superseded', superseded_by: newest.id, sources: [] };
  if (row.kind === 'profile' && row.valid_until && parseRecordedTime(row.valid_until) <= now) return { ...metadata, status: 'expired', sources: [] };
  const refs = JSON.parse(source_refs);
  const linkedAllowed = !refs.some(ref => ref.kind === 'measurement') || authorized(actor, subject, 'view_trends', 'temporal-memory-source-measurements');
  if (!linkedAllowed) return null;
  const sources = refs.map(ref => {
    const current = readReference(subject.id, ref);
    if (!current || hash(current) !== ref.fingerprint) return null;
    const { user_note, skip_reason, actor_user_id, ...fields } = current;
    return { ...fields, kind: ref.kind };
  });
  if (sources.some(source => !source)) return { ...metadata, status: 'source_changed', sources: [] };
  return { ...metadata, status: 'verified', sources };
}
