import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Link2, Plus, Trash2 } from 'lucide-react';
import { Button, Checkbox, IconButton, TextField, Select, SelectOption } from '@token-catalog/forge-react';
import { FieldRow } from '@/components/ui/field-row';
import { colorHex, colorSpace, colorSpaces } from '../lib/color.ts';
import { referenceLabel } from '../lib/document.ts';
import type { DocumentGraph } from '../lib/document.ts';
import { isJsonObject } from '../lib/json.ts';
import type { JsonObject, JsonValue } from '../lib/json.ts';
import { serializeTokenPointer, tokenPointer } from '../lib/token-path.ts';
import { isColor } from '../lib/token-types.ts';
import { convertColor, displayColor } from './lib/color-preview.ts';
import { ReferenceDialog } from './reference-picker.tsx';
import { TokenValue } from './token-value.tsx';
import { compositeFields, defaultValue, shadowFields } from './lib/value-shape.ts';
import { previewTypes, ValuePreview } from './value-preview.tsx';

interface EditContext { graph: DocumentGraph; source: string; sources?: readonly string[]; file: string; busy: boolean; preview?: JsonValue | undefined }
interface FieldProps {
  edit: EditContext;
  field: readonly string[];
  type: string;
  label: string;
  value: JsonValue | undefined;
  write: (value: JsonValue | undefined) => void;
  componentLabels?: readonly string[];
  hideLegend?: boolean;
}

const strokeKeywords = ['solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'outset', 'inset'];

function objectValue(value: JsonValue | undefined): JsonObject {
  return isJsonObject(value) ? value : {};
}

function withField(object: JsonObject, key: string, value: JsonValue | undefined) {
  const next = { ...object };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function fieldValue(value: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  return path.reduce<JsonValue | undefined>((node, key) => {
    if (Array.isArray(node)) return /^(0|[1-9][0-9]*)$/u.test(key) ? node[Number(key)] : undefined;
    return isJsonObject(node) && Object.hasOwn(node, key) ? node[key] : undefined;
  }, value);
}

function solutionForLink(edit: EditContext, text: string, field: readonly string[]) {
  const stored = edit.graph.links.get(edit.source)?.get(JSON.stringify(['$value', ...field]));
  if (stored?.text === text) return stored.value;
  if (text.startsWith('{')) return edit.graph.resolved.get(text.slice(1, -1));
  try {
    const { file, parts } = tokenPointer(text, edit.file);
    const valueIndex = parts.indexOf('$value');
    const path = parts.slice(0, valueIndex < 0 ? parts.length : valueIndex).join('.');
    if (edit.graph.tokens.get(path)?.file !== file) return undefined;
    const value = edit.graph.resolved.get(path);
    return valueIndex < 0 ? value : fieldValue(value, parts.slice(valueIndex + 1));
  } catch {
    return undefined;
  }
}

function previewFields(value: JsonValue | undefined, edit: EditContext): JsonValue | undefined {
  const active = new Set<string>();
  function visit(node: JsonValue | undefined, field: readonly string[]): JsonValue | undefined {
    const reference = referenceLabel(node);
    if (reference) {
      const key = JSON.stringify(field);
      if (active.has(key)) return undefined;
      active.add(key);
      try {
        if (!reference.startsWith('{')) {
          const { file, parts } = tokenPointer(reference, edit.file);
          const boundary = parts.indexOf('$value');
          if (boundary >= 0 && file === edit.file && parts.slice(0, boundary).join('.') === edit.source) {
            const target = parts.slice(boundary + 1);
            return visit(fieldValue(value, target), target);
          }
        }
        return solutionForLink(edit, reference, field);
      } catch {
        return undefined;
      } finally {
        active.delete(key);
      }
    }
    if (Array.isArray(node)) return node.map((item, index) => visit(item, [...field, String(index)]) ?? null);
    if (isJsonObject(node)) return Object.fromEntries(Object.entries(node).map(([key, item]) =>
      [key, visit(item, [...field, key])]));
    return node;
  }
  return visit(value, []);
}

function StyledSelect({ label, value, options, change, busy, action }: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  change: (value: string) => void;
  busy: boolean;
  action?: ReactNode;
}) {
  const id = useId();
  return <div className="flex min-w-0 flex-col gap-space50">
    <div className="flex items-center justify-between gap-space100">
      <label htmlFor={id} className="token-editor-label">{label}</label>{action}
    </div>
    <Select id={id} className="w-full" value={value} disabled={busy} onChange={event => change(event.target.value)}>
      {!options.some(([key]) => key === value) && <SelectOption value={value}>{value || 'Choose…'}</SelectOption>}
      {options.map(([key, name]) => <SelectOption key={key} value={key}>{name}</SelectOption>)}
    </Select>
  </div>;
}

function choices(values: readonly string[]): [string, string][] {
  return values.map(value => [value, value]);
}

function numericValue(text: string): number | string {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text.trim())) return text;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : text;
}

