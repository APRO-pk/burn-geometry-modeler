import { useId } from 'react';

/**
 * Stable, unique DOM ids for label/control pairs within one component instance.
 *
 * The app's forms lay label and control out as SIBLINGS in a flex or grid row,
 * so the usual fix of nesting the control inside its `<label>` would break the
 * layout everywhere. That leaves `htmlFor`/`id`, which needs an id that is
 * unique across the whole document -- including when a component is rendered
 * more than once.
 *
 * `useId` gives a per-instance prefix, so two instances of the same editor
 * cannot collide.
 *
 *   const fieldId = useFieldIds();
 *   <label htmlFor={fieldId('length')}>Length</label>
 *   <input id={fieldId('length')} ... />
 *
 * Without this, a screen reader announces an unlabelled text box, and clicking
 * the visible label does not focus the field it names.
 */
export function useFieldIds(): (name: string) => string {
  const prefix = useId();
  return (name: string) => `${prefix}-${name}`;
}
