import type { LabelStyle, ModelSpec, RefRole, RoleRef } from './types';
import { REF_ROLES } from './types';

const ROLE_TEXT: Record<RefRole, string> = {
  start: 'first frame of the video',
  end: 'last frame of the video',
  identity: 'identity reference: keep this person or character recognisably the same',
  style: 'style reference: match its look, not its content',
  object: 'object reference: keep this object or product accurate',
  location: 'location reference: keep this setting consistent',
};

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

export function parseRefArg(arg: string): RoleRef {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new Error(`--ref expects <role>=<path|url>, got "${arg}"`);
  const role = arg.slice(0, eq).trim().toLowerCase() as RefRole;
  const source = arg.slice(eq + 1).trim();
  if (!REF_ROLES.includes(role)) throw new Error(`Unknown reference role "${role}". Roles: ${REF_ROLES.join(', ')}`);
  if (!source) throw new Error(`--ref ${role}= needs a path or URL`);
  return { role, source };
}

export function attachNotes(refs: RoleRef[], notes: string[]): RoleRef[] {
  const out = refs.map((r) => ({ ...r }));
  for (const n of notes) {
    const m = n.match(/^(\d+)=([\s\S]+)$/);
    if (!m) throw new Error(`--ref-note expects <n>=<text>, got "${n}"`);
    const i = Number(m[1]);
    if (i < 1 || i > out.length) throw new Error(`--ref-note ${i} has no matching --ref (there are ${out.length})`);
    out[i - 1].note = m[2].trim();
  }
  return out;
}

export interface RefCheck {
  errors: string[];
  warnings: string[];
  forcedDuration?: number;
}

/** Check role-typed references against the spec's rules. Pure; sends nothing. */
export function validateRefs(spec: ModelSpec, refs: RoleRef[], ctx: { duration?: number }): RefCheck {
  const check: RefCheck = { errors: [], warnings: [] };
  if (refs.length === 0) return check;
  const where = `${spec.name} (${spec.provider})`;
  const caps = spec.refs;
  if (!caps) {
    check.errors.push(`${where} does not accept role-typed references (--ref)`);
    return check;
  }

  const counts = new Map<RefRole, number>();
  for (const r of refs) counts.set(r.role, (counts.get(r.role) ?? 0) + 1);

  for (const [role, n] of counts) {
    const max = caps[role] ?? 0;
    if (max === 0) check.errors.push(`${where} does not accept a "${role}" reference`);
    else if (n > max) check.errors.push(`${where} accepts at most ${max} "${role}" reference(s); got ${n}`);
  }

  const imageRefs = refs.filter((r) => r.role !== 'start' && r.role !== 'end').length;
  const totalMax = spec.inputs?.max_images;
  if (totalMax !== undefined && imageRefs > totalMax) {
    check.errors.push(`${where} accepts at most ${totalMax} reference images in total; got ${imageRefs}`);
  }

  for (const group of caps.exclusive ?? []) {
    const present = group.filter((role) => counts.has(role));
    if (present.length > 1) check.errors.push(`${where} cannot combine ${present.join(' and ')} references`);
  }

  for (const role of counts.keys()) {
    const forced = caps.forces?.[role]?.duration;
    if (forced === undefined) continue;
    if (ctx.duration !== undefined && ctx.duration !== forced) {
      check.warnings.push(`duration ${ctx.duration}s overridden to ${forced}s: ${where} requires it with a "${role}" reference`);
    }
    check.forcedDuration = forced;
  }

  const identities = counts.get('identity') ?? 0;
  if (caps.max_people_warning !== undefined && identities > caps.max_people_warning) {
    check.warnings.push(`${identities} identity references exceeds ${caps.max_people_warning}; ${where} becomes unstable with more people`);
  }
  return check;
}

/** Text appended to the prompt that tells the model what each reference image is for. */
export function renderRefLabels(style: LabelStyle | undefined, refs: RoleRef[]): string {
  if (refs.length === 0) return '';
  const describe = (r: RoleRef) => ROLE_TEXT[r.role] + (r.note ? ` (${r.note})` : '');
  if (style === 'at-index') return refs.map((r, i) => `@Image${i + 1}: ${describe(r)}.`).join('\n');
  if (style === 'wan-numbered') return refs.map((r, i) => `Image ${i + 1}: ${describe(r)}.`).join('\n');
  const ordinal = (i: number) => ORDINALS[i] ?? `#${i + 1}`;
  return 'Reference images: ' + refs.map((r, i) => `the ${ordinal(i)} image is the ${describe(r)}`).join('; ') + '.';
}