function NumberInput({ edit, label, value, write, action }: FieldProps & { action?: ReactNode }) {
  const [text, setText] = useState('');
  const display = value !== undefined && Object.is(numericValue(text), value) ? text : displayField(value);
  return <TextField label={label} value={display} disabled={edit.busy} trailing={action} inputMode="decimal" data-primary-editor
    onChange={event => { setText(event.target.value); write(numericValue(event.target.value)); }} />;
}

function displayField(value: JsonValue | undefined): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
}

function TypedValue(props: FieldProps) {
  const { edit, field, label, type, value, write } = props;
  const [linking, setLinking] = useState(false);
  const reference = referenceLabel(value);
  const literal = reference ? fieldValue(edit.preview, field) ?? solutionForLink(edit, reference, field) : undefined;
  const edge = reference ? edit.graph.links.get(edit.source)?.get(JSON.stringify(['$value', ...field])) : undefined;
  const alias = reference?.startsWith('{') ? reference.slice(1, -1) : undefined;
  const valueIndex = edge?.parts.indexOf('$value') ?? -1;
  const target = alias ? { path: alias, field: [] } : edge?.target
    ? { path: edge.target, field: valueIndex < 0 ? [] : edge.parts.slice(valueIndex + 1) } : undefined;
  const linkButton = field.length > 0 && <IconButton type="button" size="xsmall" label={'Link ' + label} title={'Link ' + label}
    disabled={edit.busy || !edit.file} aria-haspopup="dialog" onClick={() => setLinking(true)}><Link2 aria-hidden="true" /></IconButton>;
  return <div className="grid min-w-0 gap-space75">
    {reference ? <div className="grid min-w-0 gap-space50 copy-small">
      <span className="copy-emphasis">{label}</span>
      <TokenValue value={value} authored wrap />
      {literal !== undefined && <TokenValue value={literal} swatch wrap />}
      <div className="flex flex-wrap gap-space50">
        <Button type="button" size="xsmall" variant="text" disabled={edit.busy || !edit.file} onClick={() => setLinking(true)}>Change link</Button>
        <Button type="button" size="xsmall" variant="text" disabled={edit.busy} onClick={() => write(literal ?? defaultValue(type))}>Use literal</Button>
      </div>
    </div> : <LiteralField {...props} action={linkButton} />}
    {linking && <ReferenceDialog graph={edit.graph} source={edit.source} sourceField={field} sourcePaths={edit.sources}
      type={type} target={target} seed="" flexible={false}
      close={() => setLinking(false)} choose={choice => {
        const destination = edit.graph.tokens.get(choice.path)?.file;
        if (destination === undefined) return false;
        write(choice.field.length ? { $ref: serializeTokenPointer(edit.file, destination,
          [...choice.path.split('.'), '$value', ...choice.field]) } : '{' + choice.path + '}');
        return true;
      }} />}
  </div>;
}

