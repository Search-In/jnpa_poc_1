/**
 * <WorkflowComposer> — author, save, version, enable/disable workflow rules
 * (spec W-3, [O]). A stakeholder builds trigger → conditions → actions in the
 * UI in under a few minutes; rules persist and drive the automated ledger.
 * Read-only roles can view rules but not edit them.
 */
import { useState } from 'react';
import {
  CalciteButton,
  CalciteSelect,
  CalciteOption,
  CalciteInputNumber,
  CalciteSwitch,
  CalciteNotice,
} from '@esri/calcite-components-react';
import {
  TRIGGER_METRICS,
  COMPARATORS,
  ACTION_KINDS,
  triggerText,
  actionText,
  type Condition,
  type WorkflowAction,
  type WorkflowRule,
  type TriggerMetric,
  type Comparator,
  type ActionKind,
} from './rules';
import { useRuleStore } from './ruleStore';
import { ROLE_LIST, type Role } from '@/auth/roles';
import { useRoleStore } from '@/auth/roleStore';
import { canEdit } from '@/auth/roles';
import { tokens } from '@/theme/tokens';

const EMPTY_TRIGGER: Condition = { metric: 'windKt', cmp: 'gte', value: 30 };

export function WorkflowComposer() {
  const rules = useRuleStore((s) => s.rules);
  const create = useRuleStore((s) => s.create);
  const update = useRuleStore((s) => s.update);
  const toggle = useRuleStore((s) => s.toggle);
  const remove = useRuleStore((s) => s.remove);

  const role = useRoleStore((s) => s.role);
  const editable = canEdit(role);

  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<Condition>(EMPTY_TRIGGER);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [actions, setActions] = useState<WorkflowAction[]>([{ kind: 'raiseAlert' }]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setTrigger(EMPTY_TRIGGER);
    setConditions([]);
    setActions([{ kind: 'raiseAlert' }]);
    setEditingId(null);
  };

  const save = () => {
    if (!name.trim()) {
      setNotice('Give the rule a name.');
      return;
    }
    const payload = { name: name.trim(), enabled: true, trigger, conditions, actions };
    if (editingId) {
      update(editingId, payload);
      setNotice(`Updated "${name}" (new version).`);
    } else {
      create(payload);
      setNotice(`Saved "${name}".`);
    }
    reset();
  };

  const startEdit = (r: WorkflowRule) => {
    setEditingId(r.id);
    setName(r.name);
    setTrigger(r.trigger);
    setConditions(r.conditions);
    setActions(r.actions);
  };

  const condRow = (c: Condition, onChange: (c: Condition) => void, onRemove?: () => void) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <CalciteSelect label="metric" scale="s" value={c.metric} onCalciteSelectChange={(e) => onChange({ ...c, metric: (e.target as HTMLCalciteSelectElement).value as TriggerMetric })}>
        {TRIGGER_METRICS.map((m) => (
          <CalciteOption key={m.id} value={m.id}>{m.label}{m.unit ? ` (${m.unit})` : ''}</CalciteOption>
        ))}
      </CalciteSelect>
      <CalciteSelect label="cmp" scale="s" width="auto" value={c.cmp} onCalciteSelectChange={(e) => onChange({ ...c, cmp: (e.target as HTMLCalciteSelectElement).value as Comparator })}>
        {COMPARATORS.map((cm) => (
          <CalciteOption key={cm.id} value={cm.id}>{cm.label}</CalciteOption>
        ))}
      </CalciteSelect>
      <CalciteInputNumber
        scale="s"
        style={{ width: 90 }}
        value={String(c.value)}
        onCalciteInputNumberChange={(e) => onChange({ ...c, value: Number((e.target as HTMLCalciteInputNumberElement).value) })}
      />
      {onRemove && (
        <CalciteButton scale="s" appearance="transparent" iconStart="x" onClick={onRemove} />
      )}
    </div>
  );

  return (
    <div style={{ color: tokens.text, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!editable && (
        <CalciteNotice open kind="warning" scale="s" icon="lock">
          <div slot="message">Your role is read-only — rules are shown but cannot be edited.</div>
        </CalciteNotice>
      )}

      {/* Composer form */}
      <fieldset
        disabled={!editable}
        style={{ border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm, padding: 12, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <legend style={{ fontSize: 12, color: tokens.textMuted, padding: '0 6px' }}>
          {editingId ? 'Edit rule' : 'Compose a new rule'}
        </legend>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: tokens.textMuted }}>
          Rule name
          <input
            value={name}
            placeholder="e.g. Deep-draft UKC guard"
            onChange={(e) => setName(e.target.value)}
            disabled={!editable}
            style={{ padding: '6px 8px', background: tokens.panel, color: tokens.text, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm, fontSize: 12 }}
          />
        </label>

        <div>
          <div style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 4 }}>WHEN (trigger)</div>
          {condRow(trigger, setTrigger)}
        </div>

        <div>
          <div style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 4 }}>AND (conditions)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {conditions.map((c, i) =>
              condRow(
                c,
                (nc) => setConditions((cs) => cs.map((x, j) => (j === i ? nc : x))),
                () => setConditions((cs) => cs.filter((_, j) => j !== i))
              )
            )}
            <CalciteButton scale="s" appearance="outline" iconStart="plus" disabled={!editable} onClick={() => setConditions((cs) => [...cs, { metric: 'seaStateM', cmp: 'gte', value: 2.5 }])}>
              Add condition
            </CalciteButton>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 4 }}>THEN (actions)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {actions.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <CalciteSelect label="action" scale="s" value={a.kind} onCalciteSelectChange={(e) => {
                  const kind = (e.target as HTMLCalciteSelectElement).value as ActionKind;
                  setActions((as) => as.map((x, j) => (j === i ? { ...x, kind } : x)));
                }}>
                  {ACTION_KINDS.map((k) => (
                    <CalciteOption key={k.id} value={k.id}>{k.label}</CalciteOption>
                  ))}
                </CalciteSelect>
                {a.kind === 'notifyRole' && (
                  <CalciteSelect label="role" scale="s" value={a.role ?? 'marineOps'} onCalciteSelectChange={(e) => {
                    const r = (e.target as HTMLCalciteSelectElement).value as Role;
                    setActions((as) => as.map((x, j) => (j === i ? { ...x, role: r } : x)));
                  }}>
                    {ROLE_LIST.map((r) => (
                      <CalciteOption key={r.id} value={r.id}>{r.label}</CalciteOption>
                    ))}
                  </CalciteSelect>
                )}
                <CalciteButton scale="s" appearance="transparent" iconStart="x" onClick={() => setActions((as) => as.filter((_, j) => j !== i))} />
              </div>
            ))}
            <CalciteButton scale="s" appearance="outline" iconStart="plus" disabled={!editable} onClick={() => setActions((as) => [...as, { kind: 'raiseAlert' }])}>
              Add action
            </CalciteButton>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <CalciteButton scale="s" iconStart="save" onClick={save} disabled={!editable}>
            {editingId ? 'Save version' : 'Save rule'}
          </CalciteButton>
          {editingId && (
            <CalciteButton scale="s" appearance="outline" onClick={reset}>Cancel</CalciteButton>
          )}
        </div>
      </fieldset>

      {notice && (
        <CalciteNotice open scale="s" kind="success" icon>
          <div slot="message">{notice}</div>
        </CalciteNotice>
      )}

      {/* Saved rules */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Saved rules ({rules.length})</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rules.map((r) => (
            <div
              key={r.id}
              style={{
                border: `1px solid ${tokens.border}`,
                borderRadius: tokens.radius.sm,
                padding: 8,
                opacity: r.enabled ? 1 : 0.6,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600 }}>
                  {r.name} <span style={{ fontSize: 10, color: tokens.textMuted }}>v{r.version}</span>
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={{ fontSize: 10, color: tokens.textMuted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {r.enabled ? 'enabled' : 'disabled'}
                    <CalciteSwitch scale="s" checked={r.enabled} disabled={!editable} onCalciteSwitchChange={() => toggle(r.id)} />
                  </label>
                  {editable && <CalciteButton scale="s" appearance="transparent" iconStart="pencil" onClick={() => startEdit(r)} />}
                  {editable && <CalciteButton scale="s" appearance="transparent" kind="danger" iconStart="trash" onClick={() => remove(r.id)} />}
                </div>
              </div>
              <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 4 }}>
                WHEN {triggerText(r)} → {r.actions.map(actionText).join('; ')}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
