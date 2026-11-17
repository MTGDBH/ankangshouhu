import { canActFor } from '../lib/intake.js';
import { getToolDefinition, validateJsonSchema } from './toolRegistry.js';

const CARE_SCOPE = {
  health_summary: 'view_summary', behavior: 'view_summary', device: 'view_summary',
  health_trend: 'view_trends', htn_risk: 'view_trends', disease_risk: 'view_trends',
  alerts: 'view_alerts', followup_status: 'view_retest',
  list_active_interventions: 'view_interventions', explain_intervention_result: 'view_interventions',
  record_adherence: 'record_adherence',
  check_data_quality: 'view_summary', research_metric_history: 'view_summary', schedule_followup: 'manage_followups',
};

/** 默认禁止：只有注册、Schema 合法且后端对象绑定通过的工具可以执行。 */
export function authorizeToolCall({ name, args, actor, subject }) {
  const definition = getToolDefinition(name);
  if (!definition) return { allowed: false, code: 'TOOL_NOT_REGISTERED' };
  if (!actor?.id || !subject?.id) return { allowed: false, code: 'IDENTITY_BINDING_MISSING' };
  const schema = validateJsonSchema(definition.input_schema, args || {});
  if (!schema.ok) return { allowed: false, code: 'TOOL_ARGUMENT_SCHEMA', detail: schema.error };
  if (definition.subject_bound) {
    const access = canActFor(Number(subject.id), Number(actor.id), 'use_agent', { resource: `agent-tool:${name}` });
    if (!access.allowed || (CARE_SCOPE[name] && !access.scopes.includes(CARE_SCOPE[name]))) {
      return { allowed: false, code: 'TOOL_PERMISSION_DENIED' };
    }
  }
  if (Object.hasOwn(args || {}, 'user_id') || Object.hasOwn(args || {}, 'subject_user_id') || Object.hasOwn(args || {}, 'actor_user_id')) {
    return { allowed: false, code: 'SENSITIVE_ARGUMENT_FORBIDDEN' };
  }
  return { allowed: true, definition };
}