function LiteralField(props: FieldProps & { action?: ReactNode }) {
  const { edit, field, type, label, value, write, action } = props;
  switch (type) {
    case 'number': return <NumberInput {...props} />;
    case 'numberOrNone':
      return value === 'none' ? <div className="flex items-center justify-between gap-space100 copy-body">{label} · none{action}</div> : <NumberInput {...props} />;
    case 'fontWeight': return <TextField label={label} value={displayField(value)} disabled={edit.busy} trailing={action} data-primary-editor
      onChange={event => write(numericValue(event.target.value))} />;
    case 'fontName':
    case 'string':
    case 'hex': return <TextField label={label} value={displayField(value)} disabled={edit.busy} trailing={action} data-primary-editor
      onChange={event => write(event.target.value)} />;
    case 'boolean': return <div className="flex items-center justify-between gap-space100"><label className="flex check-label-min items-center gap-space100 copy-body">
      <Checkbox checked={value === true} disabled={edit.busy} onChange={event => write(event.target.checked)} />{label}
    </label>{action}</div>;
    case 'dimensionUnit':
    case 'durationUnit':
    case 'lineCap':
    case 'colorSpace': {
      const options = type === 'colorSpace' ? Object.entries(colorSpaces).map(([key, definition]) => [key, definition.name] as const) :
        choices(type === 'dimensionUnit' ? ['px', 'rem', 'dp', 'sp'] : type === 'durationUnit' ? ['ms', 's'] : ['butt', 'round', 'square']);
      return <StyledSelect label={label} options={options} value={displayField(value)} busy={edit.busy} change={write} action={action} />;
    }
    case 'fontFamily':
      return <div className="grid gap-space100">
        {Array.isArray(value) ? <>{action && <FieldHeading label={label} action={action} />}<ArrayFields {...props} values={value} itemType="fontName" itemLabel="Font" min={1} /></> :
          <><TextField label={label} value={displayField(value)} disabled={edit.busy} trailing={action} data-primary-editor
            onChange={event => write(event.target.value)} />
          <Button type="button" size="xsmall" variant="text" className="justify-self-start" disabled={edit.busy}
            onClick={() => write([value ?? '', 'sans-serif'])}><Plus aria-hidden="true" /> Add fallback font</Button></>}
        {Array.isArray(value) && value.length === 1 && !referenceLabel(value[0]) &&
          <Button type="button" size="xsmall" variant="text" className="justify-self-start" disabled={edit.busy}
            onClick={() => write(value[0])}>Use single font</Button>}
      </div>;
    case 'dimension':
    case 'duration': {
      const object = objectValue(value);
      return <fieldset className="flex min-w-0 flex-col gap-space100" aria-label={label}>
        {(label !== 'Token value' || action) && <FieldHeading label={label} action={action} />}
        <TypedValue {...props} field={[...field, 'value']} type="number" label={field.length ? label + ' value' : 'Token value'}
          value={object['value']} write={next => write(withField(object, 'value', next))} />
        <TypedValue {...props} field={[...field, 'unit']} type={type === 'dimension' ? 'dimensionUnit' : 'durationUnit'}
          label={field.length ? label + ' unit' : 'Unit'} value={object['unit']} write={next => write(withField(object, 'unit', next))} />
      </fieldset>;
    }
    case 'color': return <ColorFields {...props} />;
    case 'colorComponents':
    case 'cubicBezier': {
      const values = Array.isArray(value) ? value : [];
      const labels = type === 'cubicBezier' ? ['X1', 'Y1', 'X2', 'Y2'] : props.componentLabels ?? ['Component 1', 'Component 2', 'Component 3'];
      return <>{action && <FieldHeading label={label} action={action} />}
        <FixedFields {...props} values={values} labels={labels} itemType={type === 'cubicBezier' ? 'number' : 'numberOrNone'} /></>;
    }
    case 'strokeStyle': {
      const pattern = isJsonObject(value);
      const object = objectValue(value);
      return <fieldset className="grid min-w-0 gap-space100">
        {(label !== 'Token value' || action) && <FieldHeading label={label} action={action} />}
        <StyledSelect label="Stroke format" value={pattern ? 'pattern' : 'keyword'}
          options={ [['keyword', 'Keyword'], ['pattern', 'Dash pattern']] } busy={edit.busy}
          change={mode => write(mode === 'pattern' ? { dashArray: defaultValue('dashArray'), lineCap: 'butt' } : 'solid')} />
        {pattern ? <>
          <TypedValue {...props} field={[...field, 'dashArray']} type="dashArray" label="Dash pattern"
            value={object['dashArray']} write={next => write(withField(object, 'dashArray', next))} />
          <TypedValue {...props} field={[...field, 'lineCap']} type="lineCap" label="Line cap"
            value={object['lineCap']} write={next => write(withField(object, 'lineCap', next))} />
        </> : <StyledSelect label="Stroke keyword" value={displayField(value)} options={choices(strokeKeywords)} busy={edit.busy} change={write} />}
      </fieldset>;
    }
    case 'shadow': {
      const layer = Array.isArray(value);
      return <div className="grid gap-space100">
        {layer ? <>
          {action && <FieldHeading label={label} action={action} />}
          <ArrayFields {...props} values={value} itemType="shadowLayer" itemLabel="Shadow layer" min={1} />
          {value.length === 1 && !referenceLabel(value[0]) && <Button type="button" size="xsmall" variant="text" className="justify-self-start"
            disabled={edit.busy} onClick={() => write(value[0])}>Use single shadow</Button>}
        </> : <>
          <ObjectFields {...props} label="Shadow" members={shadowFields} />
          <Button type="button" size="xsmall" variant="text" className="justify-self-start" disabled={edit.busy}
            onClick={() => write([value ?? defaultValue('shadowLayer'), defaultValue('shadowLayer')])}>
            <Plus aria-hidden="true" /> Add shadow layer
          </Button>
        </>}
      </div>;
    }
    case 'gradient':
    case 'dashArray':
      return <>{action && <FieldHeading label={label} action={action} />}<ArrayFields {...props} values={Array.isArray(value) ? value : []}
        itemType={type === 'gradient' ? 'gradientStop' : 'dimension'}
        itemLabel={type === 'gradient' ? 'Gradient stop' : 'Dash length'} min={type === 'gradient' ? 1 : 0} /></>;
    default: {
      const members = Object.hasOwn(compositeFields, type) ? compositeFields[type] : undefined;
      return members ? <ObjectFields {...props} members={members} /> : null;
    }
  }
}

function FieldHeading({ label, action }: { label: string; action?: ReactNode }) {
  return <div className="token-editor-label flex min-w-0 items-center justify-between gap-space100">{label}{action}</div>;
}

function ObjectFields(props: FieldProps & { action?: ReactNode; members: readonly (readonly [string, string, string])[] }) {
  const { field, label, value, write, members } = props;
  const object = objectValue(value);
  return <fieldset className="grid min-w-0 gap-space100" aria-label={label}>
    {(!props.hideLegend && label !== 'Token value' || props.action) && <FieldHeading label={label} action={props.action} />}
    {members.map(([key, name, type]) => <TypedValue key={key} {...props} field={[...field, key]} label={name} type={type} hideLegend={false} value={object[key]}
      write={next => write(withField(object, key, next))} />)}
  </fieldset>;
}

function ColorComponent(props: FieldProps & { opacity?: boolean }) {
  const { edit, label, value, write, opacity } = props;
  const omitted = opacity ? undefined : 'none';
  const included = value !== omitted;
  const [previous, setPrevious] = useState<JsonValue>();
  return <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start">
    <Checkbox aria-label={opacity ? 'Include opacity' : 'Include ' + label.toLowerCase() + ' channel'} checked={included} disabled={edit.busy}
      onChange={event => {
        if (event.target.checked) {
          write(previous ?? (opacity ? 1 : 0));
        } else {
          setPrevious(value);
          write(omitted);
        }
      }} />
    {included ? <TypedValue {...props} /> : <TextField label={label} placeholder="No value" value={opacity ? '1' : ''} disabled />}
  </div>;
}

function FixedFields({ values, labels, itemType, ...props }: FieldProps & {
  values: readonly JsonValue[]; labels: readonly string[]; itemType: string;
}) {
  const Field = itemType === 'numberOrNone' ? ColorComponent : TypedValue;
  return <FieldRow>
    {labels.map((label, index) => <Field key={label} {...props} field={[...props.field, String(index)]}
      label={label} type={itemType} value={values[index]} write={next => {
        const parts = values.slice();
        while (parts.length < index) parts.push(null);
        if (next !== undefined) parts[index] = next;
        props.write(parts);
      }} />)}
  </FieldRow>;
}

function ArrayFields({ values, itemType, itemLabel, min, ...props }: FieldProps & {
  values: JsonValue[]; itemType: string; itemLabel: string; min: number;
}) {
  const serial = useRef(values.length);
  const [keys, setKeys] = useState(() => values.map((_, index) => index));
  const [expanded, setExpanded] = useState<number>();
  const idPrefix = useId();
  const compact = itemType === 'shadowLayer' || itemType === 'gradientStop';
  const { field, edit, write } = props;
  function move(index: number, next: number) {
    const updated = values.slice();
    const ids = keys.slice();
    const [item] = updated.splice(index, 1);
    const [id] = ids.splice(index, 1);
    if (item === undefined || id === undefined) return;
    updated.splice(next, 0, item);
    ids.splice(next, 0, id);
    setKeys(ids);
    write(updated);
  }
  return <div className="grid min-w-0 gap-space100">
    {values.map((item, index) => {
      const label = itemLabel + ' ' + (index + 1);
      const id = keys[index];
      const bodyId = idPrefix + '-' + id;
      const showing = !compact || id === expanded;
      return <section key={id} aria-label={label} className="grid min-w-0 gap-space50 rounded-lg border pad-space100">
        <div className="flex min-w-0 items-center justify-between gap-space50">
          {compact ? <Button type="button" variant="text" size="xsmall" aria-expanded={showing} aria-controls={bodyId}
            onClick={() => setExpanded(showing ? undefined : id)}>
            <ChevronDown aria-hidden="true" className={showing ? 'rotate-180' : undefined} /> {label}
          </Button> : <span className="copy-small copy-emphasis">{label}</span>}
          <div className="flex">
            <IconButton type="button" size="xsmall" label={'Move ' + label + ' up'} disabled={edit.busy || !index}
              onClick={() => move(index, index - 1)}><ArrowUp aria-hidden="true" /></IconButton>
            <IconButton type="button" size="xsmall" label={'Move ' + label + ' down'} disabled={edit.busy || index === values.length - 1}
              onClick={() => move(index, index + 1)}><ArrowDown aria-hidden="true" /></IconButton>
            <IconButton type="button" size="xsmall" label={'Remove ' + label} disabled={edit.busy || values.length <= min}
              onClick={() => { setKeys(keys.filter((_, keyIndex) => keyIndex !== index)); write(values.filter((_, itemIndex) => itemIndex !== index)); }}>
              <Trash2 aria-hidden="true" />
            </IconButton>
          </div>
        </div>
        <div id={bodyId} hidden={!showing}>
          {showing && <TypedValue {...props} field={[...field, String(index)]} label={label} type={itemType} value={item} hideLegend={compact}
            write={next => { if (next !== undefined) write(values.map((current, itemIndex) => index === itemIndex ? next : current)); }} />}
        </div>
      </section>;
    })}
    <Button type="button" size="xsmall" variant="text" className="justify-self-start" disabled={edit.busy}
      onClick={() => {
        const id = serial.current++;
        setKeys([...keys, id]);
        if (compact) setExpanded(id);
        write([...values, defaultValue(itemType)]);
      }}>
      <Plus aria-hidden="true" /> Add {itemLabel.toLowerCase()}
    </Button>
  </div>;
}

function ColorFields(props: FieldProps & { action?: ReactNode }) {
  const { edit, field, value, write } = props;
  const object = objectValue(value);
  const authoredSpace = object['colorSpace'];
  const spaceReference = referenceLabel(authoredSpace);
  const actualSpace = spaceReference ? solutionForLink(edit, spaceReference, [...field, 'colorSpace']) : authoredSpace;
  const name = typeof actualSpace === 'string' ? actualSpace : undefined;
  const channels = object['components'];
  const space = colorSpace(name);
  const labels = space?.components ?? ['Component 1', 'Component 2', 'Component 3'];
  const channelRanges = name !== 'srgb' && space ? space.ranges.flatMap(([min, max], index) => {
    const label = labels[index];
    if (!Number.isFinite(min)) return [];
    if (!Number.isFinite(max)) return [label + ' ≥ ' + min];
    return [label + ' ' + min + '–' + max + (label === 'Hue' ? '°' : max === 100 ? '%' : '')];
  }) : [];
  const alpha = object['alpha'];
  const fallback = object['hex'];
  const srgb = name === 'srgb';
  const editableHex = srgb && isColor(value);
  const swatch = srgb ? displayColor(fieldValue(edit.preview, field) ?? value) : undefined;
  const [hexDraft, setHexDraft] = useState<{ before: string; text: string }>();
  const [conversion, setConversion] = useState<{ space: JsonValue | undefined; components: JsonValue | undefined }>();
  const [spaceWarning, setSpaceWarning] = useState('');
  const hex = editableHex ? colorHex(value) : '';
  const hexText = hexDraft && (hexDraft.before === hex || hexDraft.text.toUpperCase() === hex) ? hexDraft.text : hex;
  function changeSpace(next: JsonValue | undefined) {
    const link = referenceLabel(next);
    const target = link ? solutionForLink(edit, link, [...field, 'colorSpace']) : next;
    if (target === name) {
      write(withField(object, 'colorSpace', next));
      return;
    }
    if (referenceLabel(channels) || Array.isArray(channels) && channels.some(component => referenceLabel(component))) {
      setSpaceWarning('Use literal components before converting to a different color space.');
      return;
    }
    const converted = typeof target === 'string' ? convertColor({ ...object, colorSpace: actualSpace, alpha: 1 }, target) : undefined;
    if (!converted) {
      setSpaceWarning('Repair the color space and components before converting.');
      return;
    }
    setConversion({ space: authoredSpace, components: channels });
    setSpaceWarning(converted.clipped ? 'Conversion clipped colors outside the new space.' : '');
    write({ ...withField(object, 'colorSpace', next), components: converted.components });
  }

  return <fieldset className="grid min-w-0 gap-space100">
    {(props.label !== 'Token value' || props.action) && <FieldHeading label={props.label} action={props.action} />}
    <TypedValue {...props} field={[...field, 'colorSpace']} label="Color space" type="colorSpace" value={object['colorSpace']}
      write={changeSpace} />
    {spaceWarning && <output className="copy-small tone-supporting">{spaceWarning}</output>}
    {conversion && <Button type="button" size="xsmall" variant="text" className="justify-self-start" disabled={edit.busy}
      onClick={() => {
        write(withField(withField(object, 'colorSpace', conversion.space), 'components', conversion.components));
        setConversion(undefined);
        setSpaceWarning('');
      }}>Undo color-space conversion</Button>}
    {srgb && <TextField label="sRGB hex"
      trailing={<span aria-label="Color preview" className="grid swatch-md overflow-hidden rounded-sm border">
        <span style={{ backgroundColor: swatch?.css }} />
      </span>} aria-label={field.length ? props.label + ' sRGB hex' : 'Token value'} value={editableHex ? hexText : '—'}
      disabled={edit.busy || !editableHex} data-primary-editor ref={input => input?.setCustomValidity(!editableHex || /^#[0-9a-f]{6}$/iu.test(hexText) ? '' :
        'Enter six hex digits, such as #336699.')} onChange={event => {
        const text = event.target.value;
        setHexDraft({ before: hex, text });
        if (!/^#[0-9a-f]{6}$/iu.test(text)) return;
        const components = Array.from({ length: 3 }, (_, index) => parseInt(text.slice(1 + index * 2, 3 + index * 2), 16) / 255);
        write(withField(object, 'components', components));
      }} />}
    <TypedValue key={name} {...props} field={[...field, 'components']} label="Color channels" type="colorComponents" componentLabels={labels}
      value={channels} write={next => write(withField(object, 'components', next))} />

    {Array.isArray(channels) && channelRanges.length > 0 &&
      <div className="token-editor-support">{channelRanges.join(' · ')}</div>}
    <ColorComponent {...props} opacity field={[...field, 'alpha']} label="Opacity" type="number" value={alpha}
      write={next => write(withField(object, 'alpha', next))} />
    {!srgb && (fallback === undefined ? <Button type="button" size="xsmall" variant="text" className="justify-self-start"
      disabled={edit.busy} onClick={() => write(withField(object, 'hex', '#000000'))}>Add sRGB fallback</Button> :
      <div className="grid min-w-0 gap-space50">
        <TypedValue {...props} field={[...field, 'hex']} label="sRGB fallback" type="hex" value={fallback}
          write={next => write(withField(object, 'hex', next))} />
        <Button type="button" size="xsmall" variant="text" className="justify-self-start" disabled={edit.busy}
          onClick={() => write(withField(object, 'hex', undefined))}>Remove sRGB fallback</Button>
      </div>)}
  </fieldset>;
}

export default function TypedEditorPanel({ type, value, edit, original, resolved, write }: {
  type: string;
  value: JsonValue | undefined;
  edit: EditContext;
  original: boolean;
  resolved: JsonValue | undefined;
  write: FieldProps['write'];
}) {
  const preview = original ? resolved : previewFields(value, edit);
  const space = objectValue(preview)['colorSpace'] ?? objectValue(value)['colorSpace'];
  const showPreview = previewTypes.has(type) && (type !== 'color' || space !== 'srgb');
  return <>
    {showPreview && <ValuePreview type={type} value={preview} />}
    <TypedValue edit={{ ...edit, preview }} {...{ type, value, write }} field={[]} label="Token value" />
  </>;
}


export function BulkValueInput({ graph, file, paths, field, type, label, value, write }: {
  graph: DocumentGraph; file: string; paths: readonly string[]; field: readonly string[]; type: string; label: string;
  value: JsonValue | undefined; write: FieldProps['write'];
}) {
  return <TypedValue key={type + JSON.stringify(field)} edit={{ graph, file, source: '', sources: paths, busy: false }}
    {...{ field, type, label, value, write }} />;
}
